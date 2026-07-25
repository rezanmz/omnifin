const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 20_000;
const VERSION_PATTERN =
  /^[vV]?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,4}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const CREDENTIAL_VARIABLE_PATTERN =
  /^OMNIFIN_[A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN|USERNAME)$/u;
const VERSION_DELIMITERS = new Set([".", "+", "-"]);
const MIN_UNBOUNDED_SECRET_LENGTH = 8;
const MIN_BOUNDED_SECRET_LENGTH = 4;

class ProbeError extends Error {
  constructor(category) {
    super(category);
    this.name = "ProbeError";
    this.category = category;
  }
}

function requiredConfiguration(environment, names) {
  const values = Object.fromEntries(names.map((name) => [name, environment[name]?.trim()]));
  if (Object.values(values).some((value) => !value)) return null;
  return values;
}

function optionalHeader(name, value) {
  return value?.trim() ? { [name]: value.trim() } : {};
}

export function endpoint(baseUrl, path, environment = {}) {
  try {
    const base = new URL(baseUrl);
    const allowHttp = environment.OMNIFIN_INTEGRATION_ALLOW_HTTP === "true";
    if (base.protocol !== "https:" && !(allowHttp && base.protocol === "http:")) {
      throw new Error();
    }
    if (base.username || base.password || base.search || base.hash) throw new Error();
    return new URL(path.replace(/^\//u, ""), base.href.endsWith("/") ? base : `${base.href}/`);
  } catch {
    throw new ProbeError("configuration_invalid");
  }
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return "invalid_credentials";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

async function readBody(response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new ProbeError("response_invalid");

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProbeError("response_invalid");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function request(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProbeError("timeout");
    }
    throw new ProbeError("unreachable");
  }

  if (!response.ok) throw new ProbeError(classifyHttpStatus(response.status));
  try {
    return { response, body: await readBody(response) };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProbeError("timeout");
    }
    throw new ProbeError("response_invalid");
  }
}

async function requestJson(url, init) {
  const { response, body } = await request(url, init);
  try {
    return { response, value: JSON.parse(body) };
  } catch {
    throw new ProbeError("response_invalid");
  }
}

function isDelimited(value, index) {
  return index < 0 || index >= value.length || VERSION_DELIMITERS.has(value[index] ?? "");
}

function containsProtectedValue(candidate, protectedValue) {
  if (candidate === protectedValue) return true;
  if (/^[vV]/u.test(candidate) && candidate.slice(1) === protectedValue) return true;

  let matchAt = candidate.indexOf(protectedValue);
  while (matchAt !== -1) {
    if (protectedValue.length >= MIN_UNBOUNDED_SECRET_LENGTH) return true;

    const matchEnd = matchAt + protectedValue.length;
    const isBoundedCredentialToken =
      protectedValue.length >= MIN_BOUNDED_SECRET_LENGTH &&
      /[A-Za-z]/u.test(protectedValue) &&
      isDelimited(candidate, matchAt - 1) &&
      isDelimited(candidate, matchEnd);
    if (isBoundedCredentialToken) return true;

    matchAt = candidate.indexOf(protectedValue, matchAt + 1);
  }
  return false;
}

export function normalizeVersion(value, environment = {}, additionalCredentials = []) {
  if (typeof value !== "string") throw new ProbeError("response_invalid");
  const candidate = value.trim();
  if (!candidate || candidate.length > 128 || !VERSION_PATTERN.test(candidate)) {
    throw new ProbeError("response_invalid");
  }
  const credentials = [
    ...Object.entries(environment)
      .filter(([name, configured]) => CREDENTIAL_VARIABLE_PATTERN.test(name) && configured)
      .map(([, configured]) => String(configured).trim()),
    ...additionalCredentials
      .filter((configured) => typeof configured === "string" && configured.trim())
      .map((configured) => configured.trim()),
  ];
  if (credentials.some((credential) => containsProtectedValue(candidate, credential))) {
    throw new ProbeError("response_invalid");
  }
  return candidate;
}

function versionFrom(value, path, environment) {
  let candidate = value;
  for (const part of path) candidate = candidate?.[part];
  return normalizeVersion(candidate, environment);
}

async function probeJellyfin(environment) {
  const config = requiredConfiguration(environment, ["OMNIFIN_JELLYFIN_URL"]);
  if (!config) return null;
  const { value } = await requestJson(
    endpoint(config.OMNIFIN_JELLYFIN_URL, "System/Info/Public", environment),
  );
  return {
    version: versionFrom(value, ["Version"], environment),
    checks: ["version_discovery"],
  };
}

async function probeSeerr(environment) {
  const config = requiredConfiguration(environment, ["OMNIFIN_SEERR_URL"]);
  if (!config) return null;
  const { value } = await requestJson(
    endpoint(config.OMNIFIN_SEERR_URL, "api/v1/status", environment),
    {
      headers: optionalHeader("X-Api-Key", environment.OMNIFIN_SEERR_API_KEY),
    },
  );
  return {
    version: versionFrom(value, ["version"], environment),
    checks: ["version_discovery"],
  };
}

async function probeServarr(service, environment, apiVersion) {
  const prefix = `OMNIFIN_${service.toUpperCase()}`;
  const config = requiredConfiguration(environment, [`${prefix}_URL`, `${prefix}_API_KEY`]);
  if (!config) return null;
  const { value } = await requestJson(
    endpoint(config[`${prefix}_URL`], `api/${apiVersion}/system/status`, environment),
    { headers: { "X-Api-Key": config[`${prefix}_API_KEY`] } },
  );
  return {
    version: versionFrom(value, ["version"], environment),
    checks: ["authentication", "version_discovery"],
  };
}

async function probeBazarr(environment) {
  const config = requiredConfiguration(environment, [
    "OMNIFIN_BAZARR_URL",
    "OMNIFIN_BAZARR_API_KEY",
  ]);
  if (!config) return null;
  const { value } = await requestJson(
    endpoint(config.OMNIFIN_BAZARR_URL, "api/system/status", environment),
    {
      headers: { "X-API-KEY": config.OMNIFIN_BAZARR_API_KEY },
    },
  );
  return {
    version: versionFrom(value, ["data", "bazarr_version"], environment),
    checks: ["authentication", "version_discovery"],
  };
}

async function probeSabnzbd(environment) {
  const config = requiredConfiguration(environment, [
    "OMNIFIN_SABNZBD_URL",
    "OMNIFIN_SABNZBD_API_KEY",
  ]);
  if (!config) return null;
  const url = endpoint(config.OMNIFIN_SABNZBD_URL, "api", environment);
  url.search = new URLSearchParams({
    mode: "version",
    output: "json",
    apikey: config.OMNIFIN_SABNZBD_API_KEY,
  }).toString();
  const { value } = await requestJson(url);
  return {
    version: versionFrom(value, ["version"], environment),
    checks: ["authentication", "version_discovery"],
  };
}

async function probeQBittorrent(environment) {
  const config = requiredConfiguration(environment, [
    "OMNIFIN_QBITTORRENT_URL",
    "OMNIFIN_QBITTORRENT_USERNAME",
    "OMNIFIN_QBITTORRENT_PASSWORD",
  ]);
  if (!config) return null;

  const baseUrl = endpoint(config.OMNIFIN_QBITTORRENT_URL, "/", environment);
  const form = new URLSearchParams({
    username: config.OMNIFIN_QBITTORRENT_USERNAME,
    password: config.OMNIFIN_QBITTORRENT_PASSWORD,
  });
  const login = await request(endpoint(baseUrl, "api/v2/auth/login", environment), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: baseUrl.origin,
      referer: `${baseUrl.origin}/`,
    },
    body: form,
  });
  const sessionId = login.response.headers.get("set-cookie")?.match(/(?:^|;\s*)SID=([^;]+)/iu)?.[1];
  if (login.body.trim() !== "Ok." || !sessionId) throw new ProbeError("invalid_credentials");

  const versionResponse = await request(endpoint(baseUrl, "api/v2/app/version", environment), {
    headers: { cookie: `SID=${sessionId}` },
  });
  const version = normalizeVersion(versionResponse.body, environment, [sessionId]);
  return { version, checks: ["authentication", "version_discovery"] };
}

