#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  httpFailureStage,
  PROVIDER_VALIDATION_MAX_ATTEMPTS,
  providerValidationRetryDelay,
} from "./fixture.mjs";

const requireFromWeb = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = requireFromWeb("@playwright/test");
const composeFile = fileURLToPath(new URL("./compose.yaml", import.meta.url));

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
let failureDetail = {};
let issuerRequestFailed = false;
let pageErrorObserved = false;

function required(name) {
  const value = process.env[name];
  if (!value) throw new BrowserCheckError();
  return value;
}

function assert(condition) {
  if (!condition) throw new BrowserCheckError();
}

function dispatchAuthentikBackchannel(project, environmentFile) {
  assert(/^[a-z0-9-]{1,127}$/u.test(project));
  const execution = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--file",
      composeFile,
      "--env-file",
      environmentFile,
      "exec",
      "-T",
      "worker",
      "ak",
      "shell",
      "-c",
      "exec(open('/blueprints/omnifin-dispatch-backchannel.py', encoding='utf-8').read())",
    ],
    { encoding: "utf8", maxBuffer: 1_048_576, timeout: 30_000 },
  );
  if (execution.error?.code === "ETIMEDOUT") {
    currentStage = "backchannel_trigger_timeout";
    throw new BrowserCheckError();
  }
  if (execution.status !== 0) {
    const diagnostic = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;
    if (/fixture_access_token_unavailable/u.test(diagnostic)) {
      currentStage = "backchannel_trigger_token_unavailable";
    } else if (/fixture_backchannel_provider_invalid/u.test(diagnostic)) {
      currentStage = "backchannel_trigger_provider_invalid";
    } else if (/no such command ['"]?shell|unknown command ['"]?shell/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_shell_unavailable";
    } else if (
      /missing authority key identifier|invalid ca certificate|key usage/iu.test(diagnostic)
    ) {
      currentStage = "backchannel_trigger_tls_chain_failure";
    } else if (/hostname mismatch|ip address mismatch|doesn't match/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_tls_identity_failure";
    } else if (/certificate has expired|certificate is not yet valid/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_tls_validity_failure";
    } else if (/certificate_verify_failed|sslerror/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_tls_failure";
    } else if (/connectionerror|connection refused|network is unreachable/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_network_failure";
    } else if (/httperror/iu.test(diagnostic)) {
      currentStage = "backchannel_trigger_response_failure";
    } else {
      currentStage = "backchannel_trigger_process_failure";
    }
    throw new BrowserCheckError();
  }
  if (!execution.stdout.includes('"event":"authentik_backchannel_delivered"')) {
    currentStage = "backchannel_trigger_output_missing";
    throw new BrowserCheckError();
  }
}

async function json(response, expectedStatus, failureStage) {
  if (response.status() !== expectedStatus) {
    const requestId = response.headers()["x-request-id"];
    let errorCode;
    try {
      const body = await response.json();
      if (
        typeof body?.error?.code === "string" &&
        /^[a-z][a-z0-9_]{2,63}$/u.test(body.error.code)
      ) {
        errorCode = body.error.code;
      }
    } catch {
      // Failure diagnostics stay useful even when an upstream response is not JSON.
    }
    failureDetail = {
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
        ? { requestId }
        : {}),
      status: response.status(),
    };
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

async function updateMapping(request, webOrigin, path, csrfToken, data) {
  const response = await request.put(path, {
    data,
    headers: {
      origin: webOrigin,
      "x-omnifin-csrf": csrfToken,
    },
    maxRedirects: 0,
  });
  return json(response, 200);
}

async function exchangeInvitation(request, webOrigin, invitationUrl) {
  const parsed = new URL(invitationUrl);
  assert(parsed.pathname === "/invite");
  const match = /^#invite=([A-Za-z0-9_-]{43})$/u.exec(parsed.hash);
  assert(match !== null);
  const response = await request.post("/api/auth/invitations/exchange", {
    data: { token: match[1] },
    headers: { origin: webOrigin },
    maxRedirects: 0,
  });
  assert(response.status() === 204);
}

async function startInvitationAuthorization(request, webOrigin) {
  const response = await request.post(`/api/auth/invitations/oidc/${expectedProviderId}/start`, {
    data: {},
    headers: { origin: webOrigin },
    maxRedirects: 0,
  });
  const started = await json(response, 200);
  assert(typeof started.authorizationUrl === "string");
  return started.authorizationUrl;
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

async function waitForInteraction(page, webOrigin, locators, isComplete) {
  const deadline = Date.now() + INTERACTION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === webOrigin && isComplete(current)) return "callback";
    for (const locator of locators) {
      if (await visible(locator)) return "interaction";
    }
    await page.waitForTimeout(100);
  }
  return "unrecognized";
}

async function waitForStageTransition(page, activeStage, webOrigin, isComplete) {
  const deadline = Date.now() + INTERACTION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === webOrigin && isComplete(current)) return "callback";
    try {
      if (!(await activeStage.evaluate((stage) => stage.isConnected))) return "transitioned";
    } catch {
      return "transitioned";
    }
    await page.waitForTimeout(100);
  }
  return "timeout";
}

