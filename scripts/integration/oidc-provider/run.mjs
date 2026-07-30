#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dotenv,
  failureReportFor,
  oidcProviderFixture,
  renderConfig,
  reportFor,
  secretLeakDetected,
  selectPrivateHost,
} from "./fixture.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const composeFile = join(root, "scripts/integration/oidc-provider/compose.yaml");
const configTemplateFile = join(root, "scripts/integration/oidc-provider/config.yaml.template");
const proxyScript = join(root, "scripts/integration/oidc-provider/tls-proxy.mjs");
const browserScript = join(root, "scripts/integration/oidc-provider/browser-check.mjs");
const MAX_CAPTURE_BYTES = 512 * 1_024;

class FixtureError extends Error {
  constructor(category) {
    super(category);
    this.name = "FixtureError";
    this.category = category;
  }
}

function parseArguments(arguments_) {
  const options = { output: null, skipBuild: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") options.output = arguments_[++index];
    else if (argument === "--skip-build") options.skipBuild = true;
    else throw new FixtureError("arguments_invalid");
  }
  if (!options.output) throw new FixtureError("arguments_invalid");
  return options;
}

function secureToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function appendBounded(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES);
}

function commandEnvironment(overrides = {}) {
  return {
    ...process.env,
    CI: "true",
    COMPOSE_ANSI: "never",
    FORCE_COLOR: "0",
    TURBO_TELEMETRY_DISABLED: "1",
    ...overrides,
  };
}

async function runCommand(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? root,
    env: commandEnvironment(options.env),
    stdio: options.visible ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  if (!options.visible) {
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
  }
  const [code] = await once(child, "close");
  if (spawnFailed || code !== 0) {
    const classified = options.classifyFailure?.({ stderr, stdout });
    throw new FixtureError(classified ?? options.failureCategory ?? "command_failed");
  }
  return { stderr, stdout };
}

