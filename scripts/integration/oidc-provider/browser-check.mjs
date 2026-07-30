#!/usr/bin/env node

import { createRequire } from "node:module";

const requireFromWeb = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = requireFromWeb("@playwright/test");

const providerSlug = "generic";
const expectedProviderId = `oidc-${providerSlug}`;
const SESSION_COOKIE_NAME = "__Host-omnifin_session";
const FLOW_TIMEOUT_MS = 60_000;
const SESSION_CONVERGENCE_TIMEOUT_MS = 10_000;

class BrowserCheckError extends Error {
  constructor() {
    super("oidc_provider_browser_check_failed");
    this.name = "BrowserCheckError";
  }
}

let currentStage = "configuration";
let failureDetail = {};

function required(name) {
  const value = process.env[name];
  if (!value) throw new BrowserCheckError();
  return value;
}

function assert(condition, check = "assertion") {
  if (condition) return;
  if (/^[a-z][a-z0-9_]{2,63}$/u.test(check)) failureDetail = { check };
  throw new BrowserCheckError();
}

async function json(response, expectedStatus) {
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
      // The bounded status and request ID remain useful without a response body.
    }
    failureDetail = {
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)
        ? { requestId }
        : {}),
      status: response.status(),
    };
    throw new BrowserCheckError();
  }
  try {
    return await response.json();
  } catch {
    throw new BrowserCheckError();
  }
}

async function create(request, webOrigin, path, csrfToken, data) {
  return json(
    await request.post(path, {
      data,
      headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
      maxRedirects: 0,
    }),
    201,
  );
}

async function update(request, webOrigin, path, csrfToken, data) {
  return json(
    await request.put(path, {
      data,
      headers: { origin: webOrigin, "x-omnifin-csrf": csrfToken },
      maxRedirects: 0,
    }),
    200,
  );
}

async function recoverySession(request, webOrigin, secret) {
  const recovery = await request.post("/api/auth/recovery/session", {
    data: { secret },
    headers: { origin: webOrigin },
    maxRedirects: 0,
  });
  const session = await json(recovery, 200);
  assert(session.principal?.accountState === "recovery");
  assert(typeof session.csrfToken === "string");
  return session;
}

async function currentSession(request) {
  return json(await request.get("/api/auth/session", { maxRedirects: 0 }), 200);
}

async function waitForLocalRevocation(request) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const session = await currentSession(request);
    if (session.principal === null && session.csrfToken === null) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
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

async function completeAuthorization(page, startPath, webOrigin, attempt) {
  currentStage = `${attempt}_navigation`;
  const navigation = await page.goto(startPath, { waitUntil: "domcontentloaded" });
  if (!navigation || navigation.status() >= 400) {
    failureDetail = { status: navigation?.status() ?? 0 };
    throw new BrowserCheckError();
  }

  const deadline = Date.now() + FLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === webOrigin && current.pathname === "/link/jellyfin") return;

    const connector = page
      .getByRole("link", { name: /generic identity|log in with generic/iu })
      .first();
    const approval = page
      .getByRole("button", { name: /approve|authorize|grant access|continue/iu })
      .first();
    if (await visible(connector)) {
      currentStage = `${attempt}_connector`;
      await connector.click();
    } else if (await visible(approval)) {
      currentStage = `${attempt}_approval`;
      await approval.click();
    } else {
      await page.waitForTimeout(100);
    }
  }
  currentStage = `${attempt}_callback`;
  throw new BrowserCheckError();
}

function assertPendingPrincipal(session, issuer, expectedRole, expectedSubject, expectedUserId) {
  assert(session?.csrfToken && session.principal, "principal_available");
  const principal = session.principal;
  assert(principal.accountState === "pending_link", "principal_account_state");
  assert(principal.role === expectedRole, "principal_role");
  assert(principal.authenticationMethod?.kind === "oidc", "principal_authentication_method");
  assert(
    principal.authenticationMethod.providerId === expectedProviderId,
    "principal_authentication_provider",
  );
  assert(principal.linkedServices?.length === 0, "principal_link_state");
  assert(
    JSON.stringify([...principal.permissions].sort()) ===
      JSON.stringify(["identities.self.manage", "sessions.self.revoke"]),
    "principal_permissions",
  );
  assert(
    principal.externalIdentity?.providerId === expectedProviderId,
    "principal_external_provider",
  );
  assert(principal.externalIdentity.issuer === issuer, "principal_external_issuer");
  assert(typeof principal.externalIdentity.subject === "string", "principal_external_subject");
  assert(principal.externalIdentity.subject.length > 0, "principal_external_subject");
  assert(
    principal.externalIdentity.displayClaims?.displayName === "Kilgore Trout",
    "principal_display_name",
  );
  assert(
    principal.externalIdentity.displayClaims?.email === "kilgore@kilgore.trout",
    "principal_email",
  );
  assert(
    principal.externalIdentity.displayClaims?.emailVerified === true,
    "principal_email_verified",
  );
  if (expectedSubject !== undefined) {
    assert(principal.externalIdentity.subject === expectedSubject, "principal_subject_continuity");
  }
  if (expectedUserId !== undefined) {
    assert(principal.userId === expectedUserId, "principal_user_continuity");
  }
  return { subject: principal.externalIdentity.subject, userId: principal.userId };
}

