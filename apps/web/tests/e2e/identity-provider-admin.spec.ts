import { expect, test, type Page } from "@playwright/test";

const csrfToken = "e2e_identity_provider_csrf_0123456789abcdefgh";
const provider = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://identity.example.test"],
  clientId: "omnifin-web",
  clientSecretConfigured: true,
  createdAt: "2026-07-25T12:00:00.000Z",
  discoveryCheckedAt: "2026-07-26T12:00:00.000Z",
  discoveryState: "ready",
  displayName: "Authentik",
  enabled: false,
  id: "oidc-authentik",
  idTokenSigningAlg: "RS256",
  issuer: "https://identity.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email", "groups"],
  slug: "authentik",
  tokenEndpointAuthMethod: "client_secret_basic",
  updatedAt: "2026-07-26T12:00:00.000Z",
} as const;
const principal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin-1",
      health: "linked",
      id: "jellyfin-link-admin",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin",
      username: "admin",
    },
  ],
  permissions: [
    "media.view",
    "playback.use",
    "request.create",
    "request.review",
    "acquisition.manage",
    "downloads.manage",
    "library.manage",
    "issue.manage",
    "connectors.manage",
    "identities.manage",
    "identities.self.manage",
    "roles.manage",
    "audit.view",
    "sessions.revoke",
    "sessions.self.revoke",
    "recovery.oidc.manage",
    "recovery.jellyfin.manage",
    "recovery.sessions.revoke",
  ],
  role: "admin",
  sessionId: "e2e-admin-session",
  userId: "e2e-admin-user",
} as const;

async function mockAdministrationReads(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/admin/auth/oidc/providers", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ providers: [provider] }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(
    `**/api/admin/auth/oidc/providers/${provider.id}/role-mappings`,
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ mappings: [] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
}

test("validates OIDC capabilities with an in-memory CSRF proof and no request body", async ({
  page,
}) => {
  await mockAdministrationReads(page);
  let validationRequest: { body: string | null; csrf: string; method: string } | undefined;
  await page.route(`**/api/admin/auth/oidc/providers/${provider.id}/validate`, async (route) => {
    const request = route.request();
    validationRequest = {
      body: request.postData(),
      csrf: request.headers()["x-omnifin-csrf"] ?? "",
      method: request.method(),
    };
    await route.fulfill({
      body: JSON.stringify({
        capabilities: {
          authorizationCodeFlow: true,
          idTokenSigningAlg: "RS256",
          logout: {
            backChannel: true,
            backChannelSession: true,
            frontChannel: true,
            frontChannelSession: true,
            rpInitiated: true,
          },
          pkceS256: true,
          schemaVersion: 1,
          tokenEndpointAuthMethod: "client_secret_basic",
          userInfo: true,
        },
        provider,
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings/identity-providers");
  await page.getByRole("button", { name: "Validate now" }).click();

  await expect(page.getByLabel("Validated OIDC capabilities")).toContainText("PKCE S256");
  expect(validationRequest).toEqual({ body: null, csrf: csrfToken, method: "POST" });
});

test("retains the sealed client secret while editing public provider fields", async ({ page }) => {
  await mockAdministrationReads(page);
  let updateBody: Record<string, unknown> | undefined;
  let updateCsrf = "";
  await page.route(`**/api/admin/auth/oidc/providers/${provider.id}`, async (route) => {
    const request = route.request();
    updateBody = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    updateCsrf = request.headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({
        provider: { ...provider, ...updateBody, displayName: "Authentik Home" },
        revokedSessions: 2,
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings/identity-providers");
  await page.getByRole("button", { name: "Edit configuration" }).click();
  await page.getByRole("textbox", { name: "Display name" }).fill("Authentik Home");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("textbox", { name: /^Client secret/ })).toHaveValue("");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save configuration" }).click();

  await expect(page.getByRole("status")).toContainText("2 OIDC sessions closed");
  expect(updateCsrf).toBe(csrfToken);
  expect(updateBody).toMatchObject({ displayName: "Authentik Home", enabled: false });
  expect(updateBody).not.toHaveProperty("clientSecret");
});