function spawnRuntime(command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: root,
    env: commandEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = { child, spawnFailed: false, stderr: "", stdout: "" };
  child.once("error", () => {
    runtime.spawnFailed = true;
  });
  child.stdout.on("data", (chunk) => {
    runtime.stdout = appendBounded(runtime.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    runtime.stderr = appendBounded(runtime.stderr, chunk);
  });
  return runtime;
}

async function stopRuntime(runtime) {
  if (!runtime || runtime.spawnFailed || runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  await Promise.race([
    once(runtime.child, "exit"),
    new Promise((resolve) => {
      setTimeout(() => {
        if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    }),
  ]);
}

async function reservePort(host) {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new FixtureError("port_reservation_failed");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function writeFile(path, contents, mode) {
  writeFileSync(path, contents, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function reportPath(output) {
  if (isAbsolute(output)) throw new FixtureError("output_path_invalid");
  const outputPath = resolve(root, output);
  if (relative(root, outputPath).startsWith("..")) {
    throw new FixtureError("output_path_invalid");
  }
  return outputPath;
}

function clearReport(output) {
  rmSync(reportPath(output), { force: true });
}

function writeReport(output, report) {
  const outputPath = reportPath(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 0o600);
}

async function generateCertificate(directory, host) {
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.pem");
  const serverKey = join(directory, "server.key");
  const serverRequest = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.pem");
  const extensions = join(directory, "server-extensions.cnf");
  writeFile(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid:always,issuer:always",
      `subjectAltName=IP:${host}`,
      "",
    ].join("\n"),
    0o600,
  );
  await runCommand(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
      "-subj",
      "/CN=Omnifin generic OIDC fixture CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-addext",
      "authorityKeyIdentifier=keyid:always",
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  await runCommand(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
      "-subj",
      "/CN=Omnifin generic OIDC fixture",
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  await runCommand(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      serverCertificate,
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  await runCommand(
    "openssl",
    ["verify", "-x509_strict", "-CAfile", caCertificate, serverCertificate],
    { failureCategory: "certificate_generation_failed" },
  );
  chmodSync(caCertificate, 0o644);
  chmodSync(serverCertificate, 0o644);
  chmodSync(serverKey, 0o600);
  return { caCertificate, serverCertificate, serverKey };
}

function composeArguments(project, environmentFile, ...arguments_) {
  return [
    "compose",
    "--project-name",
    project,
    "--file",
    composeFile,
    "--env-file",
    environmentFile,
    ...arguments_,
  ];
}

function trustedJson(url, caCertificate) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        ca: readFileSync(caCertificate),
        headers: { accept: "application/json" },
        method: "GET",
        rejectUnauthorized: true,
        timeout: 10_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body = `${body}${chunk}`;
          if (Buffer.byteLength(body) > 1_048_576) request.destroy();
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new FixtureError("upstream_not_ready"));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new FixtureError("upstream_not_ready"));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => reject(new FixtureError("upstream_not_ready")));
    request.end();
  });
}

async function waitFor(label, probe, runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime?.spawnFailed || runtime?.child.exitCode !== null) {
      throw new FixtureError(`${label}_exited`);
    }
    try {
      if (await probe()) return;
    } catch {
      // The bounded isolated dependency is still converging.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new FixtureError(`${label}_timeout`);
}

async function waitForHttp(url, runtime) {
  await waitFor(
    "runtime",
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    },
    runtime,
    120_000,
  );
}

function browserFailureCategory(stderr) {
  const match = stderr.match(
    /"event":"oidc_provider_browser_checks_failed","stage":"([a-z_]+)"(?:,"check":"([a-z_]+)")?/u,
  );
  const allowedStages = new Set([
    "authorization_code_pkce",
    "configuration",
    "discovery_logout",
    "local_logout_fallback",
    "local_session_revocation",
    "mapped_cookie",
    "mapped_login",
    "mapped_login_approval",
    "mapped_login_callback",
    "mapped_login_connector",
    "mapped_login_navigation",
    "mapped_session",
    "mapping_recovery_session",
    "provider_create",
    "provider_enable",
    "provider_validate",
    "public_provider",
    "recovery_session",
    "remapped_cookie",
    "remapped_login",
    "remapped_login_approval",
    "remapped_login_callback",
    "remapped_login_connector",
    "remapped_login_navigation",
    "remapped_session",
    "role_mapping",
    "role_mapping_revocation",
    "role_mapping_update",
    "secret_leak_inspection",
    "state_nonce_validation",
    "viewer_login",
    "viewer_login_approval",
    "viewer_login_callback",
    "viewer_login_connector",
    "viewer_login_navigation",
    "viewer_cookie",
    "viewer_session",
  ]);
  if (!match || !allowedStages.has(match[1])) return "browser_flow_failed";

  const allowedChecks = new Set([
    "assertion",
    "principal_account_state",
    "principal_authentication_method",
    "principal_authentication_provider",
    "principal_available",
    "principal_display_name",
    "principal_email",
    "principal_email_verified",
    "principal_external_issuer",
    "principal_external_provider",
    "principal_external_subject",
    "principal_link_state",
    "principal_permissions",
    "principal_role",
    "principal_subject_continuity",
    "principal_user_continuity",
    "session_cookie_replacement",
  ]);
  return match[2] && allowedChecks.has(match[2])
    ? `browser_flow_failed_${match[1]}_${match[2]}`
    : `browser_flow_failed_${match[1]}`;
}

async function main(options) {
  clearReport(options.output);
  if (!options.skipBuild) {
    await runCommand("pnpm", ["build"], {
      failureCategory: "application_build_failed",
      visible: true,
    });
  }

  const fixtureDirectory = mkdtempSync(join(tmpdir(), "omnifin-oidc-provider-"));
  const environmentFile = join(fixtureDirectory, "fixture.env");
  const providerConfig = join(fixtureDirectory, "provider.yaml");
  const databaseFile = join(fixtureDirectory, "omnifin.db");
  const project = `omnifin-oidc-provider-${process.pid}`;
  const runtimes = [];
  let composeStarted = false;
  let completedReport;
  let fixtureFailure;

  try {
    const host = selectPrivateHost();
    const [webPort, gatewayPort, webTlsPort, providerHttpPort, providerTlsPort] = await Promise.all(
      [
        reservePort("127.0.0.1"),
        reservePort("127.0.0.1"),
        reservePort("0.0.0.0"),
        reservePort("127.0.0.1"),
        reservePort("0.0.0.0"),
      ],
    );
    const webOrigin = `https://${host}:${webTlsPort}`;
    const providerOrigin = `https://${host}:${providerTlsPort}`;
    const issuer = `${providerOrigin}/dex`;
    const certificates = await generateCertificate(fixtureDirectory, host);
    const secrets = {
      clientSecret: secureToken(36),
      encryptionKey: randomBytes(32).toString("base64"),
      recoverySecret: randomBytes(48).toString("base64"),
    };
    const clientId = `omnifin-${secureToken(12)}`;
    const renderedConfig = renderConfig(readFileSync(configTemplateFile, "utf8"), {
      CALLBACK_URL: `${webOrigin}/api/auth/oidc/callback/oidc-generic`,
      CLIENT_ID: clientId,
      CLIENT_SECRET: secrets.clientSecret,
      ISSUER: issuer,
    });
    writeFile(providerConfig, renderedConfig, 0o644);
    writeFile(
      environmentFile,
      dotenv({
        OMNIFIN_OIDC_PROVIDER_CONFIG: providerConfig,
        OMNIFIN_OIDC_PROVIDER_HTTP_PORT: String(providerHttpPort),
      }),
      0o600,
    );

    const proxy = spawnRuntime("node", [proxyScript], {
      OMNIFIN_FIXTURE_PROVIDER_TLS_PORT: String(providerTlsPort),
      OMNIFIN_FIXTURE_PROVIDER_UPSTREAM_PORT: String(providerHttpPort),
      OMNIFIN_FIXTURE_TLS_CERT: certificates.serverCertificate,
      OMNIFIN_FIXTURE_TLS_KEY: certificates.serverKey,
      OMNIFIN_FIXTURE_WEB_TLS_PORT: String(webTlsPort),
      OMNIFIN_FIXTURE_WEB_UPSTREAM_PORT: String(webPort),
    });
    runtimes.push(proxy);
    await waitFor(
      "tls_proxy",
      async () => proxy.stdout.includes("fixture_tls_ready"),
      proxy,
      30_000,
    );

    composeStarted = true;
    await runCommand(
      "docker",
      composeArguments(project, environmentFile, "up", "--detach", "--remove-orphans"),
      { failureCategory: "provider_start_failed" },
    );

    await waitFor(
      "provider",
      async () => {
        const discovery = await trustedJson(
          `${issuer}/.well-known/openid-configuration`,
          certificates.caCertificate,
        );
        return (
          discovery.issuer === issuer &&
          discovery.authorization_endpoint?.startsWith(`${issuer}/`) &&
          discovery.token_endpoint?.startsWith(`${issuer}/`) &&
          discovery.jwks_uri?.startsWith(`${issuer}/`) &&
          discovery.response_types_supported?.includes("code") &&
          discovery.grant_types_supported?.includes("authorization_code") &&
          discovery.code_challenge_methods_supported?.includes("S256") &&
          discovery.id_token_signing_alg_values_supported?.includes("RS256") &&
          discovery.scopes_supported?.includes("openid") &&
          discovery.end_session_endpoint === undefined &&
          discovery.backchannel_logout_supported !== true
        );
      },
      proxy,
      120_000,
    );

    const gateway = spawnRuntime("node", ["apps/gateway/dist/main.js"], {
      NODE_ENV: "production",
      NODE_EXTRA_CA_CERTS: certificates.caCertificate,
      OMNIFIN_BASE_URL: webOrigin,
      OMNIFIN_DATABASE_URL: databaseFile,
      OMNIFIN_ENCRYPTION_KEY: secrets.encryptionKey,
      OMNIFIN_HOST: "127.0.0.1",
      OMNIFIN_LOG_LEVEL: "info",
      OMNIFIN_PORT: String(gatewayPort),
      OMNIFIN_RECOVERY_SECRET: secrets.recoverySecret,
      OMNIFIN_SECURE_COOKIES: "true",
      OMNIFIN_TRUST_PROXY_HOPS: "1",
    });
    runtimes.push(gateway);
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/readyz`, gateway);

    const web = spawnRuntime(
      "pnpm",
      [
        "--filter",
        "@omnifin/web",
        "exec",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: webOrigin,
        OMNIFIN_DEMO_MODE: "false",
        OMNIFIN_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        OMNIFIN_TEST_MODE: "false",
        OMNIFIN_WEB_TRUST_PROXY_HOPS: "1",
        PORT: String(webPort),
      },
    );
    runtimes.push(web);
    await waitFor(
      "web",
      async () => {
        const health = await trustedJson(`${webOrigin}/healthz`, certificates.caCertificate);
        return health.status === "ok";
      },
      web,
      120_000,
    );

    const browser = await runCommand("node", [browserScript], {
      classifyFailure: ({ stderr }) => browserFailureCategory(stderr),
      env: {
        OMNIFIN_FIXTURE_CLIENT_ID: clientId,
        OMNIFIN_FIXTURE_CLIENT_SECRET: secrets.clientSecret,
        OMNIFIN_FIXTURE_OIDC_ISSUER: issuer,
        OMNIFIN_FIXTURE_RECOVERY_SECRET: secrets.recoverySecret,
        OMNIFIN_FIXTURE_WEB_ORIGIN: webOrigin,
      },
      failureCategory: "browser_flow_failed",
    });
    if (!browser.stdout.includes("oidc_provider_browser_checks_passed")) {
      throw new FixtureError("browser_flow_failed");
    }

    const providerLogs = await runCommand(
      "docker",
      composeArguments(project, environmentFile, "logs", "--no-color", "provider"),
      { failureCategory: "provider_log_inspection_failed" },
    );
    const runtimeLogs = runtimes.flatMap((runtime) => [runtime.stdout, runtime.stderr]);
    if (
      secretLeakDetected(
        [...runtimeLogs, providerLogs.stdout, providerLogs.stderr],
        Object.values(secrets),
      )
    ) {
      throw new FixtureError("secret_leak_detected");
    }

    completedReport = reportFor(oidcProviderFixture.checks);
  } catch (error) {
    fixtureFailure = error;
  }

  let teardownFailure;
  for (const runtime of [...runtimes].reverse()) {
    try {
      await stopRuntime(runtime);
    } catch {
      teardownFailure ??= new FixtureError("runtime_teardown_failed");
    }
  }
  if (composeStarted) {
    try {
      await runCommand(
        "docker",
        composeArguments(project, environmentFile, "down", "--volumes", "--remove-orphans"),
        { failureCategory: "provider_teardown_failed" },
      );
    } catch (error) {
      teardownFailure ??=
        error instanceof FixtureError ? error : new FixtureError("provider_teardown_failed");
    }
  }
  try {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  } catch {
    teardownFailure ??= new FixtureError("fixture_cleanup_failed");
  }

  if (teardownFailure) throw teardownFailure;
  if (fixtureFailure) throw fixtureFailure;
  if (!completedReport) throw new FixtureError("fixture_incomplete");
  writeReport(options.output, completedReport);
  process.stdout.write(`${JSON.stringify(completedReport)}\n`);
}

let parsedOptions;
try {
  parsedOptions = parseArguments(process.argv.slice(2));
  await main(parsedOptions);
} catch (error) {
  const category = error instanceof FixtureError ? error.category : "fixture_failed";
  if (parsedOptions) {
    try {
      writeReport(parsedOptions.output, failureReportFor(category));
    } catch {
      // Invalid output destinations fail closed without creating another artifact.
    }
  }
  process.stderr.write(`${JSON.stringify({ category, event: "oidc_provider_fixture_failed" })}\n`);
  process.exitCode = 1;
}
