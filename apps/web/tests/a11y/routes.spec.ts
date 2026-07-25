import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const supportedProjects = new Set(["chromium", "mobile", "tablet", "ten-foot"]);
const routes = [
  { label: "configured dashboard", path: "/" },
  { label: "first-run dashboard", path: "/?test-view=onboarding" },
  { label: "configured login", path: "/login" },
  { label: "unconfigured login", path: "/login?test-view=unconfigured" },
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
    await page.goto(route.path);
    await page.locator("main").waitFor();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
