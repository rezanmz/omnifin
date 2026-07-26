#!/usr/bin/env node

import { createRequire } from "node:module";

const requireFromWeb = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = requireFromWeb("@playwright/test");

const providerSlug = "authentik";
const expectedProviderId = `oidc-${providerSlug}`;
const INTERACTION_RETRY_ATTEMPTS = 4;

class BrowserCheckError extends Error {
  constructor() {
    super("authentik_browser_check_failed");
    this.name = "BrowserCheckError";
  }
}

let currentStage = "configuration";

function required(name) {
  const value = process.env[name];
  if (!value) throw new BrowserCheckError();
  return value;
}

function assert(condition) {
  if (!condition) throw new BrowserCheckError();
}

async function json(response, expectedStatus) {
  assert(response.status() === expectedStatus);
  try {
    return await response.json();
  } catch {
    throw new BrowserCheckError();
  }
}

async function mutate(request, webOrigin, path, csrfToken, data, method = "POST") {
  const response = await request.fetch(path, {
    data,
    headers: {
      origin: webOrigin,
      "x-omnifin-csrf": csrfToken,
    },
    method,
    maxRedirects: 0,
  });
  return json(response, method === "POST" ? 201 : 200);
}

async function validateProvider(request, path, webOrigin, csrfToken) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(path, {
      headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
      maxRedirects: 0,
    });
    if (response.status() === 200) return json(response, 200);
    if (response.status() !== 503 || attempt === 2) throw new BrowserCheckError();
    const retryAfterSeconds = Number(response.headers()["retry-after"]);
    assert(Number.isInteger(retryAfterSeconds));
    assert(retryAfterSeconds >= 1 && retryAfterSeconds <= 60);
    await new Promise((resolve) => setTimeout(resolve, (retryAfterSeconds + 6) * 1_000));
  }
  throw new BrowserCheckError();
}

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && (await locator.first().isVisible());
  } catch {
    return false;
  }
}

async function waitForInteraction(page, webOrigin, locators) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === webOrigin && current.pathname === "/link/jellyfin") return "callback";
    for (const locator of locators) {
      if (await visible(locator)) return "interaction";
    }
    await page.waitForTimeout(100);
  }
  return "unrecognized";
}

async function retryInteraction(page, action) {
  for (let attempt = 0; attempt < INTERACTION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch {
      if (attempt === INTERACTION_RETRY_ATTEMPTS - 1) throw new BrowserCheckError();
      await page.waitForTimeout(150);
    }
  }
  throw new BrowserCheckError();
}

async function fillStable(page, locator, value) {
  await retryInteraction(page, async () => {
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.fill(value, { timeout: 5_000 });
    assert((await locator.inputValue()) === value);
  });
}

async function completeAuthentikFlow(page, startPath, username, password, webOrigin, attempt) {
  currentStage = `${attempt}_navigation`;
  await page.goto(startPath, { waitUntil: "domcontentloaded" });

  for (let step = 0; step < 12; step += 1) {
    if (
      new URL(page.url()).origin === webOrigin &&
      new URL(page.url()).pathname === "/link/jellyfin"
    ) {
      return;
    }

    const usernameInput = page
      .locator(
        'input[name="uidField"], input[name="username"], input[autocomplete="username"], input[type="email"]',
      )
      .first();
    const passwordInput = page
      .locator(
        'input[name="password"], input[autocomplete="current-password"], input[type="password"]',
      )
      .first();
    const namedAction = page
      .getByRole("button", {
        name: /^(?:allow|authorize|continue|log in|sign in|submit)$/iu,
      })
      .first();
    const submitAction = page.locator('button[type="submit"], input[type="submit"]').last();
    const readiness = await waitForInteraction(page, webOrigin, [
      usernameInput,
      passwordInput,
      namedAction,
      submitAction,
    ]);
    if (readiness === "callback") return;
    if (readiness === "unrecognized") {
      currentStage = `${attempt}_unrecognized`;
      throw new BrowserCheckError();
    }

    let completedField = false;
    if (await visible(usernameInput)) {
      currentStage = `${attempt}_username`;
      await fillStable(page, usernameInput, username);
      completedField = true;
    }
    if (await visible(passwordInput)) {
      currentStage = `${attempt}_password`;
      await fillStable(page, passwordInput, password);
      completedField = true;
    }

    const action = (await visible(namedAction)) ? namedAction : submitAction;
    if (!completedField) currentStage = `${attempt}_consent`;
    if (!(completedField || (await visible(action)))) {
      currentStage = `${attempt}_unrecognized`;
      throw new BrowserCheckError();
    }
    currentStage = `${attempt}_submit`;
    await retryInteraction(page, async () => {
      await action.waitFor({ state: "visible", timeout: 5_000 });
      await action.click({ noWaitAfter: true, timeout: 5_000 });
    });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(250);
  }
  currentStage = `${attempt}_callback`;
  throw new BrowserCheckError();
}

