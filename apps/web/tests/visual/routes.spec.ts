import { expect, test, type Page } from "@playwright/test";
import { mockDiscoverySearch } from "../fixtures/discovery";
import { mockMediaRequestSession } from "../fixtures/media-request";
import {
  mockManualReleaseSearch,
  mockManualReleaseSession,
  openManualReleaseWorkbench,
} from "../fixtures/manual-release";

const visualProjects = new Set(["chromium", "mobile", "tablet", "ten-foot"]);
const stateVisualProjects = new Set(["chromium", "mobile"]);
const lightVisualProjects = new Set(["chromium", "mobile"]);

test.use({ contextOptions: { reducedMotion: "reduce" } });

function routeForProject(path: string, projectName: string) {
  if (projectName !== "ten-foot") return path;
  const url = new URL(path, "http://omnifin.test");
  url.searchParams.set("test-profile", "ten-foot");
  return `${url.pathname}${url.search}`;
}

async function mockAccountSecurity(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: "visual_account_csrf_token_0123456789abcdefghij",
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "oidc", providerId: "authentik" },
          displayName: "Riley Morgan",
          linkedServices: [],
          permissions: [
            "media.view",
            "playback.use",
            "identities.self.manage",
            "sessions.self.revoke",
          ],
          role: "viewer",
          sessionId: "visual-session",
          userId: "visual-user",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/auth/identity-links", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        links: [
          {
            displayName: "Riley",
            externalUserId: "jellyfin-user-1",
            health: "linked",
            id: "jellyfin-link-1",
            lastVerifiedAt: "2026-07-26T12:00:00.000Z",
            linkedAt: "2026-07-25T12:00:00.000Z",
            service: "jellyfin",
            username: "riley",
          },
        ],
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

async function useLightTheme(page: Page) {
  await page.context().addCookies([
    {
      name: "omnifin-theme",
      sameSite: "Lax",
      url: "http://127.0.0.1:3000",
      value: "light",
    },
  ]);
}

async function removeDevelopmentIndicator(page: Page) {
  await page.locator("nextjs-portal").evaluateAll((portals) => {
    for (const portal of portals) portal.remove();
  });
}

test("dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true });
});

test("light dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light theme covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-light.png", { fullPage: true });
});

test("light profile controls visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Light theme uses desktop Chromium");
  await useLightTheme(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open profile menu" }).click();
  await expect(page.getByRole("dialog", { name: "Profile and appearance" })).toBeVisible();
  await expect(page).toHaveScreenshot("dashboard-profile-menu-light.png", { fullPage: true });
});

test("open discovery search visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Open discovery covers representative desktop and phone geometry",
  );
  await mockDiscoverySearch(page);
  await page.goto("/");
  const search = page.getByRole("combobox");
  await search.click();
  await search.fill("matrix");
  await page.getByRole("option", { name: /The Matrix/i }).waitFor();
  await expect(page).toHaveScreenshot("dashboard-discovery-search.png", { fullPage: true });
});

async function openRequestComposer(page: Page) {
  await mockDiscoverySearch(page);
  await mockMediaRequestSession(page);
  await page.goto("/");
  const search = page.getByRole("combobox");
  await search.click();
  await search.fill("matrix");
  const requestAction = page.getByRole("button", { name: "Request The Matrix" });
  await requestAction.waitFor();
  await requestAction.click();
  await expect(page.getByRole("dialog", { name: "Compose request" })).toBeVisible();
}

test("request composer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Request composition covers representative desktop and phone geometry",
  );
  await openRequestComposer(page);
  await expect(page).toHaveScreenshot("dashboard-request-composer.png", { fullPage: true });
});

test("light request composer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light request composition covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await openRequestComposer(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-request-composer-light.png", {
    fullPage: true,
  });
});

test("first-run dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/?test-view=onboarding", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("dashboard-onboarding.png", { fullPage: true });
});

test("login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("login.png", { fullPage: true });
});

test("light login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light theme covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("login-light.png", { fullPage: true });
});

test("Jellyfin credential login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login/jellyfin", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login.png", { fullPage: true });
});

test("light Jellyfin credential login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light theme covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/login/jellyfin");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("jellyfin-login-light.png", { fullPage: true });
});

test("Jellyfin credential denial visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Credential errors cover representative desktop and phone geometry",
  );
  await page.goto("/login/jellyfin?test-view=invalid-credentials");
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login-invalid-credentials.png", {
    fullPage: true,
  });
});

