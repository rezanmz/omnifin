import { expect, test, type Page } from "@playwright/test";

const csrfToken = "e2e_connector_admin_csrf_0123456789abcdefgh";
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
const jellyfin = {
  baseUrl: "https://jellyfin.example.test",
  createdAt: "2026-07-25T12:00:00.000Z",
  credentialKind: "none",
  credentialsConfigured: true,
  displayName: "Living Room Jellyfin",
  enabled: false,
  healthState: "unknown",
  id: "jellyfin-primary",
  insecureHttpApproved: false,
  lastProbe: null,
  revision: "revision_0123456789abcdef",
  service: "jellyfin",
  tlsCaCertificateConfigured: false,
  tlsPolicy: "strict",
  updatedAt: "2026-07-26T12:00:00.000Z",
} as const;
const healthyJellyfin = {
  ...jellyfin,
  healthState: "healthy",
  lastProbe: {
    capabilities: ["connector.health", "connector.version", "media.playback"],
    checkedAt: "2026-07-26T12:01:00.000Z",
    connectorId: jellyfin.id,
    displayName: jellyfin.displayName,
    failure: null,
    latencyMs: 18,
    service: "jellyfin",
    status: "healthy",
    version: "10.10.7",
  },
  revision: "revision_healthy1234567890",
} as const;
const radarr = {
  ...jellyfin,
  baseUrl: "https://radarr.example.test",
  credentialKind: "api_key",
  displayName: "Radarr",
  healthState: "healthy",
  id: "radarr-primary",
  lastProbe: {
    capabilities: ["connector.health", "acquisition.search"],
    checkedAt: "2026-07-26T12:00:00.000Z",
    connectorId: "radarr-primary",
    displayName: "Radarr",
    failure: null,
    latencyMs: 22,
    service: "radarr",
    status: "healthy",
    version: "5.27.5",
  },
  revision: "revision_1234567890abcdef",
  service: "radarr",
} as const;

async function mockAdministrationReads(page: Page, connectors: readonly unknown[]) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/admin/connectors?*", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ items: connectors, nextCursor: null }),
      contentType: "application/json",
      status: 200,
    });
  });
}

test("probes with CSRF proof before enabling the returned connector revision", async ({ page }) => {
  await mockAdministrationReads(page, [jellyfin]);
  let probeRequest: { body: string | null; csrf: string; method: string } | undefined;
  await page.route(`**/api/admin/connectors/${jellyfin.id}/probe`, async (route) => {
    const request = route.request();
    probeRequest = {
      body: request.postData(),
      csrf: request.headers()["x-omnifin-csrf"] ?? "",
      method: request.method(),
    };
    await route.fulfill({
      body: JSON.stringify({ connector: healthyJellyfin }),
      contentType: "application/json",
      status: 200,
    });
  });
  let enableBody: Record<string, unknown> | undefined;
  let enableCsrf = "";
  await page.route(`**/api/admin/connectors/${jellyfin.id}`, async (route) => {
    const request = route.request();
    enableBody = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    enableCsrf = request.headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({ connector: { ...healthyJellyfin, enabled: true } }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings/connectors");
  await expect(page.getByRole("button", { name: "Bring online" })).toBeDisabled();
  await page.getByRole("button", { name: "Probe signal" }).click();
  await expect(page.getByRole("button", { name: "Bring online" })).toBeEnabled();
  await page.getByRole("button", { name: "Bring online" }).click();

  await expect(page.getByRole("status")).toContainText("is online");
  expect(probeRequest).toEqual({ body: null, csrf: csrfToken, method: "POST" });
  expect(enableCsrf).toBe(csrfToken);
  expect(enableBody).toEqual({ enabled: true, revision: healthyJellyfin.revision });
});

test("retains sealed service credentials while editing public connector fields", async ({
  page,
}) => {
  await mockAdministrationReads(page, [radarr]);
  let updateBody: Record<string, unknown> | undefined;
  let updateCsrf = "";
  await page.route(`**/api/admin/connectors/${radarr.id}`, async (route) => {
    const request = route.request();
    updateBody = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    updateCsrf = request.headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({
        connector: { ...radarr, ...updateBody, displayName: "Cinema Radarr" },
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings/connectors");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "API key" })).toHaveValue("");
  await page.getByRole("textbox", { name: "Display name" }).fill("Cinema Radarr");
  await page.getByRole("button", { name: "Save and re-probe" }).click();

  await expect(page.getByRole("status")).toContainText("Configuration saved");
  expect(updateCsrf).toBe(csrfToken);
  expect(updateBody).toMatchObject({ displayName: "Cinema Radarr", revision: radarr.revision });
  expect(updateBody).not.toHaveProperty("credentials");
});

test("sends a new API key to the gateway once and never renders it back", async ({ page }) => {
  await mockAdministrationReads(page, []);
  const privateApiKey = "private-radarr-api-key";
  let createBody: Record<string, unknown> | undefined;
  let createCsrf = "";
  await page.route("**/api/admin/connectors", async (route) => {
    const request = route.request();
    createBody = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    createCsrf = request.headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({ connector: radarr }),
      contentType: "application/json",
      status: 201,
    });
  });

  await page.goto("/settings/connectors");
  await page.getByRole("button", { name: "Radarr", exact: true }).click();
  await page.getByRole("textbox", { name: "Service URL" }).fill(radarr.baseUrl);
  await page.getByRole("textbox", { name: "API key" }).fill(privateApiKey);
  await page.getByRole("button", { name: "Save disabled connector" }).click();

  await expect(page.getByRole("heading", { name: "Radarr" })).toBeVisible();
  expect(createCsrf).toBe(csrfToken);
  expect(createBody).toMatchObject({
    credentials: { apiKey: privateApiKey, kind: "api_key" },
    service: "radarr",
  });
  await expect(page.locator("body")).not.toContainText(privateApiKey);
});
