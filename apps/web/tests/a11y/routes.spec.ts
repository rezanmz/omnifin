import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockDiscoveryDetails, mockDiscoverySearch } from "../fixtures/discovery";
import { mockMediaRequestSession } from "../fixtures/media-request";
import {
  mockManualReleaseSearch,
  mockManualReleaseSession,
  openManualReleaseWorkbench,
} from "../fixtures/manual-release";

const supportedProjects = new Set(["chromium", "mobile", "tablet", "ten-foot"]);
const routes = [
  { label: "configured dashboard", path: "/" },
  { label: "signed-out live dashboard", path: "/?test-view=continue-watching-live" },
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
    label: "system health",
    path: "/operations/health?test-view=ready",
  },
  {
    label: "degraded system health",
    path: "/operations/health?test-view=degraded",
  },
  {
    label: "system health onboarding",
    path: "/operations/health?test-view=unconfigured",
  },
  {
    label: "restricted system health",
    path: "/operations/health?test-view=forbidden",
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
    label: "download queue",
    path: "/operations/downloads?test-view=ready",
  },
  {
    label: "empty download queue",
    path: "/operations/downloads?test-view=empty",
  },
  {
    label: "degraded download queue",
    path: "/operations/downloads?test-view=degraded",
  },
  {
    label: "download client onboarding",
    path: "/operations/downloads?test-view=unconfigured",
  },
  {
    label: "request review",
    path: "/operations/requests?test-view=ready",
  },
  {
    label: "empty request review",
    path: "/operations/requests?test-view=empty",
  },
  {
    label: "unavailable request review",
    path: "/operations/requests?test-view=unavailable",
  },
  {
    label: "restricted request review",
    path: "/operations/requests?test-view=forbidden",
  },
  {
    label: "media issue workbench",
    path: "/operations/issues?test-view=ready",
  },
  {
    label: "empty media issue workbench",
    path: "/operations/issues?test-view=empty",
  },
  {
    label: "degraded media issue workbench",
    path: "/operations/issues?test-view=degraded",
  },
  {
    label: "restricted media issue workbench",
    path: "/operations/issues?test-view=forbidden",
  },
  {
    label: "acquisition calendar",
    path: "/calendar?test-view=ready",
  },
  {
    label: "empty acquisition calendar",
    path: "/calendar?test-view=empty",
  },
  {
    label: "degraded acquisition calendar",
    path: "/calendar?test-view=degraded",
  },
  {
    label: "acquisition calendar onboarding",
    path: "/calendar?test-view=unconfigured",
  },
  {
    label: "library care",
    path: "/library?test-view=ready",
  },
  {
    label: "empty library care",
    path: "/library?test-view=empty",
  },
  {
    label: "unavailable library care",
    path: "/library?test-view=unavailable",
  },
  {
    label: "restricted library care",
    path: "/library?test-view=forbidden",
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

test("media detail drawer has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDiscoverySearch(page);
  await mockDiscoveryDetails(page);
  await page.goto("/");
  await page.getByRole("combobox").fill("matrix");
  await page.getByRole("button", { name: "View details for The Matrix" }).click();
  await expect(page.getByRole("dialog", { name: "The Matrix details" })).toBeVisible();
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

test("acquisition monitoring confirmation has no automatically detectable accessibility violations", async ({
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
  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await timeline.getByRole("button", { name: "Pause monitoring for The Far Meridian" }).click();
  await expect(timeline.getByRole("button", { name: "Cancel" })).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("manual release review has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockManualReleaseSession(page);
  await mockManualReleaseSearch(page);
  const workbench = await openManualReleaseWorkbench(page);
  await workbench.getByRole("radio", { name: /1080p\.WEB-DL/u }).click();
  await workbench.getByRole("button", { name: "Review grab" }).click();
  await expect(workbench.getByRole("button", { name: "Send release" })).toBeDisabled();
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

test("calendar event details have no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/calendar?test-view=ready");
  await page.getByRole("button", { name: /Inspect The Far Meridian/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("library item inspector has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Covered by representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/library?test-view=ready");
  await page.getByRole("button", { name: "Inspect Northern Lights" }).click();
  await expect(page.getByRole("button", { name: "Close library inspector" })).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("request approval confirmation has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Request decisions cover representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/operations/requests?test-view=ready");
  const card = page.getByText("A House of Dynamite").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog", { name: "Send this into acquisition?" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("issue resolution confirmation has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !supportedProjects.has(testInfo.project.name),
    "Issue decisions cover representative Chromium viewports",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/operations/issues?test-view=ready");
  const card = page.getByText("Northern Lights").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
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
  { label: "system health", path: "/operations/health?test-view=ready" },
  { label: "indexer intelligence", path: "/operations/indexers?test-view=ready" },
  { label: "download queue", path: "/operations/downloads?test-view=ready" },
  { label: "media issue workbench", path: "/operations/issues?test-view=ready" },
  { label: "acquisition calendar", path: "/calendar?test-view=ready" },
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