async function waitForPendingPrincipal(
  request,
  issuer,
  expectedRole,
  expectedSubject,
  expectedUserId,
) {
  const deadline = Date.now() + SESSION_CONVERGENCE_TIMEOUT_MS;
  let lastFailureDetail = {};
  while (Date.now() < deadline) {
    try {
      const session = await currentSession(request);
      const identity = assertPendingPrincipal(
        session,
        issuer,
        expectedRole,
        expectedSubject,
        expectedUserId,
      );
      failureDetail = {};
      return { identity, session };
    } catch (error) {
      if (!(error instanceof BrowserCheckError)) throw error;
      lastFailureDetail = failureDetail;
      failureDetail = {};
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  failureDetail = lastFailureDetail;
  throw new BrowserCheckError();
}

async function waitForSessionCookie(context, webOrigin, previousValue) {
  const deadline = Date.now() + SESSION_CONVERGENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cookie = (await context.cookies(webOrigin)).find(
      (candidate) => candidate.name === SESSION_COOKIE_NAME,
    );
    if (
      cookie &&
      /^[A-Za-z0-9_-]{43}$/u.test(cookie.value) &&
      (previousValue === undefined || cookie.value !== previousValue)
    ) {
      failureDetail = {};
      return cookie.value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  failureDetail = { check: "session_cookie_replacement" };
  throw new BrowserCheckError();
}

async function run() {
  const webOrigin = required("OMNIFIN_FIXTURE_WEB_ORIGIN");
  const issuer = required("OMNIFIN_FIXTURE_OIDC_ISSUER");
  const issuerOrigin = new URL(issuer).origin;
  const clientId = required("OMNIFIN_FIXTURE_CLIENT_ID");
  const clientSecret = required("OMNIFIN_FIXTURE_CLIENT_SECRET");
  const recoverySecret = required("OMNIFIN_FIXTURE_RECOVERY_SECRET");
  assert(new URL(webOrigin).protocol === "https:");
  assert(new URL(issuer).protocol === "https:");

  const sensitiveValues = [clientSecret, recoverySecret];
  const observedBrowserText = [];
  const authorizationRequests = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL: webOrigin, ignoreHTTPSErrors: true });
    const administrationContext = await browser.newContext({
      baseURL: webOrigin,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on("console", (message) => observedBrowserText.push(message.text()));
    page.on("pageerror", () => observedBrowserText.push("browser_page_error"));
    page.on("request", (request) => {
      const requestUrl = request.url();
      observedBrowserText.push(requestUrl);
      try {
        const parsed = new URL(requestUrl);
        const issuerUrl = new URL(issuer);
        if (
          parsed.origin === issuerUrl.origin &&
          parsed.pathname === `${issuerUrl.pathname}/auth`
        ) {
          authorizationRequests.push(parsed);
        }
      } catch {
        // Playwright may expose non-HTTP browser URLs; they are irrelevant to OIDC negotiation.
      }
    });

    currentStage = "recovery_session";
    const recovery = await recoverySession(
      administrationContext.request,
      webOrigin,
      recoverySecret,
    );
    const providerInput = {
      allowJitProvisioning: true,
      approvedEndpointOrigins: [issuerOrigin],
      clientId,
      clientSecret,
      displayName: "Generic OIDC",
      enabled: false,
      idTokenSigningAlg: "RS256",
      issuer,
      scopes: ["openid", "profile", "email", "groups"],
      slug: providerSlug,
      tokenEndpointAuthMethod: "client_secret_basic",
    };

    currentStage = "provider_create";
    const created = await create(
      administrationContext.request,
      webOrigin,
      "/api/admin/auth/oidc/providers",
      recovery.csrfToken,
      providerInput,
    );
    assert(created.id === expectedProviderId);
    assert(created.enabled === false);

    currentStage = "provider_validate";
    const validation = await json(
      await administrationContext.request.post(
        `/api/admin/auth/oidc/providers/${expectedProviderId}/validate`,
        {
          headers: { origin: webOrigin, "x-omnifin-csrf": recovery.csrfToken },
          maxRedirects: 0,
        },
      ),
      200,
    );
    assert(validation.capabilities?.authorizationCodeFlow === true);
    assert(validation.capabilities?.pkceS256 === true);
    assert(validation.capabilities?.logout?.backChannel === false);
    assert(validation.capabilities?.logout?.rpInitiated === false);

    currentStage = "provider_enable";
    const enabled = await update(
      administrationContext.request,
      webOrigin,
      `/api/admin/auth/oidc/providers/${expectedProviderId}`,
      recovery.csrfToken,
      { ...providerInput, clientSecret: undefined, enabled: true },
    );
    assert(enabled.provider?.enabled === true);

    currentStage = "public_provider";
    const providers = await json(
      await administrationContext.request.get("/api/auth/providers", { maxRedirects: 0 }),
      200,
    );
    const publicProvider = providers.providers?.find(
      (provider) => provider.id === expectedProviderId,
    );
    assert(publicProvider?.state === "available");
    assert(publicProvider.supportsBackChannelLogout === false);
    assert(publicProvider.supportsRpInitiatedLogout === false);

    const startPath = `/api/auth/oidc/${expectedProviderId}/start`;
    currentStage = "viewer_login";
    await completeAuthorization(page, startPath, webOrigin, "viewer_login");
    currentStage = "viewer_session";
    const { identity: viewerIdentity } = await waitForPendingPrincipal(
      context.request,
      issuer,
      "viewer",
    );
    currentStage = "viewer_cookie";
    const viewerSessionCookie = await waitForSessionCookie(context, webOrigin);

    currentStage = "mapping_recovery_session";
    const mappingRecovery = await recoverySession(
      administrationContext.request,
      webOrigin,
      recoverySecret,
    );
    currentStage = "role_mapping";
    const mapping = await create(
      administrationContext.request,
      webOrigin,
      `/api/admin/auth/oidc/providers/${expectedProviderId}/role-mappings`,
      mappingRecovery.csrfToken,
      {
        claimPath: ["groups"],
        enabled: true,
        operator: "contains_any",
        priority: 1_000,
        role: "admin",
        values: ["authors"],
      },
    );
    assert(mapping.mapping?.providerId === expectedProviderId);

    currentStage = "mapped_login";
    await completeAuthorization(page, startPath, webOrigin, "mapped_login");
    currentStage = "mapped_cookie";
    await waitForSessionCookie(context, webOrigin, viewerSessionCookie);
    currentStage = "mapped_session";
    const { identity: mappedIdentity, session: mappedSession } = await waitForPendingPrincipal(
      context.request,
      issuer,
      "admin",
      viewerIdentity.subject,
      viewerIdentity.userId,
    );
    assert(mappedIdentity.userId === mappedSession.principal?.userId);

    currentStage = "authorization_code_pkce";
    assert(authorizationRequests.length >= 2);
    assert(
      authorizationRequests.every(
        (request) =>
          request.searchParams.get("response_type") === "code" &&
          request.searchParams.get("code_challenge_method") === "S256" &&
          /^[A-Za-z0-9_-]{43,128}$/u.test(request.searchParams.get("code_challenge") ?? "") &&
          request.searchParams.has("code_verifier") === false,
      ),
    );
    currentStage = "state_nonce_validation";
    const states = authorizationRequests.map((request) => request.searchParams.get("state"));
    const nonces = authorizationRequests.map((request) => request.searchParams.get("nonce"));
    assert(states.every((value) => /^[A-Za-z0-9_-]{43}$/u.test(value ?? "")));
    assert(nonces.every((value) => /^[A-Za-z0-9_-]{43}$/u.test(value ?? "")));
    assert(new Set(states).size === authorizationRequests.length);
    assert(new Set(nonces).size === authorizationRequests.length);

    currentStage = "discovery_logout";
    const discovery = await json(
      await context.request.get(`${issuer}/.well-known/openid-configuration`, {
        maxRedirects: 0,
      }),
      200,
    );
    assert(discovery.issuer === issuer);
    assert(discovery.end_session_endpoint === undefined);
    assert(discovery.backchannel_logout_supported !== true);

    currentStage = "local_logout_fallback";
    const logout = await context.request.post("/api/auth/oidc/logout", {
      form: { csrfToken: mappedSession.csrfToken },
      headers: { origin: webOrigin },
      maxRedirects: 0,
    });
    assert(logout.status() === 303);
    const logoutLocation = logout.headers().location;
    assert(typeof logoutLocation === "string");
    const localLogout = new URL(logoutLocation, webOrigin);
    assert(localLogout.origin === webOrigin);
    assert(localLogout.pathname === "/login");
    assert(localLogout.searchParams.get("loggedOut") === "1");

    currentStage = "local_session_revocation";
    await waitForLocalRevocation(context.request);

    currentStage = "secret_leak_inspection";
    assert(
      !sensitiveValues.some((secret) =>
        observedBrowserText.some((observation) => observation.includes(secret)),
      ),
    );
    await Promise.all([context.close(), administrationContext.close()]);
  } finally {
    await browser.close();
  }
}

try {
  await run();
  process.stdout.write('{"event":"oidc_provider_browser_checks_passed"}\n');
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "oidc_provider_browser_checks_failed", stage: currentStage, ...failureDetail })}\n`,
  );
  process.exitCode = 1;
}