test("Jellyfin Quick Connect visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Quick Connect covers representative desktop and phone geometry",
  );
  await page.goto("/login/jellyfin?test-view=quick-connect");
  await page.getByText("Waiting for approval", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login-quick-connect.png", { fullPage: true });
});

test("Jellyfin account pairing visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Pairing baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/link/jellyfin", testInfo.project.name));
  await page.getByRole("button", { name: "Link Jellyfin account" }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing.png", { fullPage: true });
});

test("Jellyfin pairing session-expired visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Pairing errors cover representative desktop and phone geometry",
  );
  await page.goto("/link/jellyfin?test-view=session-expired");
  await page.getByRole("link", { name: "Return to sign in" }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing-session-expired.png", {
    fullPage: true,
  });
});

test("Jellyfin Quick Connect pairing visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Quick Connect pairing covers representative desktop and phone geometry",
  );
  await page.goto("/link/jellyfin?test-view=quick-connect");
  await page.getByText("Waiting for approval", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing-quick-connect.png", {
    fullPage: true,
  });
});

test("account security visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Account controls cover representative desktop and phone geometry",
  );
  await mockAccountSecurity(page);
  await page.goto("/settings");
  await page.getByText("Riley Morgan", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("account-security.png", { fullPage: true });
});

test("light account security visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light theme covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await mockAccountSecurity(page);
  await page.goto("/settings");
  await page.getByText("Riley Morgan", { exact: true }).waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("account-security-light.png", { fullPage: true });
});

test("account security provider-logout confirmation visual baseline", async ({
  page,
}, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Provider logout confirmation covers representative desktop and phone geometry",
  );
  await mockAccountSecurity(page);
  await page.goto("/settings?test-view=provider-logout");
  await page.getByRole("group", { name: "Confirm identity provider logout" }).waitFor();
  await expect(page).toHaveScreenshot("account-security-provider-logout.png", {
    fullPage: true,
  });
});

test("identity provider control room visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Identity controls cover representative desktop and phone geometry",
  );
  await page.goto("/settings/identity-providers?test-view=ready");
  await page.getByRole("heading", { name: "Authentik" }).waitFor();
  await expect(page).toHaveScreenshot("identity-providers.png", { fullPage: true });
});

test("light identity provider control room visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Dense light controls use desktop Chromium");
  await useLightTheme(page);
  await page.goto("/settings/identity-providers?test-view=ready");
  await page.getByRole("heading", { name: "Authentik" }).waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("identity-providers-light.png", { fullPage: true });
});

test("guided identity provider connection visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Provider onboarding covers representative desktop and phone geometry",
  );
  await page.goto("/settings/identity-providers?test-view=empty");
  await page.getByRole("heading", { name: "Connect Authentik" }).waitFor();
  await expect(page).toHaveScreenshot("identity-providers-empty.png", { fullPage: true });
});

test("service connection control room visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Service controls cover representative desktop and phone geometry",
  );
  await page.goto("/settings/connectors?test-view=ready");
  await page.getByRole("heading", { name: "Living Room Jellyfin" }).waitFor();
  await expect(page).toHaveScreenshot("service-connections.png", { fullPage: true });
});

test("light service connection control room visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Dense light controls use desktop Chromium");
  await useLightTheme(page);
  await page.goto("/settings/connectors?test-view=ready");
  await page.getByRole("heading", { name: "Living Room Jellyfin" }).waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("service-connections-light.png", { fullPage: true });
});

test("service connection onboarding visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Service onboarding covers representative desktop and phone geometry",
  );
  await page.goto("/settings/connectors?test-view=empty");
  await page.getByRole("heading", { name: "Connect a service." }).waitFor();
  await expect(page).toHaveScreenshot("service-connections-empty.png", { fullPage: true });
});

test("degraded service connection visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Degraded service health covers representative desktop and phone geometry",
  );
  await page.goto("/settings/connectors?test-view=degraded");
  await page.getByRole("heading", { name: "Radarr" }).waitFor();
  await expect(page).toHaveScreenshot("service-connections-degraded.png", { fullPage: true });
});

test("indexer intelligence visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Indexer intelligence covers representative desktop and phone geometry",
  );
  await page.goto("/operations/indexers?test-view=ready");
  await page.getByRole("heading", { name: "Know every source." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("indexer-intelligence.png", { fullPage: true });
});

test("light indexer intelligence visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light indexer intelligence covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/indexers?test-view=ready");
  await page.getByRole("heading", { name: "Know every source." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("indexer-intelligence-light.png", { fullPage: true });
});