async function unrecognizedStage(page, webOrigin, attempt) {
  const knownStages = [
    ["ak-stage-access-denied", "access_denied"],
    ["ak-stage-authenticator-validate", "authenticator_validate"],
    ["ak-stage-autosubmit", "autosubmit_stalled"],
    ["ak-stage-consent", "consent_unrecognized"],
    ["ak-stage-flow-error", "flow_error"],
    ["ak-stage-identification", "identification_unrecognized"],
    ["ak-stage-password", "password_unrecognized"],
    ["ak-stage-redirect", "redirect_stalled"],
    ["ak-stage-user-login", "user_login_stalled"],
  ];
  for (const [selector, diagnostic] of knownStages) {
    if (await visible(page.locator(`${selector}:visible`).first())) {
      return `${attempt}_${diagnostic}`;
    }
  }
  if (pageErrorObserved) return `${attempt}_page_error`;
  if (issuerRequestFailed) return `${attempt}_issuer_request_failed`;
  if (await visible(page.locator("ak-flow-executor:visible").first())) {
    return `${attempt}_flow_executor_stalled`;
  }
  const current = new URL(page.url());
  if (current.origin === webOrigin) {
    if (current.pathname === "/login") {
      return `${attempt}_login_${current.searchParams.get("authError") ?? "unexpected"}`;
    }
    return `${attempt}_omnifin_unexpected`;
  }
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

async function completeAuthentikFlow(
  page,
  startPath,
  username,
  password,
  webOrigin,
  attempt,
  { expectedPath = "/link/jellyfin", isComplete = (url) => url.pathname === expectedPath } = {},
) {
  issuerRequestFailed = false;
  pageErrorObserved = false;
  currentStage = `${attempt}_navigation`;
  const navigation = await page.goto(startPath, { waitUntil: "domcontentloaded" });
  if (!navigation || navigation.status() >= 400) {
    currentStage = `${attempt}_navigation_response`;
    failureDetail = { status: navigation?.status() ?? 0 };
    throw new BrowserCheckError();
  }

  for (let step = 0; step < 12; step += 1) {
    if (new URL(page.url()).origin === webOrigin && isComplete(new URL(page.url()))) {
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
    const readiness = await waitForInteraction(
      page,
      webOrigin,
      [usernameInput, passwordInput, namedAction, submitAction],
      isComplete,
    );
    if (readiness === "callback") return;
    if (readiness === "unrecognized") {
      currentStage = await unrecognizedStage(page, webOrigin, attempt);
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
    const transition = await waitForStageTransition(page, activeStage, webOrigin, isComplete);
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

async function assertAuthentikBrowserSession(request, issuerOrigin, username) {
  const response = await request.get(`${issuerOrigin}/api/v3/core/users/me/`, {
    maxRedirects: 0,
  });
  const body = await json(response, 200);
  assert(body.user?.username === username);
}

async function currentAuthentikBrowserSession(request, issuerOrigin, username) {
  const response = await request.get(
    `${issuerOrigin}/api/v3/core/authenticated_sessions/?page_size=100&user__username=${encodeURIComponent(username)}`,
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

function providerUserAccessTokens(accessTokens, providerPk, username) {
  return accessTokens.filter(
    (accessToken) =>
      String(accessToken?.provider?.pk) === String(providerPk) &&
      accessToken?.user?.username === username,
  );
}

async function assertAuthentikAccessToken(request, issuerOrigin, token, providerPk, username) {
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
  const userTokens = providerUserAccessTokens(providerTokens, providerPk, username);
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

function assertPrincipal(current, issuer, expectedRole, subject) {
  assert(current?.csrfToken && current.principal);
  assert(current.principal.accountState === "pending_link");
  assert(current.principal.role === expectedRole);
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
  const jellyfinAdminPassword = required("OMNIFIN_FIXTURE_JELLYFIN_ADMIN_PASSWORD");
  const composeProject = required("OMNIFIN_FIXTURE_COMPOSE_PROJECT");
  const composeEnvironmentFile = required("OMNIFIN_FIXTURE_COMPOSE_ENV_FILE");
  assert(new URL(webOrigin).protocol === "https:");
  assert(new URL(issuer).protocol === "https:");

  const sensitiveValues = [
    clientSecret,
    recoverySecret,
    authentikToken,
    authentikPassword,
    jellyfinAdminPassword,
  ];
  const observedBrowserText = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      baseURL: webOrigin,
      ignoreHTTPSErrors: true,
    });
    const userContext = await browser.newContext({
      baseURL: webOrigin,
      ignoreHTTPSErrors: true,
    });
    const page = await userContext.newPage();
    page.on("console", (message) => observedBrowserText.push(message.text()));
    page.on("pageerror", () => {
      pageErrorObserved = true;
      observedBrowserText.push("browser_page_error");
    });
    page.on("request", (request) => observedBrowserText.push(request.url()));
    page.on("requestfailed", (request) => {
      try {
        if (new URL(request.url()).origin === issuerOrigin) issuerRequestFailed = true;
      } catch {
        issuerRequestFailed = true;
      }
    });

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
      allowJitProvisioning: false,
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

    currentStage = "role_mapping_update";
    const updatedMapping = await updateMapping(
      context.request,
      webOrigin,
      `/api/admin/auth/oidc/providers/${expectedProviderId}/role-mappings/${mapping.mapping.id}`,
      csrfToken,
      {
        claimPath: ["groups"],
        enabled: true,
        operator: "contains_any",
        priority: 1_000,
        role: "operator",
        values: ["authentik Admins"],
      },
    );
    assert(updatedMapping.mapping?.id === mapping.mapping.id);
    assert(updatedMapping.revokedSessions === 0);

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

    currentStage = "admin_bootstrap";
    const administrator = await json(
      await context.request.post("/api/auth/bootstrap/jellyfin/password", {
        data: { password: jellyfinAdminPassword, username: "fixture-admin" },
        headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
        maxRedirects: 0,
      }),
      200,
    );
    currentStage = "admin_session";
    assert(administrator.principal?.accountState === "active");
    assert(administrator.principal?.role === "admin");
    assert(administrator.principal?.authenticationMethod?.kind === "jellyfin");
    assert(typeof administrator.csrfToken === "string");

    currentStage = "invitation_create";
    const createdInvitation = await mutate(
      context.request,
      webOrigin,
      "/api/admin/invites",
      administrator.csrfToken,
      {},
    );
    const invitationUrl = new URL(createdInvitation.invitationUrl);
    assert(invitationUrl.origin === webOrigin);
    assert(invitationUrl.pathname === "/invite");
    assert(invitationUrl.search === "");
    assert(/^#invite=[A-Za-z0-9_-]{43}$/u.test(invitationUrl.hash));

    currentStage = "first_invitation_exchange";
    await exchangeInvitation(userContext.request, webOrigin, invitationUrl.href);
    assert(
      (await userContext.cookies(webOrigin)).some((cookie) =>
        cookie.name.includes("registration_handoff"),
      ),
    );
    currentStage = "first_invitation_start";
    const invitationAuthorizationUrl = await startInvitationAuthorization(
      userContext.request,
      webOrigin,
    );

    currentStage = "first_browser_login";
    await completeAuthentikFlow(
      page,
      invitationAuthorizationUrl,
      "akadmin",
      authentikPassword,
      webOrigin,
      "first_login",
    );
    currentStage = "first_session";
    const firstSession = await session(userContext.request);
    const subject = assertPrincipal(firstSession, issuer, "operator");

    currentStage = "invitation_consumption";
    const invitations = await json(
      await context.request.get("/api/admin/invites", { maxRedirects: 0 }),
      200,
    );
    const consumedInvitation = invitations.invitations?.find(
      (invitation) => invitation.id === createdInvitation.invitation.id,
    );
    assert(consumedInvitation?.status === "consumed");

    currentStage = "backchannel_access_token";
    await assertAuthentikAccessToken(
      context.request,
      issuerOrigin,
      authentikToken,
      authentikProviderPk,
      "akadmin",
    );
    currentStage = "backchannel_provider_session";
    await assertAuthentikBrowserSession(userContext.request, issuerOrigin, "akadmin");
    currentStage = "backchannel_session_lookup";
    const authentikSessionIds = await currentAuthentikBrowserSession(
      userContext.request,
      issuerOrigin,
      "akadmin",
    );
    currentStage = "backchannel_trigger";
    dispatchAuthentikBackchannel(composeProject, composeEnvironmentFile);
    currentStage = "backchannel_revocation";
    try {
      await waitForRevokedSession(userContext.request);
    } catch {
      currentStage = await backchannelTaskFailureStage(
        context.request,
        issuerOrigin,
        authentikToken,
      );
      throw new BrowserCheckError();
    }

    currentStage = "backchannel_provider_session_cleanup";
    await revokeAuthentikBrowserSessions(
      userContext.request,
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
    if (
      providerUserAccessTokens(remainingAccessTokens, authentikProviderPk, "akadmin").length > 0
    ) {
      currentStage = "backchannel_access_token_retained";
      throw new BrowserCheckError();
    }

    currentStage = "second_browser_login";
    await completeAuthentikFlow(
      page,
      `/api/auth/oidc/${expectedProviderId}/start`,
      "akadmin",
      authentikPassword,
      webOrigin,
      "second_login",
    );
    currentStage = "second_session";
    const secondSession = await session(userContext.request);
    assertPrincipal(secondSession, issuer, "operator", subject);

    currentStage = "rp_logout";
    const logout = await userContext.request.post("/api/auth/oidc/logout", {
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
    await waitForRevokedSession(userContext.request);

    currentStage = "secret_leak_inspection";
    assert(
      !sensitiveValues.some((secret) =>
        observedBrowserText.some((observation) => observation.includes(secret)),
      ),
    );
    await Promise.all([context.close(), userContext.close()]);
  } finally {
    await browser.close();
  }
}

try {
  await run();
  process.stdout.write('{"event":"authentik_browser_checks_passed"}\n');
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "authentik_browser_checks_failed", stage: currentStage, ...failureDetail })}\n`,
  );
  process.exitCode = 1;
}