function validateUrlClaim(value, allowHttp) {
  if (typeof value !== "string") throw new ProbeError("response_invalid");
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error();
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
      throw new Error();
    }
  } catch {
    throw new ProbeError("response_invalid");
  }
}

async function probeOidcProvider(service, environment, requireLogout) {
  const variable =
    service === "authentik" ? "OMNIFIN_AUTHENTIK_ISSUER_URL" : "OMNIFIN_OIDC_ISSUER_URL";
  const config = requiredConfiguration(environment, [variable]);
  if (!config) return null;

  let issuer;
  const allowHttp = environment.OMNIFIN_INTEGRATION_ALLOW_HTTP === "true";
  try {
    issuer = new URL(config[variable]);
    if (issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error();
    if (issuer.protocol !== "https:" && !(allowHttp && issuer.protocol === "http:")) {
      throw new Error();
    }
  } catch {
    throw new ProbeError("configuration_invalid");
  }
  const discoveryUrl = new URL(
    `.well-known/openid-configuration`,
    issuer.href.endsWith("/") ? issuer : `${issuer.href}/`,
  );
  const { value: metadata } = await requestJson(discoveryUrl);
  if (metadata?.issuer !== config[variable]) throw new ProbeError("issuer_mismatch");

  for (const claim of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    validateUrlClaim(metadata?.[claim], allowHttp);
  }
  if (
    !Array.isArray(metadata?.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new ProbeError("pkce_s256_unsupported");
  }
  if (requireLogout) validateUrlClaim(metadata?.end_session_endpoint, allowHttp);

  return {
    checks: requireLogout
      ? ["discovery", "issuer_match", "pkce_s256", "logout_discovery"]
      : ["discovery", "issuer_match", "pkce_s256"],
  };
}

const probes = {
  oidc: (environment) => probeOidcProvider("oidc", environment, false),
  authentik: (environment) => probeOidcProvider("authentik", environment, true),
  jellyfin: probeJellyfin,
  seerr: probeSeerr,
  radarr: (environment) => probeServarr("radarr", environment, "v3"),
  sonarr: (environment) => probeServarr("sonarr", environment, "v3"),
  prowlarr: (environment) => probeServarr("prowlarr", environment, "v1"),
  bazarr: probeBazarr,
  qbittorrent: probeQBittorrent,
  sabnzbd: probeSabnzbd,
};

export async function runLiveProbe(service, environment = process.env) {
  const probe = probes[service];
  if (!probe) return { service, profile: "live-upstream", status: "not_implemented" };

  try {
    const result = await probe(environment);
    if (!result) return { service, profile: "live-upstream", status: "not_configured" };
    return {
      service,
      profile: "live-upstream",
      status: "passed",
      ...(result.version ? { version: result.version } : {}),
      checks: result.checks,
    };
  } catch (error) {
    return {
      service,
      profile: "live-upstream",
      status: "failed",
      errorCategory: error instanceof ProbeError ? error.category : "runner_error",
    };
  }
}
