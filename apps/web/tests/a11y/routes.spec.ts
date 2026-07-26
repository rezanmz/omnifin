import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const supportedProjects = new Set(["chromium", "mobile", "tablet", "ten-foot"]);
const routes = [
  { label: "configured dashboard", path: "/" },
  { label: "first-run dashboard", path: "/?test-view=onboarding" },
  { label: "configured login", path: "/login" },
  { label: "unconfigured login", path: "/login?test-view=unconfigured" },
  { label: "unavailable login", path: "/login?test-view=unavailable" },
  { label: "login authentication error", path: "/login?authError=invalid_request" },
  { label: "Jellyfin credential login", path: "/login/jellyfin" },
  { label: "Jellyfin Quick Connect", path: "/login/jellyfin?test-view=quick-connect" },
  { label: "Jellyfin account pairing", path: "/link/jellyfin" },
  { label: "Jellyfin pairing session expired", path: "/link/jellyfin?test-view=session-expired" },
  { label: "Jellyfin Quick Connect pairing", path: "/link/jellyfin?test-view=quick-connect" },
  { label: "account security", path: "/settings" },
  {
    label: "identity provider administration",
    path: "/settings/identity-providers?test-view=ready",
  },
  {
    label: "identity provider onboarding",
    path: "/settings/identity-providers?test-view=empty",
  },
  {
    label: "restricted identity provider administration",
    path: "/settings/identity-providers?test-view=forbidden",
  },
  {
    label: "Jellyfin credential denial",
    path: "/login/jellyfin?test-view=invalid-credentials",
  },
  { label: "loading dashboard", path: "/?test-view=loading" },
  { label: "quiet dashboard", path: "/?test-view=quiet" },
  { label: "offline dashboard", path: "/?test-view=offline" },
  { label: "terminal dashboard error", path: "/?test-view=terminal-error" },
] as const;

for (const route of routes) {
  test(`${route.label} has no automatically detectable accessibility violations`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !supportedProjects.has(testInfo.project.name),
      "Covered by representative Chromium viewports",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(route.path);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
