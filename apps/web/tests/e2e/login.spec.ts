import { expect, test } from "@playwright/test";

test("login exposes OIDC and Jellyfin without implying account matching", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome to your control room." })).toBeVisible();
  await expect(page.getByRole("link", { name: /Continue with Authentik/i })).toHaveAttribute(
    "href",
    "/api/auth/oidc/authentik/start",
  );
  await expect(page.getByRole("link", { name: /Continue with Jellyfin/i })).toHaveAttribute(
    "href",
    "/login/jellyfin",
  );
});

test("production-first login explains an unconfigured identity boundary", async ({ page }) => {
  await page.goto("/login?test-view=unconfigured");

  await expect(page.getByRole("status")).toContainText("Sign-in arrives in Phase 1");
  await expect(page.getByRole("link", { name: /Continue with/i })).toHaveCount(0);
});
