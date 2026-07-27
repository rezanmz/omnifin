import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockDiscoverySearch } from "../fixtures/discovery";
import { mockMediaRequestSession } from "../fixtures/media-request";

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
    label: "service connection control room",
    path: "/settings/connectors?test-view=ready",
  },
  {
    label: "service connection onboarding",
    path: "/settings/connectors?test-view=empty",
  },
  {
    label: "degraded service connection",
    path: "/settings/connectors?test-view=degraded",
  },
  {
    label: "Jellyfin recovery connection boundary",
    path: "/settings/connectors?test-view=recovery",
  },
  {
    label: "restricted service connection administration",
    path: "/settings/connectors?test-view=forbidden",
  },
  {
    label: "indexer intelligence",
    path: "/operations/indexers?test-view=ready",
  },
  {
    label: "empty indexer intelligence",
    path: "/operations/indexers?test-view=empty",
  },
  {
    label: "degraded indexer intelligence",
    path: "/operations/indexers?test-view=degraded",
  },
  {
    label: "restricted indexer intelligence",
    path: "/operations/indexers?test-view=forbidden",
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

test("open discovery search has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDiscoverySearch(page);
  await page.goto("/");
  await page.getByRole("combobox").fill("matrix");
  await expect(page.getByRole("option", { name: /The Matrix/i })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("request composer has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDiscoverySearch(page);
  await mockMediaRequestSession(page);
  await page.goto("/");
  await page.getByRole("combobox").fill("matrix");
  await page.getByRole("button", { name: "Request The Matrix" }).click();
  await expect(page.getByRole("dialog", { name: "Compose request" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("acquisition timeline has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  await expect(page.getByRole("dialog", { name: "Signal history" })).toBeVisible();
  await page.getByRole("button", { name: "Review search" }).click();
  await expect(page.getByRole("button", { name: "Queue search" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("open profile appearance controls have no automatically detectable accessibility violations", async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Profile controls use desktop Chromium");
  await context.addCookies([
    {
      name: "omnifin-theme",
      sameSite: "Lax",
      url: "http://127.0.0.1:3000",
      value: "light",
    },
  ]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open profile menu" }).click();
  await expect(page.getByRole("dialog", { name: "Profile and appearance" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const route of [
  { label: "dashboard", path: "/" },
  { label: "login", path: "/login" },
  { label: "account appearance", path: "/settings" },
  {
    label: "identity provider control room",
    path: "/settings/identity-providers?test-view=ready",
  },
  { label: "service control room", path: "/settings/connectors?test-view=ready" },
  { label: "indexer intelligence", path: "/operations/indexers?test-view=ready" },
] as const) {
  test(`${route.label} light theme has no automatically detectable accessibility violations`, async ({
    context,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Light-theme audit uses desktop Chromium");
    await context.addCookies([
      {
        name: "omnifin-theme",
        sameSite: "Lax",
        url: "http://127.0.0.1:3000",
        value: "light",
      },
    ]);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto(route.path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
