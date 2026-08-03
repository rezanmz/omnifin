import { expect, test, type Page } from "@playwright/test";
import {
  demoContinueWatchingFeed,
  emptyContinueWatchingFeed,
} from "../../lib/continue-watching-demo";
import {
  mockAcquisitionQueueRecovery,
  mockAcquisitionRecoverySession,
} from "../fixtures/acquisition-recovery";
import {
  longTitleDiscoveryFeedFixture,
  mockDiscoveryArtwork,
  mockDiscoveryDetails,
  mockDiscoveryFeed,
  mockDiscoverySearch,
} from "../fixtures/discovery";
import { mockMediaRequestRouting, mockMediaRequestSession } from "../fixtures/media-request";
import {
  mockManualReleaseSearch,
  mockManualReleaseSession,
  openManualReleaseWorkbench,
} from "../fixtures/manual-release";
import { expandOperationsDock } from "../fixtures/operations";

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

async function stabilizeDashboardForFullPageCapture(page: Page) {
  await page.locator(".operations-dock").waitFor();
  await page.addStyleTag({
    content: `
      .dashboard > .media-rail,
      .dashboard > .calendar-strip,
      .dashboard > .operations-dock,
      .dashboard > .deferred-discovery-rails {
        content-visibility: visible !important;
      }
    `,
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function mockQuietContinueWatching(page: Page) {
  await page.route("**/api/media/continue-watching", async (route) => {
    await route.fulfill({
      body: JSON.stringify(emptyContinueWatchingFeed),
      contentType: "application/json",
      status: 200,
    });
  });
}

function continueWatchingFeedWithItemCount(count: number) {
  return {
    ...demoContinueWatchingFeed,
    items: Array.from({ length: count }, (_, index) => {
      const template =
        demoContinueWatchingFeed.items[index % demoContinueWatchingFeed.items.length]!;
      return {
        ...template,
        media: {
          ...template.media,
          artwork: {
            ...template.media.artwork,
            backdropPath: null,
            posterPath: null,
          },
          id: `media_${String(index + 1).padStart(22, "0")}`,
          title: index < 2 ? template.media.title : `${template.media.title} ${index + 1}`,
        },
      };
    }),
  };
}

async function mockSignedOutDashboard(page: Page) {
  await page.route("**/api/discovery/feed**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: "authentication_required", message: "Authentication is required." },
      }),
      contentType: "application/json",
      status: 401,
    });
  });
  await page.route("**/api/media/continue-watching", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: "authentication_required", message: "Authentication is required." },
      }),
      contentType: "application/json",
      status: 401,
    });
  });
}

test("build identity visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Build identity covers representative Chromium viewports",
  );
  await page.goto(routeForProject("/about?test-view=verified", testInfo.project.name));
  await page.getByText("Release verified").waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("about-build-identity.png", { fullPage: true });
});

test("light build identity visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light build identity covers desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/about?test-view=verified");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("about-build-identity-light.png", { fullPage: true });
});