async function session(request) {
  const response = await request.get("/api/auth/session", { maxRedirects: 0 });
  return json(response, 200);
}

async function waitForRevokedSession(request) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = await session(request);
    if (current.principal === null && current.csrfToken === null) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new BrowserCheckError();
}

function assertPrincipal(current, issuer, subject) {
  assert(current?.csrfToken && current.principal);
  assert(current.principal.accountState === "pending_link");
  assert(current.principal.role === "admin");
  assert(current.principal.authenticationMethod?.kind === "oidc");
  assert(current.principal.authenticationMethod.providerId === expectedProviderId);
  assert(current.principal.externalIdentity?.providerId === expectedProviderId);
  assert(current.principal.externalIdentity.issuer === issuer);
  assert(typeof current.principal.externalIdentity.subject === "string");
  assert(current.principal.externalIdentity.subject.length > 0);
  if (subject !== undefined) assert(current.principal.externalIdentity.subject === subject);
  return current.principal.externalIdentity.subject;
}

async function logoutAtAuthentik(page, issuerOrigin) {
  await page.goto(`${issuerOrigin}/if/flow/default-invalidation-flow/`, {
    waitUntil: "domcontentloaded",
  });
  assert(new URL(page.url()).origin === issuerOrigin);
}

const AUTHENTIK_TASK_STATES = new Set([
  "consumed",
  "done",
  "error",
  "info",
  "postprocess",
  "preprocess",
  "queued",
  "rejected",
  "running",
  "warning",
]);

