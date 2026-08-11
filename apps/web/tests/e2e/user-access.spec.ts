import { expect, test, type Page } from "@playwright/test";

const csrfToken = "e2e_user_access_csrf_0123456789abcdefghijklmnop";
const principal = {
  absoluteExpiresAt: "2026-07-31T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-30T13:00:00.000Z",
  issuedAt: "2026-07-30T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-07-30T12:00:00.000Z",
      linkedAt: "2026-07-28T12:00:00.000Z",
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
  sessionId: "e2e-admin-session",
  userId: "admin-user",
} as const;
const admin = {
  activeSessions: 1,
  authenticationMethods: ["jellyfin"],
  createdAt: "2026-07-28T12:00:00.000Z",
  displayName: "Administration",
  id: "admin-user",
  jellyfinLinkHealth: "linked",
  lastActiveAt: "2026-07-30T12:00:00.000Z",
  role: "admin",
  roleSource: "manual",
  status: "active",
  updatedAt: "2026-07-30T12:00:00.000Z",
} as const;
const viewer = {
  activeSessions: 2,
  authenticationMethods: ["jellyfin"],
  createdAt: "2026-07-29T12:00:00.000Z",
  displayName: "Morgan Lee",
  id: "user-morgan",
  jellyfinLinkHealth: "linked",
  lastActiveAt: "2026-07-30T11:30:00.000Z",
  role: "viewer",
  roleSource: "default",
  status: "active",
  updatedAt: "2026-07-30T11:30:00.000Z",
} as const;
const oidcViewer = {
  ...viewer,
  authenticationMethods: ["oidc"],
  displayName: "OIDC Morgan",
  id: "oidc-morgan",
  jellyfinLinkHealth: null,
  roleSource: "default",
} as const;

async function mockAdministrationReads(page: Page, users: readonly object[] = [admin, viewer]) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/admin/users", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ nextCursor: null, users }),
      contentType: "application/json",
      status: 200,
    });
  });
}

test("reviews authority impact before applying a CSRF-bound optimistic update", async ({
  page,
}) => {
  await mockAdministrationReads(page);
  let mutation: { body: Record<string, unknown>; csrf: string; method: string } | undefined;
  await page.route(`**/api/admin/users/${viewer.id}`, async (route) => {
    const request = route.request();
    mutation = {
      body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
      csrf: request.headers()["x-omnifin-csrf"] ?? "",
      method: request.method(),
    };
    await route.fulfill({
      body: JSON.stringify({
        revokedSessions: 2,
        user: {
          ...viewer,
          activeSessions: 0,
          role: "operator",
          roleSource: "manual",
          updatedAt: "2026-07-30T12:01:00.000Z",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings/users");
  await page.getByRole("button", { name: /Morgan Lee/i }).click();
  await page.getByRole("button", { name: /operator.*Manage requests/i }).click();
  await expect(page.getByRole("region", { name: "Review access change" })).toContainText(
    "viewer → operator",
  );
  await expect(page.getByRole("region", { name: "Review access change" })).toContainText(
    "2 active sessions will close",
  );
  await page.getByRole("button", { name: "Apply & revoke sessions" }).click();

  await expect(page.getByRole("status")).toContainText("2 active sessions closed");
  expect(mutation).toEqual({
    body: { expectedUpdatedAt: viewer.updatedAt, role: "operator" },
    csrf: csrfToken,
    method: "PATCH",
  });
  await expect(
    page.locator("article").getByText("Open sessions", { exact: true }).locator(".."),
  ).toContainText("0");
});

test("assigns an OIDC individual fallback without exposing identity subjects", async ({ page }) => {
  await mockAdministrationReads(page, [admin, oidcViewer]);
  let assignment: { body: Record<string, unknown>; csrf: string; method: string } | undefined;
  await page.route(`**/api/admin/users/${oidcViewer.id}/oidc-role-assignment`, async (route) => {
    const request = route.request();
    assignment = {
      body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
      csrf: request.headers()["x-omnifin-csrf"] ?? "",
      method: request.method(),
    };
    await route.fulfill({
      body: JSON.stringify({
        effectiveAfter: "next_oidc_sign_in",
        fallbackPrecedence: "lowest",
        mappingId: "mapping-oidc-morgan",
        priority: 0,
        revokedSessions: 2,
        role: "operator",
      }),
      contentType: "application/json",
      status: 201,
    });
  });

  await page.goto("/settings/users");
  await page.getByRole("button", { name: /OIDC Morgan/i }).click();
  await page.getByRole("button", { name: "Assign individual provider role" }).click();
  const wizard = page.locator('section[aria-labelledby="oidc-role-assignment-title"]');
  await wizard.getByRole("button", { name: /operator.*Manage requests/i }).click();
  await wizard.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("region", { name: "Review role assignment" })).toContainText(
    "next OIDC sign-in",
  );
  await page.getByRole("button", { name: "Apply provider role" }).click();

  await expect
    .poll(() => assignment)
    .toEqual({
      body: { expectedUpdatedAt: oidcViewer.updatedAt, role: "operator" },
      csrf: csrfToken,
      method: "POST",
    });
  await expect(page.getByRole("status")).toContainText("next OIDC sign-in");
  await expect(page.locator("body")).not.toContainText("providerId");
  await expect(page.locator("body")).not.toContainText("subject");
});
