import { expect, test, type Page } from "@playwright/test";

const csrfToken = "e2e_audit_trail_csrf_0123456789abcdefghijklmnop";
const principal = {
  absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-08-02T15:00:00.000Z",
  issuedAt: "2026-08-02T13:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-08-02T13:55:00.000Z",
      linkedAt: "2026-07-30T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
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
  sessionId: "e2e-audit-admin-session",
  userId: "admin-user",
} as const;
const cursor = `audit_cursor_v2.${"A".repeat(16)}.${"B".repeat(32)}.${"C".repeat(22)}`;
const initialPage = {
  events: [
    {
      actor: { authenticationMethod: "jellyfin", displayName: "Administration", kind: "user" },
      category: "configuration",
      eventType: "connector.configuration.updated",
      id: "audit_0123456789abcdefghijkl",
      occurredAt: "2026-08-02T13:58:00.000Z",
      outcome: "success",
    },
    {
      actor: { authenticationMethod: "recovery", displayName: "Recovery access", kind: "recovery" },
      category: "authentication",
      eventType: "auth.admin.bootstrap_attempt",
      id: "audit_123456789abcdefghijkl0",
      occurredAt: "2026-08-02T12:42:00.000Z",
      outcome: "denied",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: cursor,
};
const earlierPage = {
  events: [
    {
      actor: { authenticationMethod: null, displayName: "Omnifin", kind: "system" },
      category: "library",
      eventType: "library.scan.requested",
      id: "audit_23456789abcdefghijkl01",
      occurredAt: "2026-08-01T22:10:00.000Z",
      outcome: "success",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: null,
};

async function mockAuditTrail(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/admin/audit-events**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const body = url.searchParams.has("cursor")
      ? earlierPage
      : url.searchParams.get("category") === "access"
        ? { events: [], generatedAt: initialPage.generatedAt, nextCursor: null }
        : initialPage;
    await route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      status: 200,
    });
  });
  return requests;
}

test("filters and extends a privacy-safe snapshot without exposing cursor material", async ({
  page,
}) => {
  const requests = await mockAuditTrail(page);
  await page.goto("/settings/audit");
  await page.getByLabel("Loading operator audit trail").waitFor({ state: "hidden" });
  await expect(page.getByRole("heading", { name: "Service configuration updated" })).toBeVisible();
  await expect(page.getByText("2 recorded events")).toBeVisible();
  await expect(page.getByText(cursor)).toHaveCount(0);

  await page.getByRole("button", { name: "Load earlier events" }).click();
  await expect(page.getByRole("heading", { name: "Library scan requested" })).toBeVisible();
  await expect(page.getByText("3 recorded events")).toBeVisible();
  expect(requests.at(-1)).toContain(`cursor=${encodeURIComponent(cursor)}`);

  await page.getByRole("combobox", { name: "Event category" }).selectOption("access");
  await page.getByRole("button", { name: "Denied events" }).click();
  await expect(page.getByRole("heading", { name: "No events match this view." })).toBeVisible();
  expect(requests.at(-1)).toBe("/api/admin/audit-events?category=access&limit=25&outcome=denied");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("heading", { name: "Service configuration updated" })).toBeVisible();
});