test("degraded indexer intelligence visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Degraded indexer intelligence covers representative desktop and phone geometry",
  );
  await page.goto("/operations/indexers?test-view=degraded");
  await page.getByText("Partial intelligence", { exact: true }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("indexer-intelligence-degraded.png", { fullPage: true });
});

test("unconfigured login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login?test-view=unconfigured", testInfo.project.name));
  await page.getByText("No sign-in providers are configured", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("login-unconfigured.png", { fullPage: true });
});

for (const state of ["unavailable", "authentication-error"] as const) {
  test(`${state} login visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Login states cover representative desktop and phone geometry",
    );
    const path =
      state === "unavailable" ? "/login?test-view=unavailable" : "/login?authError=invalid_request";
    await page.goto(path);
    await page.locator("main").waitFor();
    await expect(page).toHaveScreenshot(`login-${state}.png`, { fullPage: true });
  });
}

for (const focusTarget of ["first", "last"] as const) {
  test(`provider overflow ${focusTarget} focus visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Provider overflow covers representative desktop and phone geometry",
    );
    await page.goto("/login?test-view=provider-overflow");
    const providers = page
      .getByRole("list", { name: "Sign-in methods" })
      .locator("[data-directional-item]");
    const focusedProvider = focusTarget === "first" ? providers.first() : providers.last();
    await focusedProvider.focus();
    await expect
      .poll(async () => {
        const [listBox, providerBox] = await Promise.all([
          page.getByRole("list", { name: "Sign-in methods" }).boundingBox(),
          focusedProvider.boundingBox(),
        ]);
        return Boolean(
          listBox &&
          providerBox &&
          providerBox.y >= listBox.y + 5 &&
          providerBox.y + providerBox.height <= listBox.y + listBox.height - 5,
        );
      })
      .toBe(true);
    await expect(page).toHaveScreenshot(`login-provider-overflow-focus-${focusTarget}.png`, {
      fullPage: true,
    });
  });
}

for (const state of ["loading", "empty", "offline", "terminal-error", "quiet"] as const) {
  test(`${state} dashboard visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "State baselines cover representative desktop and phone geometry",
    );
    await page.goto(`/?test-view=${state}`);
    await page.locator("main").waitFor();
    await expect(page).toHaveScreenshot(`dashboard-${state}.png`, { fullPage: true });
  });
}

test("expanded operations visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Expanded operations covers representative desktop and phone geometry",
  );
  await page.goto("/");
  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.click();
  await expect(page.locator("#operations-details")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await operations.evaluate((control) => control.blur());
  await expect(page).toHaveScreenshot("dashboard-operations-expanded.png", { fullPage: true });
});

test("acquisition timeline visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition provenance covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  await expect(page.getByRole("dialog", { name: "Signal history" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("acquisition-timeline.png");
});

test("acquisition recovery confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition recovery covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  await page.getByRole("button", { name: "Review search" }).click();
  await expect(page.getByRole("button", { name: "Queue search" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("acquisition-recovery-confirmation.png");
});

async function prepareManualReleaseWorkbench(page: Page) {
  await mockManualReleaseSession(page);
  await mockManualReleaseSearch(page);
  const workbench = await openManualReleaseWorkbench(page);
  await page.evaluate(() => document.fonts.ready);
  return workbench;
}

test("manual release workbench visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Manual release comparison covers representative desktop and phone geometry",
  );
  await prepareManualReleaseWorkbench(page);
  await expect(page).toHaveScreenshot("manual-release-workbench.png");
});

test("light manual release workbench visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light manual release comparison covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await prepareManualReleaseWorkbench(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("manual-release-workbench-light.png");
});

test("manual release override visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Manual release confirmation covers representative desktop and phone geometry",
  );
  const workbench = await prepareManualReleaseWorkbench(page);
  await workbench.getByRole("radio", { name: /1080p\.WEB-DL/u }).click();
  await workbench.getByRole("button", { name: "Review grab" }).click();
  await expect(workbench.getByRole("button", { name: "Send release" })).toBeDisabled();
  await expect(page).toHaveScreenshot("manual-release-override.png");
});

test("focus-visible visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Focus treatment covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Play now" }).focus();
  await expect(page.getByRole("button", { name: "Play now" })).toBeFocused();
  await expect(page).toHaveScreenshot("dashboard-focus-visible.png", { fullPage: true });
});
