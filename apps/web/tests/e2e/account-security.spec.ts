import { expect, test } from "@playwright/test";

const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const link = {
  displayName: "Riley",
  externalUserId: "jellyfin-user-1",
  health: "linked",
  id: "jellyfin-link-1",
  lastVerifiedAt: "2026-07-26T12:00:00.000Z",
  linkedAt: "2026-07-25T12:00:00.000Z",
  service: "jellyfin",
  username: "riley",
} as const;
const principal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Riley Morgan",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [link],
  permissions: ["media.view", "playback.use", "identities.self.manage", "sessions.self.revoke"],
  role: "viewer",
  sessionId: "session-1",
  userId: "user-1",
} as const;

test("OIDC pairing sends fresh proof through the CSRF-protected link endpoint", async ({
  page,
}) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken,
        principal: { ...principal, accountState: "pending_link", linkedServices: [] },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  let pairingBody = "";
  let pairingCsrf = "";
  await page.route("**/api/auth/jellyfin/link/password", async (route) => {
    pairingBody = route.request().postData() ?? "";
    pairingCsrf = route.request().headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/link/jellyfin?test-view=live-session");
  await page.getByRole("textbox", { name: "Username" }).fill("riley");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("private-password");
  await page.getByRole("button", { name: "Link Jellyfin account" }).click();

  await expect(page).toHaveURL("/");
  expect(pairingCsrf).toBe(csrfToken);
  expect(JSON.parse(pairingBody)).toEqual({ password: "private-password", username: "riley" });
  await expect(page.locator("body")).not.toContainText("private-password");
});

test("account settings confirms revocation and sends no request body", async ({ page }) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken, principal }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/auth/identity-links", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ links: [link] }),
      contentType: "application/json",
      status: 200,
    });
  });
  let revocationBody: string | null = "unexpected";
  let revocationCsrf = "";
  await page.route("**/api/auth/identity-links/jellyfin-link-1", async (route) => {
    revocationBody = route.request().postData();
    revocationCsrf = route.request().headers()["x-omnifin-csrf"] ?? "";
    await route.fulfill({
      body: JSON.stringify({
        link: { ...link, health: "revoked" },
        principal: {
          ...principal,
          accountState: "pending_link",
          linkedServices: [],
          permissions: ["identities.self.manage", "sessions.self.revoke"],
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("group", { name: "Confirm disconnect" })).toContainText(
    "saved token is erased",
  );
  await page.getByRole("button", { name: "Disconnect Jellyfin" }).click();

  await expect(page.getByText("Disconnected")).toBeVisible();
  expect(revocationBody).toBeNull();
  expect(revocationCsrf).toBe(csrfToken);
  await expect(page.getByRole("link", { name: "Link account" })).toHaveAttribute(
    "href",
    "/link/jellyfin",
  );
});
