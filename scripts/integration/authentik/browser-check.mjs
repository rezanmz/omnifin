#!/usr/bin/env node

import { createRequire } from "node:module";

import {
  httpFailureStage,
  PROVIDER_VALIDATION_MAX_ATTEMPTS,
  providerValidationRetryDelay,
} from "./fixture.mjs";

const requireFromWeb = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = requireFromWeb("@playwright/test");

const providerSlug = "authentik";
const expectedProviderId = `oidc-${providerSlug}`;
const INTERACTION_RETRY_ATTEMPTS = 6;
const INTERACTION_WAIT_TIMEOUT_MS = 30_000;

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

async function json(response, expectedStatus, failureStage) {
  if (response.status() !== expectedStatus) {
    if (failureStage) currentStage = httpFailureStage(failureStage, response.status());
    throw new BrowserCheckError();
  }
  try {
    return await response.json();
  } catch {
    if (failureStage) currentStage = `${failureStage}_invalid_response`;
    throw new BrowserCheckError();
  }
}

async function mutate(request, webOrigin, path, csrfToken, data) {
  const response = await request.post(path, {
    data,
    headers: {
      origin: webOrigin,
      "x-omnifin-csrf": csrfToken,
    },
    maxRedirects: 0,
  });
  return json(response, 201);
}

async function validateProvider(request, path, webOrigin, csrfToken) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < PROVIDER_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    const response = await request.post(path, {
      headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
      maxRedirects: 0,
    });
    if (response.status() === 200) return json(response, 200);
    const retryAfterSeconds = Number(response.headers()["retry-after"]);
    let delayMs;
    try {
      delayMs = providerValidationRetryDelay({
        attempt,
        elapsedMs: Date.now() - startedAt,
        retryAfterSeconds,
        status: response.status(),
      });
    } catch {
      throw new BrowserCheckError();
    }
    if (delayMs === null) throw new BrowserCheckError();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new BrowserCheckError();
}

async function enableProvider(request, path, webOrigin, csrfToken, data) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < PROVIDER_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    const response = await request.put(path, {
      data,
      headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
      maxRedirects: 0,
    });
    if (response.status() === 200) return json(response, 200);
    const retryAfterSeconds = Number(response.headers()["retry-after"]);
    let delayMs;
    try {
      delayMs = providerValidationRetryDelay({
        attempt,
        elapsedMs: Date.now() - startedAt,
        retryAfterSeconds,
        status: response.status(),
      });
    } catch {
      return json(response, 200, "provider_enable");
    }
    if (delayMs === null) return json(response, 200, "provider_enable");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  const deadline = Date.now() + INTERACTION_WAIT_TIMEOUT_MS;
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

async function waitForStageTransition(page, activeStage, webOrigin) {
  const deadline = Date.now() + INTERACTION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === webOrigin && current.pathname === "/link/jellyfin") return "callback";
    try {
      if (!(await activeStage.evaluate((stage) => stage.isConnected))) return "transitioned";
    } catch {
      return "transitioned";
    }
    await page.waitForTimeout(100);
  }
  return "timeout";
}