for (const state of ["development", "unavailable"] as const) {
  test(`${state} build identity visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Build identity states cover desktop and phone geometry",
    );
    await page.goto(`/about?test-view=${state}`);
    await page.locator('main:not([aria-busy="true"])').waitFor();
    await removeDevelopmentIndicator(page);
    await expect(page).toHaveScreenshot(`about-build-identity-${state}.png`, { fullPage: true });
  });
}

async function waitForVisibleDiscoveryArtwork(page: Page) {
  const artwork = page
    .getByRole("region", { name: "Trending now" })
    .locator("img.media-card__artwork-image")
    .first();
  await expect(artwork).toHaveAttribute("src", /\/api\/discovery\/artwork\/discovery_art_/u);
  const initialScroll = await page.evaluate(() => window.scrollY);
  await artwork.evaluate((image) => {
    if (image instanceof HTMLImageElement) image.loading = "eager";
  });
  await artwork.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      artwork.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), initialScroll);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(initialScroll);
}

test("light signed-out dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Light signed-out boundaries cover representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await mockSignedOutDashboard(page);
  await page.goto("/?test-view=continue-watching-live");
  await page.getByRole("heading", { level: 1, name: "Welcome back" }).waitFor();
  await page.getByText("Your progress is waiting", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Your discovery signal is waiting" }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-signed-out-light.png", { fullPage: true });
});

test("signed-out dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Signed-out boundaries cover representative desktop and phone geometry",
  );
  await mockSignedOutDashboard(page);
  await page.goto("/?test-view=continue-watching-live");
  await page.getByRole("heading", { level: 1, name: "Welcome back" }).waitFor();
  await page.getByText("Your progress is waiting", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Your discovery signal is waiting" }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("dashboard-signed-out.png", { fullPage: true });
});

test("dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/", testInfo.project.name));
  await stabilizeDashboardForFullPageCapture(page);
  await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true });
});

test("connected discovery dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Connected discovery covers representative desktop and phone geometry",
  );
  await mockDiscoveryFeed(page);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-view=continue-watching-live");
  await page.getByRole("heading", { level: 1, name: "The Far Meridian" }).waitFor();
  await waitForVisibleDiscoveryArtwork(page);
  await stabilizeDashboardForFullPageCapture(page);
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("dashboard-live-discovery.png", { fullPage: true });
});

test("long discovery hero title visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Long-title containment targets phone geometry.");
  await mockDiscoveryFeed(page, longTitleDiscoveryFeedFixture);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-view=continue-watching-live");
  await page
    .getByRole("heading", {
      level: 1,
      name: "The Extraordinary Cartography of Distant Forgotten Worlds",
    })
    .waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator('.hero-spotlight[data-artwork-source="remote"]')).toHaveScreenshot(
    "dashboard-long-discovery-title.png",
  );
});

for (const itemCount of [1, 2, 7] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`Continue Watching ${itemCount}-item ${theme} visual baseline`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium",
        "One deterministic desktop engine covers sparse and dense rail geometry.",
      );
      if (theme === "light") await useLightTheme(page);
      await page.route("**/api/media/continue-watching", async (route) => {
        await route.fulfill({
          body: JSON.stringify(continueWatchingFeedWithItemCount(itemCount)),
          contentType: "application/json",
          status: 200,
        });
      });
      await page.goto("/?test-view=continue-watching-live");
      const rail = page
        .getByRole("heading", { name: "Continue watching" })
        .locator("xpath=ancestor::section[contains(@class, 'media-rail')]");
      await expect(rail.locator(".media-card")).toHaveCount(itemCount);
      await removeDevelopmentIndicator(page);
      await expect(rail).toHaveScreenshot(`continue-watching-${itemCount}-${theme}.png`);
    });
  }
}

test("light connected discovery dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Light connected discovery covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await mockDiscoveryFeed(page);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-view=continue-watching-live");
  await page.getByRole("heading", { level: 1, name: "The Far Meridian" }).waitFor();
  await waitForVisibleDiscoveryArtwork(page);
  await stabilizeDashboardForFullPageCapture(page);
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-live-discovery-light.png", { fullPage: true });
});

test("light dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light theme covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await stabilizeDashboardForFullPageCapture(page);
  await expect(page).toHaveScreenshot("dashboard-light.png", { fullPage: true });
});

test("browse discovery visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Browse discovery covers representative desktop and phone geometry",
  );
  await mockDiscoveryArtwork(page);
  await page.goto("/browse?test-view=ready");
  await page.getByRole("heading", { level: 1, name: "Browse without the guesswork." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("browse-discovery.png", { fullPage: true });
});

test("light browse discovery visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light Browse discovery covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await mockDiscoveryArtwork(page);
  await page.goto("/browse?test-view=ready");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("browse-discovery-light.png", { fullPage: true });
});

test("light profile controls visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Light theme uses desktop Chromium");
  await useLightTheme(page);
  await page.goto("/");
  await stabilizeDashboardForFullPageCapture(page);
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

test("permission-aware command palette visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "The command surface covers representative desktop and phone geometry",
  );
  await mockMediaRequestSession(page);
  await page.goto("/");
  await stabilizeDashboardForFullPageCapture(page);
  await page.getByRole("combobox", { name: "Search media and commands" }).click();
  await page.getByRole("option", { name: /Calendar/i }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("dashboard-command-palette.png", { fullPage: true });
});

test("light permission-aware command palette visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "The light command surface covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await mockMediaRequestSession(page);
  await page.goto("/");
  await stabilizeDashboardForFullPageCapture(page);
  await page.getByRole("combobox", { name: "Search media and commands" }).click();
  await page.getByRole("option", { name: /Calendar/i }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-command-palette-light.png", { fullPage: true });
});

async function openMediaDetails(page: Page) {
  await mockDiscoverySearch(page);
  await mockDiscoveryDetails(page);
  await page.goto("/");
  const search = page.getByRole("combobox");
  await search.click();
  await search.fill("matrix");
  await page.getByRole("button", { name: "View details for The Matrix" }).click();
  const details = page.getByRole("dialog", { name: "The Matrix details" });
  await expect(details).toBeVisible();
  await expect(details.getByText("Free your mind.")).toBeVisible();
}

test("media detail drawer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Media details cover representative desktop and phone geometry",
  );
  await openMediaDetails(page);
  await expect(page).toHaveScreenshot("dashboard-media-details.png");
});

test("light media detail drawer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light media details cover representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await openMediaDetails(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-media-details-light.png");
});

test("person context drawer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Person context covers representative desktop and phone geometry",
  );
  await openMediaDetails(page);
  await page.getByRole("button", { name: /Keanu Reeves/iu }).click();
  await expect(page.getByRole("heading", { name: "Keanu Reeves" })).toBeVisible();
  await expect(page.getByText(/work spans independent drama/iu)).toBeVisible();
  await expect(page).toHaveScreenshot("dashboard-person-context.png");
});

async function openRequestComposer(page: Page, advanced = false) {
  await mockDiscoverySearch(page);
  await mockMediaRequestSession(page);
  if (advanced) await mockMediaRequestRouting(page);
  await page.goto("/");
  const search = page.getByRole("combobox");
  await search.click();
  await search.fill("matrix");
  const requestAction = page.getByRole("button", { name: "Request The Matrix" });
  await requestAction.waitFor();
  await requestAction.click();
  const composer = page.getByRole("dialog", { name: "Compose request" });
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send request" })).toBeVisible();
  if (advanced) {
    await composer.getByText("Advanced routing").click();
    await expect(composer.getByRole("combobox", { name: /Destination/i })).toBeVisible();
  }
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

test("advanced request routing visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Advanced routing covers representative desktop and phone geometry",
  );
  await openRequestComposer(page, true);
  await expect(page).toHaveScreenshot("dashboard-request-routing.png", { fullPage: true });
});

test("first-run dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/onboarding?test-view=partial", testInfo.project.name));
  await page.getByRole("heading", { name: /Core is ready/u }).waitFor();
  await expect(page).toHaveScreenshot("dashboard-onboarding.png", { fullPage: true });
});

test("first-run core action visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Core setup actions cover representative desktop and phone geometry",
  );
  await page.goto("/onboarding?test-view=needs-core");
  await page.getByRole("heading", { name: /Two essentials/u }).waitFor();
  await expect(page).toHaveScreenshot("dashboard-onboarding-needs-core.png", { fullPage: true });
});

test("first-run deployment attention visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Host-hardening guidance covers representative desktop and phone geometry",
  );
  await page.goto("/onboarding?test-view=deployment-attention");
  await page.getByRole("heading", { name: /Finish the host hardening boundary/u }).waitFor();
  await expect(page).toHaveScreenshot("dashboard-onboarding-deployment-attention.png", {
    fullPage: true,
  });
});

test("stack verification report visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Stack verification covers representative desktop and phone geometry",
  );
  await page.goto("/onboarding?test-view=partial&test-verification=attention");
  await page.getByRole("heading", { name: /Most of the stack answered/u }).waitFor();
  await expect(page).toHaveScreenshot("dashboard-stack-verification.png", { fullPage: true });
});

test("light first-run dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light setup guidance covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/onboarding?test-view=partial");
  await page.getByRole("heading", { name: /Core is ready/u }).waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("dashboard-onboarding-light.png", { fullPage: true });
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

test("recovery secret entry visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Recovery entry baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/recovery?test-view=entry", testInfo.project.name));
  await page.getByLabel("Recovery secret").waitFor();
  await expect(page).toHaveScreenshot("recovery-secret-entry.png", { fullPage: true });
});

test("light recovery secret entry visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light recovery entry covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/recovery?test-view=entry");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Recovery secret").waitFor();
  await expect(page).toHaveScreenshot("recovery-secret-entry-light.png", { fullPage: true });
});

test("first administrator proof visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Administrator proof covers representative desktop and phone geometry",
  );
  await page.goto("/recovery?test-view=bootstrap");
  await page.getByRole("heading", { name: "Establish trusted control." }).waitFor();
  await expect(page).toHaveScreenshot("recovery-jellyfin-administrator.png", {
    fullPage: true,
  });
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

test("user access control room visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "User access covers representative desktop and phone geometry",
  );
  await page.goto("/settings/users?test-view=ready");
  await page.getByRole("heading", { name: "Rezan" }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("user-access.png", { fullPage: true });
});

test("light user access control room visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Dense light controls use desktop Chromium");
  await useLightTheme(page);
  await page.goto("/settings/users?test-view=ready");
  await page.getByRole("heading", { name: "Rezan" }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("user-access-light.png", { fullPage: true });
});

test("empty user access directory visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Empty user access covers representative desktop and phone geometry",
  );
  await page.goto("/settings/users?test-view=empty");
  await page.getByRole("heading", { name: "No user identities yet." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("user-access-empty.png", { fullPage: true });
});

test("operator audit trail visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "The operator ledger covers desktop, phone, tablet, and ten-foot geometry",
  );
  await page.goto(routeForProject("/settings/audit?test-view=ready", testInfo.project.name));
  await page.getByLabel("Loading operator audit trail").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Service configuration updated" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("operator-audit-trail.png", { fullPage: true });
});

test("light operator audit trail visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "The light operator ledger covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/settings/audit?test-view=ready");
  await page.getByLabel("Loading operator audit trail").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Service configuration updated" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("operator-audit-trail-light.png", { fullPage: true });
});

test("empty operator audit trail visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "The empty operator ledger covers representative desktop and phone geometry",
  );
  await page.goto("/settings/audit?test-view=empty");
  await page.getByLabel("Loading operator audit trail").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "The ledger is quiet." }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("operator-audit-trail-empty.png", { fullPage: true });
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

test("system health visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "System health covers representative desktop and phone geometry",
  );
  await page.goto("/operations/health?test-view=ready");
  await page.getByRole("heading", { name: "2 clear things to check." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("system-health.png", { fullPage: true });

  const updateMode = page.getByLabel("System status updates: snapshot").locator("..");
  await page.addStyleTag({
    content:
      '[data-liquid-glass]:has([aria-label="System status updates: snapshot"]) { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--surface-card-solid) !important; }',
  });
  await expect(updateMode).toHaveScreenshot("system-health-update-mode.png");
});

test("light system health visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light system health covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/health?test-view=ready");
  await page.getByRole("heading", { name: "2 clear things to check." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("system-health-light.png", { fullPage: true });
});

test("degraded system health visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Degraded system health covers representative desktop and phone geometry",
  );
  await page.goto("/operations/health?test-view=degraded");
  await page.getByText("Partial visibility", { exact: true }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("system-health-degraded.png", { fullPage: true });
});

test("system health onboarding visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "System health onboarding covers representative desktop and phone geometry",
  );
  await page.goto("/operations/health?test-view=unconfigured");
  await page.getByRole("heading", { name: "Connect the stack." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("system-health-unconfigured.png", { fullPage: true });
});

test("download queue visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Download queues cover representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=ready");
  await page.getByRole("heading", { name: "Every byte, in motion." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue.png", { fullPage: true });
});

test("download queue confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Queue confirmations cover representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=ready");
  await page.getByRole("button", { name: "Pause The.Far.Meridian.2026.2160p.WEB-DL" }).click();
  await page.getByText("Pause this transfer?").waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue-confirmation.png", { fullPage: true });
});

test("download queue bulk confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Bulk queue confirmations cover representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=ready");
  await page.getByRole("button", { name: "Pause 1 active transfer" }).click();
  await page.getByText("Pause 1 transfer?").waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue-bulk-confirmation.png", { fullPage: true });
});

test("download queue removal confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Queue removals cover representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=ready");
  await page.getByRole("button", { name: "Remove The.Far.Meridian.2026.2160p.WEB-DL" }).click();
  await page.getByText("Remove this transfer?").waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue-removal-confirmation.png", {
    fullPage: true,
  });
});

test("light download queue visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light download queues cover representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/downloads?test-view=ready");
  await page.getByRole("heading", { name: "Every byte, in motion." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("download-queue-light.png", { fullPage: true });
});

test("degraded download queue visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Degraded queues cover representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=degraded");
  await page.getByText("Partial queue", { exact: true }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue-degraded.png", { fullPage: true });
});

test("download client onboarding visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Download client onboarding covers representative desktop and phone geometry",
  );
  await page.goto("/operations/downloads?test-view=unconfigured");
  await page.getByRole("heading", { name: "Connect the transfer plane." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("download-queue-unconfigured.png", { fullPage: true });
});

test("acquisition calendar visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition calendars cover representative desktop and phone geometry",
  );
  await page.goto("/calendar?test-view=ready");
  await page.getByRole("heading", { name: "See what arrives next." }).waitFor();
  await page.getByRole("button", { name: /Inspect The Far Meridian/i }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("acquisition-calendar.png", { fullPage: true });
});

test("monthly acquisition calendar visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Monthly acquisition calendars cover representative desktop and phone geometry",
  );
  await page.goto("/calendar?test-view=month");
  await page.getByRole("heading", { name: "Month at a glance" }).waitFor();
  await page.getByRole("gridcell").first().waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("acquisition-calendar-month.png", { fullPage: true });
});

test("light acquisition calendar visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light acquisition calendars cover representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/calendar?test-view=ready");
  await page.getByRole("heading", { name: "See what arrives next." }).waitFor();
  await page.getByRole("button", { name: /Inspect The Far Meridian/i }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("acquisition-calendar-light.png", { fullPage: true });
});

test("degraded acquisition calendar visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Degraded acquisition calendars cover representative desktop and phone geometry",
  );
  await page.goto("/calendar?test-view=degraded");
  await page.getByText("Partial horizon", { exact: true }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("acquisition-calendar-degraded.png", { fullPage: true });
});

test("acquisition calendar event drawer visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Calendar event details cover representative desktop and phone geometry",
  );
  await page.goto("/calendar?test-view=ready");
  await page.getByRole("button", { name: /Inspect The Far Meridian/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("acquisition-calendar-event.png");
});

test("viewer library visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "The viewer library covers representative desktop and phone geometry",
  );
  await page.goto("/library?test-view=ready");
  await page.getByRole("heading", { name: "Every story, in its place." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("media-library.png", { fullPage: true });
});

test("light viewer library visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "The light viewer library covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/library?test-view=ready");
  await page.getByRole("heading", { name: "Every story, in its place." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("media-library-light.png", { fullPage: true });
});

test("series title hierarchy visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Series hierarchy covers representative desktop and phone geometry",
  );
  await page.goto("/library?test-view=ready");
  await page.getByRole("button", { name: "View details for Northern Lights, 2 seasons" }).click();
  const dialog = page.getByRole("dialog", { name: "Northern Lights details" });
  await expect(dialog.getByRole("heading", { name: "Northern Lights" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Episodes" })).toBeVisible();
  await removeDevelopmentIndicator(page);
  await expect(dialog).toHaveScreenshot("media-library-series-title.png");
});

test("raised viewer library poster visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Hover treatment uses desktop Chromium");
  await page.goto("/library?test-view=ready");
  await page.getByRole("button", { name: /View details for Ember Coast/u }).hover();
  await removeDevelopmentIndicator(page);
  await expect(page.getByRole("list", { name: "Library titles" })).toHaveScreenshot(
    "media-library-card-hover.png",
  );
});

for (const state of ["empty", "unavailable", "loading"] as const) {
  test(`${state} viewer library visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Viewer library boundaries cover representative desktop and phone geometry",
    );
    await page.goto(`/library?test-view=${state}`);
    await page.locator("main").waitFor();
    await removeDevelopmentIndicator(page);
    if (state === "unavailable" && testInfo.project.name === "mobile") {
      const retry = await page.getByRole("button", { name: "Try again" }).boundingBox();
      const navigation = await page
        .getByRole("navigation", { name: "Primary navigation" })
        .boundingBox();
      expect(retry, "retry action should be rendered").not.toBeNull();
      expect(navigation, "mobile navigation should be rendered").not.toBeNull();
      expect(retry!.y + retry!.height).toBeLessThanOrEqual(navigation!.y - 8);
    }
    await expect(page).toHaveScreenshot(`media-library-${state}.png`, { fullPage: true });
  });
}