async function authentikTaskOutcome(request, issuerOrigin, token, actorName) {
  const response = await request.get(
    `${issuerOrigin}/api/v3/tasks/tasks/?actor_name=${encodeURIComponent(actorName)}&page_size=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await json(response, 200);
  assert(Array.isArray(body.results));
  const states = body.results
    .filter((task) => task?.actorName === actorName || task?.actor_name === actorName)
    .map((task) => task.aggregatedStatus ?? task.aggregated_status ?? task.state)
    .filter((state) => typeof state === "string" && AUTHENTIK_TASK_STATES.has(state));
  if (states.some((state) => state === "error" || state === "rejected" || state === "warning")) {
    return "failed";
  }
  if (
    states.some((state) =>
      ["consumed", "postprocess", "preprocess", "queued", "running"].includes(state),
    )
  ) {
    return "pending";
  }
  if (states.some((state) => state === "done" || state === "info")) return "completed";
  return "missing";
}

async function backchannelTaskFailureStage(request, issuerOrigin, token) {
  try {
    const dispatch = await authentikTaskOutcome(
      request,
      issuerOrigin,
      token,
      "backchannel_logout_notification_dispatch",
    );
    if (dispatch !== "completed") return `backchannel_dispatch_${dispatch}`;
    const delivery = await authentikTaskOutcome(
      request,
      issuerOrigin,
      token,
      "send_backchannel_logout_request",
    );
    return `backchannel_send_${delivery}`;
  } catch {
    return "backchannel_task_status_unavailable";
  }
}

async function run() {
  const webOrigin = required("OMNIFIN_FIXTURE_WEB_ORIGIN");
  const issuer = required("OMNIFIN_FIXTURE_AUTHENTIK_ISSUER");
  const issuerOrigin = new URL(issuer).origin;
  const clientId = required("OMNIFIN_FIXTURE_CLIENT_ID");
  const clientSecret = required("OMNIFIN_FIXTURE_CLIENT_SECRET");
  const recoverySecret = required("OMNIFIN_FIXTURE_RECOVERY_SECRET");
  const authentikToken = required("OMNIFIN_FIXTURE_AUTHENTIK_TOKEN");
  const authentikPassword = required("OMNIFIN_FIXTURE_AUTHENTIK_PASSWORD");
  assert(new URL(webOrigin).protocol === "https:");
  assert(new URL(issuer).protocol === "https:");

  const sensitiveValues = [clientSecret, recoverySecret, authentikToken, authentikPassword];
  const observedBrowserText = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      baseURL: webOrigin,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on("console", (message) => observedBrowserText.push(message.text()));
    page.on("pageerror", () => observedBrowserText.push("browser_page_error"));
    page.on("request", (request) => observedBrowserText.push(request.url()));

    currentStage = "recovery_session";
    const recovery = await context.request.post("/api/auth/recovery/session", {
      data: { secret: recoverySecret },
      headers: { origin: webOrigin },
      maxRedirects: 0,
    });
    const recoverySession = await json(recovery, 200);
    assert(recoverySession.principal?.accountState === "recovery");
    assert(typeof recoverySession.csrfToken === "string");
    const csrfToken = recoverySession.csrfToken;

    const providerInput = {
      allowJitProvisioning: true,
      approvedEndpointOrigins: [issuerOrigin],
      clientId,
      clientSecret,
      displayName: "Authentik",
      enabled: false,
      idTokenSigningAlg: "RS256",
      issuer,
      scopes: ["openid", "profile", "email"],
      slug: providerSlug,
      tokenEndpointAuthMethod: "client_secret_basic",
    };
    currentStage = "provider_create";
    const created = await mutate(
      context.request,
      webOrigin,
      "/api/admin/auth/oidc/providers",
      csrfToken,
      providerInput,
    );
    assert(created.id === expectedProviderId);
    assert(created.enabled === false);

    currentStage = "provider_validate";
    const validation = await validateProvider(
      context.request,
      `/api/admin/auth/oidc/providers/${expectedProviderId}/validate`,
      webOrigin,
      csrfToken,
    );
    assert(validation.capabilities?.authorizationCodeFlow === true);
    assert(validation.capabilities?.pkceS256 === true);
    assert(validation.capabilities?.logout?.backChannel === true);
    assert(validation.capabilities?.logout?.rpInitiated === true);

    currentStage = "role_mapping";
    const mapping = await mutate(
      context.request,
      webOrigin,
      `/api/admin/auth/oidc/providers/${expectedProviderId}/role-mappings`,
      csrfToken,
      {
        claimPath: ["groups"],
        enabled: true,
        operator: "contains_any",
        priority: 1_000,
        role: "admin",
        values: ["authentik Admins"],
      },
    );
    assert(mapping.mapping?.providerId === expectedProviderId);

    currentStage = "provider_enable";
    const enabled = await mutate(
      context.request,
      webOrigin,
      `/api/admin/auth/oidc/providers/${expectedProviderId}`,
      csrfToken,
      { ...providerInput, clientSecret: undefined, enabled: true },
      "PUT",
    );
    assert(enabled.provider?.enabled === true);

    currentStage = "public_provider";
    const providersResponse = await context.request.get("/api/auth/providers", {
      maxRedirects: 0,
    });
    const providers = await json(providersResponse, 200);
    const publicProvider = providers.providers?.find(
      (provider) => provider.id === expectedProviderId,
    );
    assert(publicProvider?.state === "available");
    assert(publicProvider.supportsBackChannelLogout === true);
    assert(publicProvider.supportsRpInitiatedLogout === true);

    const startPath = `/api/auth/oidc/${expectedProviderId}/start`;
    currentStage = "first_browser_login";
    await completeAuthentikFlow(
      page,
      startPath,
      "akadmin",
      authentikPassword,
      webOrigin,
      "first_login",
    );
    currentStage = "first_session";
    const firstSession = await session(context.request);
    const subject = assertPrincipal(firstSession, issuer);

    currentStage = "backchannel_trigger";
    await logoutAtAuthentik(page, issuerOrigin);
    currentStage = "backchannel_revocation";
    try {
      await waitForRevokedSession(context.request);
    } catch {
      currentStage = await backchannelTaskFailureStage(
        context.request,
        issuerOrigin,
        authentikToken,
      );
      throw new BrowserCheckError();
    }

    currentStage = "second_browser_login";
    await completeAuthentikFlow(
      page,
      startPath,
      "akadmin",
      authentikPassword,
      webOrigin,
      "second_login",
    );
    currentStage = "second_session";
    const secondSession = await session(context.request);
    assertPrincipal(secondSession, issuer, subject);

    currentStage = "rp_logout";
    const logout = await context.request.post("/api/auth/oidc/logout", {
      form: { csrfToken: secondSession.csrfToken },
      headers: { origin: webOrigin },
      maxRedirects: 0,
    });
    assert(logout.status() === 303);
    const logoutLocation = logout.headers().location;
    assert(typeof logoutLocation === "string");
    const providerLogout = new URL(logoutLocation);
    assert(providerLogout.origin === issuerOrigin);
    assert(providerLogout.pathname.includes("/application/o/omnifin/end-session/"));
    currentStage = "rp_session_revocation";
    await waitForRevokedSession(context.request);

    currentStage = "secret_leak_inspection";
    assert(
      !sensitiveValues.some((secret) =>
        observedBrowserText.some((observation) => observation.includes(secret)),
      ),
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await run();
  process.stdout.write('{"event":"authentik_browser_checks_passed"}\n');
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "authentik_browser_checks_failed", stage: currentStage })}\n`,
  );
  process.exitCode = 1;
}
