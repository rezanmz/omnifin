import { test } from "@playwright/test";
import { expectRouteAccessible } from "../fixtures/route-accessibility";

const responsiveBrowserName = process.platform === "darwin" ? "chromium" : "webkit";

const routes = [
  { label: "configured dashboard", path: "/" },
  { label: "setup readiness guide", path: "/onboarding?test-view=partial" },
  { label: "user access administration", path: "/settings/users?test-view=ready" },
  { label: "acquisition calendar", path: "/calendar?test-view=ready" },
  { label: "viewer library", path: "/library?test-view=ready" },
  { label: "library care", path: "/operations/library?test-view=ready" },
] as const;
test.skip(
  ({ browserName }) => browserName !== responsiveBrowserName,
  "Responsive routes cover the mobile and tablet browser engines",
);

for (const route of routes) {
  test(`${route.label} has no automatically detectable accessibility violations`, async ({
    page,
  }) => {
    await expectRouteAccessible(page, route.path);
  });
}