test("library care visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Library care covers representative desktop and phone geometry",
  );
  await page.goto("/operations/library?test-view=ready");
  await page.getByRole("heading", { name: "Make every title feel finished." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("library-care.png", { fullPage: true });
});

test("light library care visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light library care covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/library?test-view=ready");
  await page.getByRole("heading", { name: "Make every title feel finished." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("library-care-light.png", { fullPage: true });
});

test("library item inspector visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Library item inspection covers representative desktop and phone geometry",
  );
  await page.goto("/operations/library?test-view=ready");
  await page.getByRole("button", { name: "Inspect Northern Lights" }).click();
  await expect(page.getByRole("button", { name: "Close library inspector" })).toBeFocused();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("library-care-inspector.png");
});

test("raised library card visual baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Hover treatment uses desktop Chromium");
  await page.goto("/operations/library?test-view=ready");
  const card = page.getByRole("button", { name: "Inspect Ember Coast" });
  await card.hover();
  await removeDevelopmentIndicator(page);
  await expect(page.getByRole("region", { name: "Details worth finishing" })).toHaveScreenshot(
    "library-care-card-hover.png",
  );
});

for (const state of ["empty", "unavailable"] as const) {
  test(`${state} library care visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Library care boundaries cover representative desktop and phone geometry",
    );
    await page.goto(`/operations/library?test-view=${state}`);
    await page.locator("main").waitFor();
    await removeDevelopmentIndicator(page);
    await expect(page).toHaveScreenshot(`library-care-${state}.png`, { fullPage: true });
  });
}

test("request review visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Request review covers representative desktop and phone geometry",
  );
  await page.goto("/operations/requests?test-view=ready");
  await page.getByRole("heading", { name: "Decide what enters the library." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("request-review.png", { fullPage: true });
});

test("light request review visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light request review covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/requests?test-view=ready");
  await page.getByRole("heading", { name: "Decide what enters the library." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("request-review-light.png", { fullPage: true });
});

test("request approval confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Request approval confirmation covers representative desktop and phone geometry",
  );
  await page.goto("/operations/requests?test-view=ready");
  const card = page.getByText("A House of Dynamite").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog", { name: "Send this into acquisition?" })).toBeVisible();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("request-review-confirmation.png");
});

for (const state of ["empty", "unavailable"] as const) {
  test(`${state} request review visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Request review boundaries cover representative desktop and phone geometry",
    );
    await page.goto(`/operations/requests?test-view=${state}`);
    await page.locator("main").waitFor();
    await removeDevelopmentIndicator(page);
    await expect(page).toHaveScreenshot(`request-review-${state}.png`, { fullPage: true });
  });
}