function unrecognizedStage(url, webOrigin, attempt) {
  const current = new URL(url);
  if (current.origin === webOrigin) return `${attempt}_omnifin_unexpected`;
  if (current.pathname.startsWith("/if/flow/")) {
    return `${attempt}_authentik_flow_unrecognized`;
  }
  if (current.pathname.startsWith("/application/o/authorize/")) {
    return `${attempt}_authentik_authorize_unrecognized`;
  }
  return `${attempt}_unrecognized`;
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

async function submitStableForm(page, locator) {
  await retryInteraction(page, async () => {
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.evaluate((form) => {
      if (form.tagName !== "FORM" || typeof form.requestSubmit !== "function") {
        throw new Error("fixture_form_unavailable");
      }
      form.requestSubmit();
    });
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
        'ak-stage-identification input[name="uidField"]:visible, ak-stage-identification input[name="username"]:visible, ak-stage-identification input[type="email"]:visible',
      )
      .first();
    const passwordInput = page
      .locator(
        'ak-stage-identification input[name="password"]:visible, ak-stage-password input[name="password"]:visible',
      )
      .first();
    const namedAction = page
      .getByRole("button", {
        name: /^(?:allow|authorize|continue|log in|sign in|submit)$/iu,
      })
      .first();
    const submitAction = page
      .locator(
        'ak-stage-identification button[type="submit"]:visible, ak-stage-password button[type="submit"]:visible, ak-stage-consent button[type="submit"]:visible',
      )
      .last();
    const credentialForm = page
      .locator("ak-stage-identification form, ak-stage-password form")
      .first();
    const readiness = await waitForInteraction(page, webOrigin, [
      usernameInput,
      passwordInput,
      namedAction,
      submitAction,
    ]);
    if (readiness === "callback") return;
    if (readiness === "unrecognized") {
      currentStage = unrecognizedStage(page.url(), webOrigin, attempt);
      throw new BrowserCheckError();
    }

    const activeStage = await page
      .locator(
        "ak-stage-identification:visible, ak-stage-password:visible, ak-stage-consent:visible",
      )
      .first()
      .elementHandle();
    assert(activeStage);

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
    if (completedField) {
      currentStage = `${attempt}_form_submit`;
      await submitStableForm(page, credentialForm);
    } else {
      currentStage = `${attempt}_consent_submit`;
      await submitStableForm(page, page.locator("ak-stage-consent form").first());
    }
    currentStage = `${attempt}_transition`;
    const transition = await waitForStageTransition(page, activeStage, webOrigin);
    if (transition === "callback") return;
    if (transition === "timeout") throw new BrowserCheckError();
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

async function assertAuthentikBrowserSession(request, issuerOrigin) {
  const response = await request.get(`${issuerOrigin}/api/v3/core/users/me/`, {
    maxRedirects: 0,
  });
  const body = await json(response, 200);
  assert(body.user?.username === "akadmin");
}

async function currentAuthentikBrowserSession(request, issuerOrigin) {
  const response = await request.get(
    `${issuerOrigin}/api/v3/core/authenticated_sessions/?page_size=100&user__username=akadmin`,
    { maxRedirects: 0 },
  );
  const body = await json(response, 200);
  assert(Array.isArray(body.results));
  assert(body.results.some((session) => session?.current === true));
  const sessionIds = body.results
    .map((session) => session?.uuid)
    .filter((sessionId) => typeof sessionId === "string" && sessionId.length > 0);
  assert(sessionIds.length > 0);
  return sessionIds;
}

async function revokeAuthentikBrowserSessions(request, issuerOrigin, token, sessionIds) {
  for (const sessionId of sessionIds) {
    const response = await request.delete(
      `${issuerOrigin}/api/v3/core/authenticated_sessions/${encodeURIComponent(sessionId)}/`,
      {
        headers: { authorization: `Bearer ${token}` },
        maxRedirects: 0,
      },
    );
    assert(response.status() === 204);
  }
}

async function authentikAccessTokens(request, issuerOrigin, token, providerPk) {
  const response = await request.get(
    `${issuerOrigin}/api/v3/oauth2/access_tokens/?page_size=100&provider=${encodeURIComponent(providerPk)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await json(response, 200, "backchannel_access_token_api");
  assert(Array.isArray(body.results));
  return body.results;
}

function providerUserAccessTokens(accessTokens, providerPk) {
  return accessTokens.filter(
    (accessToken) =>
      String(accessToken?.provider?.pk) === String(providerPk) &&
      accessToken?.user?.username === "akadmin",
  );
}

async function assertAuthentikAccessToken(request, issuerOrigin, token, providerPk) {
  const accessTokens = await authentikAccessTokens(request, issuerOrigin, token, providerPk);
  if (accessTokens.length === 0) {
    currentStage = "backchannel_access_token_missing";
    throw new BrowserCheckError();
  }
  const providerTokens = accessTokens.filter(
    (accessToken) => String(accessToken?.provider?.pk) === String(providerPk),
  );
  if (providerTokens.length === 0) {
    currentStage = "backchannel_access_token_provider_mismatch";
    throw new BrowserCheckError();
  }
  const userTokens = providerUserAccessTokens(providerTokens, providerPk);
  if (userTokens.length === 0) {
    currentStage = "backchannel_access_token_user_mismatch";
    throw new BrowserCheckError();
  }
  if (!userTokens.some((accessToken) => accessToken?.revoked === false)) {
    currentStage = "backchannel_access_token_inactive";
    throw new BrowserCheckError();
  }
}

async function assertAuthentikProviderConfiguration(
  request,
  issuerOrigin,
  token,
  clientId,
  backchannelUrl,
) {
  const response = await request.get(
    `${issuerOrigin}/api/v3/providers/oauth2/?page_size=100&search=Omnifin`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await json(response, 200);
  assert(Array.isArray(body.results));
  const provider = body.results.find((entry) => (entry.clientId ?? entry.client_id) === clientId);
  assert((provider?.logoutMethod ?? provider?.logout_method) === "backchannel");
  assert((provider?.logoutUri ?? provider?.logout_uri) === backchannelUrl);
  assert(typeof provider.pk === "number" || typeof provider.pk === "string");
  return provider.pk;
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
    const delivery = await authentikTaskOutcome(
      request,
      issuerOrigin,
      token,
      "send_backchannel_logout_request",
    );
    if (delivery !== "missing") return `backchannel_send_${delivery}`;
    const dispatch = await authentikTaskOutcome(
      request,
      issuerOrigin,
      token,
      "backchannel_logout_notification_dispatch",
    );
    if (dispatch !== "completed") return `backchannel_dispatch_${dispatch}`;
    return "backchannel_send_missing";
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

    currentStage = "authentik_provider_configuration";
    const authentikProviderPk = await assertAuthentikProviderConfiguration(
      context.request,
      issuerOrigin,
      authentikToken,
      clientId,
      `${webOrigin}/api/auth/oidc/backchannel/${expectedProviderId}`,
    );

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
    const enabled = await enableProvider(
      context.request,
      `/api/admin/auth/oidc/providers/${expectedProviderId}`,
      webOrigin,
      csrfToken,
      { ...providerInput, clientSecret: undefined, enabled: true },
    );
    currentStage = "provider_enable_response";
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

    currentStage = "backchannel_access_token";
    await assertAuthentikAccessToken(
      context.request,
      issuerOrigin,
      authentikToken,
      authentikProviderPk,
    );
    currentStage = "backchannel_provider_session";
    await assertAuthentikBrowserSession(context.request, issuerOrigin);
    currentStage = "backchannel_session_lookup";
    const authentikSessionIds = await currentAuthentikBrowserSession(context.request, issuerOrigin);
    currentStage = "backchannel_trigger";
    await revokeAuthentikBrowserSessions(
      context.request,
      issuerOrigin,
      authentikToken,
      authentikSessionIds,
    );
    currentStage = "backchannel_access_token_cleanup";
    const remainingAccessTokens = await authentikAccessTokens(
      context.request,
      issuerOrigin,
      authentikToken,
      authentikProviderPk,
    );
    if (providerUserAccessTokens(remainingAccessTokens, authentikProviderPk).length > 0) {
      currentStage = "backchannel_access_token_retained";
      throw new BrowserCheckError();
    }
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
