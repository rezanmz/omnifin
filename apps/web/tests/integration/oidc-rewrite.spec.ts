import { expect, test, type APIResponse } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";

const providerId = "synthetic-oidc";
const providerIssuer = "https://identity.example.test/application/o/omnifin/";
const providerObject = {
  displayName: "Synthetic identity",
  id: providerId,
  issuer: providerIssuer,
  jitProvisioningEnabled: true,
  kind: "oidc",
  state: "unavailable",
  supportsBackChannelLogout: false,
  supportsFrontChannelLogout: false,
  supportsRpInitiatedLogout: false,
};

function headerValues(response: APIResponse, name: string) {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => header.value);
}

function setCookieName(cookie: string) {
  const separator = cookie.indexOf("=");
  if (separator < 1) throw new Error("Expected a named Set-Cookie header.");
  return cookie.slice(0, separator);
}

function setCookieValue(cookie: string) {
  const separator = cookie.indexOf("=");
  const terminator = cookie.indexOf(";", separator + 1);
  if (separator < 1) throw new Error("Expected a named Set-Cookie header.");
  return cookie.slice(separator + 1, terminator < 0 ? undefined : terminator);
}

function expectNoStore(response: APIResponse) {
  expect(response.headers()["cache-control"]).toBe("no-store");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForRuntime(origin: string, process: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`The production web canary exited with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The production runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The production web canary did not become ready.");
}

async function stopRuntime(process: ChildProcess) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    once(process, "exit"),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (process.exitCode === null) process.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    }),
  ]);
}

test("retains only the address selected through the explicit trusted-edge model", async ({
  request,
}) => {
  const spoofedAddresses = ["192.0.2.44", "198.51.100.77"];
  const edgeObservedAddress = "203.0.113.21";
  const response = await request.get("/api/auth/proxy-canary/forwarding", {
    headers: {
      "cf-connecting-ip": spoofedAddresses[0]!,
      "cf-pseudo-ipv4": spoofedAddresses[0]!,
      "client-ip": spoofedAddresses[0]!,
      "fastly-client-ip": spoofedAddresses[0]!,
      "fly-client-ip": spoofedAddresses[0]!,
      forwarded: `for=${spoofedAddresses[0]};proto=https;host=attacker.example`,
      "true-client-ip": spoofedAddresses[0]!,
      via: "1.1 attacker.example",
      "x-appengine-user-ip": spoofedAddresses[0]!,
      "x-client-ip": spoofedAddresses[0]!,
      "x-cluster-client-ip": spoofedAddresses[0]!,
      "x-envoy-external-address": spoofedAddresses[0]!,
      "x-forwarded-client-cert": "By=attacker.example;Hash=private-canary",
      "x-forwarded-for": [...spoofedAddresses, edgeObservedAddress].join(", "),
      "x-forwarded-host": "attacker.example",
      "x-forwarded-port": "443",
      "x-forwarded-proto": "https",
      "x-original-forwarded-for": spoofedAddresses[1]!,
      "x-proxyuser-ip": spoofedAddresses[1]!,
      "x-real-ip": spoofedAddresses[1]!,
      "x-request-id": "attacker-selected-correlation",
    },
  });

  expect(response.status()).toBe(200);
  const observation = (await response.json()) as {
    forwardingHeaders: Record<string, string>;
    ip: string;
    requestId: string;
  };
  expect(observation.forwardingHeaders).toEqual({
    "x-forwarded-for": edgeObservedAddress,
  });
  expect(observation.ip).toBe(edgeObservedAddress);
  expect(observation.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(observation.requestId).not.toBe("attacker-selected-correlation");
  expect(JSON.stringify(observation)).not.toContain("attacker.example");
  expect(JSON.stringify(observation)).not.toContain("private-canary");
});

test("keeps private gateway limit buckets isolated across edge clients", async ({ request }) => {
  const canaryPath = "/api/auth/proxy-canary/client-limit";
  const fromClient = (address: string) =>
    request.get(canaryPath, { headers: { "x-forwarded-for": address } });

  const firstClient = await fromClient("192.0.2.101");
  expect(firstClient.status()).toBe(200);
  await expect(firstClient.json()).resolves.toEqual({ client: "192.0.2.101", limited: false });

  const limitedClient = await fromClient("192.0.2.101");
  expect(limitedClient.status()).toBe(429);

  const independentClient = await fromClient("198.51.100.202");
  expect(independentClient.status()).toBe(200);
  await expect(independentClient.json()).resolves.toEqual({
    client: "198.51.100.202",
    limited: false,
  });
});

test("streams gateway responses before the upstream body completes", async ({ request }) => {
  const streamedBody = await new Promise<string>((resolve, reject) => {
    let body = "";
    let releaseRequested = false;
    const fail = (error: Error) => {
      clearTimeout(timeout);
      streamRequest.destroy();
      reject(error);
    };
    const streamRequest = httpGet(
      "http://127.0.0.1:3000/api/auth/proxy-canary/stream",
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (releaseRequested) return;
          releaseRequested = true;
          void request
            .post("/api/auth/proxy-canary/release-stream", {
              data: {},
              headers: { origin: "http://127.0.0.1:3000" },
            })
            .then((releaseResponse) => {
              expect(releaseResponse.status()).toBe(200);
            })
            .catch((error: unknown) =>
              fail(error instanceof Error ? error : new Error("The stream release failed.")),
            );
        });
        response.once("end", () => {
          clearTimeout(timeout);
          resolve(body);
        });
        response.once("error", fail);
      },
    );
    streamRequest.once("error", fail);
    const timeout = setTimeout(() => fail(new Error("The proxied stream stalled.")), 5_000);
  });

  expect(streamedBody).toBe("stream-open-stream-close");
});

test("preserves redirects and multiple cookies across the complete OIDC proxy flow", async ({
  request,
}) => {
  const initialProviders = await request.get("/api/auth/providers", { maxRedirects: 0 });
  expect(initialProviders.status()).toBe(200);
  expectNoStore(initialProviders);
  expect(await initialProviders.json()).toEqual({
    providers: [
      {
        ...providerObject,
        state: expect.stringMatching(/^(?:available|unavailable)$/u),
      },
    ],
  });
  expect(await initialProviders.text()).not.toContain("omnifin-rewrite-client");

  const startPath = `/api/auth/oidc/${providerId}/start?returnPath=%2Fsettings`;
  const preflight = await request.get(startPath, { maxRedirects: 0 });
  expect(preflight.status()).toBe(303);
  expectNoStore(preflight);
  expect(preflight.headers().pragma).toBe("no-cache");
  expect(headerValues(preflight, "location")).toEqual([startPath]);
  const preflightCookies = headerValues(preflight, "set-cookie");
  expect(preflightCookies).toHaveLength(1);
  expect(preflightCookies[0]).toMatch(/^omnifin_local_oidc_binding=[A-Za-z0-9_-]{43};/);
  expect(preflightCookies[0]).toContain("HttpOnly");
  expect(preflightCookies[0]).toContain("Path=/");
  expect(preflightCookies[0]).toContain("SameSite=Lax");

  const browserBinding = setCookieValue(preflightCookies[0]!);
  await expect
    .poll(async () => (await request.storageState()).cookies)
    .toContainEqual(
      expect.objectContaining({ name: "omnifin_local_oidc_binding", value: browserBinding }),
    );

  const started = await request.get(startPath, { maxRedirects: 0 });
  expect(started.status()).toBe(302);
  expectNoStore(started);
  expect(started.headers().pragma).toBe("no-cache");
  const authorizationUrl = new URL(started.headers().location!);
  expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
    "https://identity.example.test/application/o/authorize/",
  );
  expect(authorizationUrl.searchParams.get("client_id")).toBe("omnifin-rewrite-client");
  expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
  expect(authorizationUrl.searchParams.get("response_mode")).toBe("query");
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
    `http://127.0.0.1:3000/api/auth/oidc/callback/${providerId}`,
  );
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const startCookies = headerValues(started, "set-cookie");
  expect(startCookies).toHaveLength(2);
  const stableCookie = startCookies.find(
    (cookie) => setCookieName(cookie) === "omnifin_local_oidc_binding",
  );
  const transactionCookie = startCookies.find((cookie) =>
    setCookieName(cookie).startsWith("omnifin_local_oidc_tx_"),
  );
  expect(stableCookie).toBeDefined();
  expect(transactionCookie).toBeDefined();
  expect(setCookieValue(stableCookie!)).toBe(browserBinding);
  expect(setCookieName(transactionCookie!)).toBe(`omnifin_local_oidc_tx_${state}`);
  expect(setCookieValue(transactionCookie!)).toBe(browserBinding);
  for (const cookie of startCookies) {
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  }

  const readyProviders = await request.get("/api/auth/providers", { maxRedirects: 0 });
  expect(readyProviders.status()).toBe(200);
  expectNoStore(readyProviders);
  expect(await readyProviders.json()).toEqual({
    providers: [{ ...providerObject, state: "available", supportsBackChannelLogout: true }],
  });

  const callbackQuery = new URLSearchParams({
    code: "synthetic-authorization-code",
    iss: providerIssuer,
    provider_extension: "rewrite-preserved",
    session_state: "synthetic-provider-session",
    state: state!,
  });
  const callback = await request.get(
    `/api/auth/oidc/callback/${providerId}?${callbackQuery.toString()}`,
    { maxRedirects: 0 },
  );
  expect(callback.status()).toBe(303);
  expectNoStore(callback);
  expect(callback.headers().pragma).toBe("no-cache");
  expect(headerValues(callback, "location")).toEqual(["/link/jellyfin"]);

  const callbackCookies = headerValues(callback, "set-cookie");
  expect(callbackCookies).toHaveLength(2);
  const transactionCookieName = setCookieName(transactionCookie!);
  const clearedTransaction = callbackCookies.find(
    (cookie) => setCookieName(cookie) === transactionCookieName,
  );
  const sessionCookie = callbackCookies.find(
    (cookie) => setCookieName(cookie) === "omnifin_local_session",
  );
  expect(clearedTransaction).toMatch(new RegExp(`^${transactionCookieName}=;`));
  expect(clearedTransaction).toContain("HttpOnly");
  expect(clearedTransaction).toContain("Path=/");
  expect(clearedTransaction).toContain("SameSite=Lax");
  expect(sessionCookie).toMatch(/^omnifin_local_session=[A-Za-z0-9_-]{43};/);
  expect(sessionCookie).toContain("HttpOnly");
  expect(sessionCookie).toContain("Path=/");
  expect(sessionCookie).toContain("SameSite=Lax");
  expect(callbackCookies.join("\n")).not.toContain("omnifin_local_oidc_binding=;");

  const finalCookies = (await request.storageState()).cookies;
  expect(finalCookies).toContainEqual(
    expect.objectContaining({ name: "omnifin_local_oidc_binding", value: browserBinding }),
  );
  expect(finalCookies.some((cookie) => cookie.name === transactionCookieName)).toBe(false);
  expect(finalCookies).toContainEqual(
    expect.objectContaining({
      name: "omnifin_local_session",
      value: setCookieValue(sessionCookie!),
    }),
  );

  const session = await request.get("/api/auth/session", { maxRedirects: 0 });
  expect(session.status()).toBe(200);
  expectNoStore(session);
  await expect(session.json()).resolves.toMatchObject({
    csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    principal: {
      accountState: "pending_link",
      authenticationMethod: { kind: "oidc", providerId },
      externalIdentity: {
        issuer: providerIssuer,
        providerId,
        subject: "synthetic-immutable-subject",
      },
      role: "viewer",
    },
  });

  const providerLogout = await request.post(`/api/auth/oidc/backchannel/${providerId}`, {
    data: new URLSearchParams({
      logout_token: "header.synthetic-provider-logout.signature",
      provider_extension: "ignored-by-specification",
    }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(providerLogout.status()).toBe(200);
  expectNoStore(providerLogout);
  expect(providerLogout.headers().pragma).toBe("no-cache");
  expect(await providerLogout.text()).toBe("");

  const revokedSession = await request.get("/api/auth/session", { maxRedirects: 0 });
  expect(revokedSession.status()).toBe(200);
  expectNoStore(revokedSession);
  await expect(revokedSession.json()).resolves.toEqual({ csrfToken: null, principal: null });
});

test("returns a bounded callback outage response without logging query secrets", async () => {
  test.setTimeout(60_000);
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const webRoot = process.cwd();
  const runtime = spawn("pnpm", ["start"], {
    cwd: webRoot,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      OMNIFIN_GATEWAY_URL: "http://127.0.0.1:4000",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runtimeLogs = "";
  const capture = (chunk: Buffer) => {
    runtimeLogs = `${runtimeLogs}${chunk.toString("utf8")}`.slice(-128 * 1_024);
  };
  runtime.stdout.on("data", capture);
  runtime.stderr.on("data", capture);

  const secrets = {
    code: "private-authorization-code-canary",
    error_description: "private provider diagnostic canary",
    state: "private-state-canary",
  };
  const query = new URLSearchParams(secrets);

  try {
    await waitForRuntime(origin, runtime);
    const response = await fetch(
      `${origin}/api/auth/oidc/callback/upstream-outage-canary?${query.toString()}`,
      { redirect: "manual", signal: AbortSignal.timeout(10_000) },
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(512);
    const payload = JSON.parse(body) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(payload).toMatchObject({
      error: {
        code: "service_unavailable",
        message: "The gateway is unavailable.",
        requestId: expect.any(String),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runtimeLogs).toContain(
      JSON.stringify({
        event: "gateway_proxy_unavailable",
        requestId: payload.error.requestId,
      }),
    );
    expect(runtimeLogs).not.toContain("/api/auth/oidc/callback/upstream-outage-canary");
    for (const secret of Object.values(secrets)) {
      expect(body).not.toContain(secret);
      expect(runtimeLogs).not.toContain(secret);
      expect(runtimeLogs).not.toContain(encodeURIComponent(secret));
      expect(runtimeLogs).not.toContain(
        new URLSearchParams({ value: secret }).toString().slice("value=".length),
      );
    }
  } finally {
    await stopRuntime(runtime);
  }
});