test("media issue workbench visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Issue workbench covers representative desktop and phone geometry",
  );
  await page.goto("/operations/issues?test-view=ready");
  await page.getByRole("heading", { name: "Close the loop on every stream." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("media-issue-workbench.png", { fullPage: true });
});

test("light media issue workbench visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !lightVisualProjects.has(testInfo.project.name),
    "Light issue workbench covers representative desktop and phone geometry",
  );
  await useLightTheme(page);
  await page.goto("/operations/issues?test-view=ready");
  await page.getByRole("heading", { name: "Close the loop on every stream." }).waitFor();
  await removeDevelopmentIndicator(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page).toHaveScreenshot("media-issue-workbench-light.png", { fullPage: true });
});

test("issue resolution confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Issue resolution covers representative desktop and phone geometry",
  );
  await page.goto("/operations/issues?test-view=ready");
  const card = page.getByText("Northern Lights").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
  await removeDevelopmentIndicator(page);
  await expect(page).toHaveScreenshot("media-issue-resolution.png");
});

for (const state of ["empty", "degraded", "unavailable"] as const) {
  test(`${state} media issue workbench visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Issue workbench boundaries cover representative desktop and phone geometry",
    );
    await page.goto(`/operations/issues?test-view=${state}`);
    await page.locator("main").waitFor();
    await removeDevelopmentIndicator(page);
    await expect(page).toHaveScreenshot(`media-issue-workbench-${state}.png`, { fullPage: true });
  });
}

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
    if (state === "quiet") {
      await stabilizeDashboardForFullPageCapture(page);
    } else {
      await page.locator("main").waitFor();
    }
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
  await expandOperationsDock(page);
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await operations.evaluate((control) => control.blur());
  await expect(page).toHaveScreenshot("dashboard-operations-expanded.png", { fullPage: true });
});

async function stabilizeAcquisitionTimelineVisual(page: Page) {
  // Native backdrop sampling varies with GPU composition and the obscured dashboard.
  // Keep component baselines deterministic without changing production glass rendering.
  await page.addStyleTag({
    content:
      ".acquisition-timeline__glass { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--surface-card-solid) !important; }",
  });
}

test("acquisition timeline visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition provenance covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await expandOperationsDock(page);
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(timeline).toBeVisible();
  await expect(page.getByLabel("Acquisition updates: Refreshing")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-timeline.png");
});

test("acquisition recovery confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition recovery covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await expandOperationsDock(page);
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(page.getByLabel("Acquisition updates: Refreshing")).toBeVisible();
  await timeline.getByRole("button", { name: "Review search" }).click();
  await expect(timeline.getByRole("button", { name: "Queue search" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-recovery-confirmation.png");
});

async function openQueueRecoveryTimeline(page: Page) {
  await page.goto("/?test-view=queue-recovery");
  await expandOperationsDock(page);
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(page.getByLabel("Acquisition updates: Refreshing")).toBeVisible();
  return timeline;
}

test("failed queue recovery confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Failed queue recovery covers representative desktop and phone geometry",
  );
  const timeline = await openQueueRecoveryTimeline(page);
  await timeline.getByRole("button", { name: "Recover stalled download" }).click();
  await expect(timeline.getByLabel("Type REMOVE to confirm")).toBeFocused();
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-queue-recovery-confirmation.png");
});

test("failed queue recovery success visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Failed queue recovery covers representative desktop and phone geometry",
  );
  await mockAcquisitionRecoverySession(page);
  await mockAcquisitionQueueRecovery(page);
  const timeline = await openQueueRecoveryTimeline(page);
  await timeline.getByRole("button", { name: "Recover stalled download" }).click();
  await timeline.getByLabel("Type REMOVE to confirm").fill("REMOVE");
  await timeline.getByRole("button", { name: "Remove and blocklist" }).click();
  const success = timeline.locator('.acquisition-event__recovery-status[data-state="success"]');
  await expect(success).toBeFocused();
  await success.evaluate((status) => {
    const scroller = status.closest(".acquisition-timeline__body");
    const dialog = status.closest(".acquisition-timeline");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("The acquisition recovery status lost its timeline scroll container.");
    }
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("The acquisition recovery status lost its timeline dialog.");
    }

    const statusBounds = status.getBoundingClientRect();
    const scrollerBounds = scroller.getBoundingClientRect();
    dialog.scrollTop = 0;
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop +=
      statusBounds.top - scrollerBounds.top - (scroller.clientHeight - statusBounds.height) / 2;
  });
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-queue-recovery-success.png");
});

test("failed queue recovery stale visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Failed queue recovery covers representative desktop and phone geometry",
  );
  await mockAcquisitionRecoverySession(page);
  await mockAcquisitionQueueRecovery(page, "stale");
  const timeline = await openQueueRecoveryTimeline(page);
  await timeline.getByRole("button", { name: "Recover stalled download" }).click();
  await timeline.getByLabel("Type REMOVE to confirm").fill("REMOVE");
  await timeline.getByRole("button", { name: "Remove and blocklist" }).click();
  await expect(timeline.getByText("Queue item changed")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-queue-recovery-stale.png");
});

test("acquisition monitoring confirmation visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Acquisition monitoring covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await expandOperationsDock(page);
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(page.getByLabel("Acquisition updates: Refreshing")).toBeVisible();
  await timeline.getByRole("button", { name: "Pause monitoring for The Far Meridian" }).click();
  await expect(timeline.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await stabilizeAcquisitionTimelineVisual(page);
  await expect(timeline).toHaveScreenshot("acquisition-monitoring-confirmation.png");
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
  await stabilizeDashboardForFullPageCapture(page);
  await page.getByRole("link", { name: "Browse library" }).focus();
  await expect(page.getByRole("link", { name: "Browse library" })).toBeFocused();
  await expect(page).toHaveScreenshot("dashboard-focus-visible.png", { fullPage: true });
});
