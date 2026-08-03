import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  demoContinueWatchingFeed,
  emptyContinueWatchingFeed,
} from "../../lib/continue-watching-demo";
import {
  acquisitionMonitoringCsrfToken,
  mockAcquisitionMonitoringSession,
  mockAcquisitionMonitoringUpdate,
} from "../fixtures/acquisition-monitoring";
import {
  acquisitionQueueRecoveryReference,
  acquisitionRecoveryCsrfToken,
  mockAcquisitionQueueRecovery,
  mockAcquisitionRecoverySession,
  mockAcquisitionSearch,
} from "../fixtures/acquisition-recovery";
import {
  mockDiscoveryDetails,
  mockDiscoveryFeed,
  mockDiscoveryFeedDetails,
  mockDiscoverySearch,
} from "../fixtures/discovery";
import {
  mediaRequestCsrfToken,
  mediaRequestRoutingReference,
  mockMediaRequestCreation,
  mockMediaRequestRouting,
  mockMediaRequestSession,
} from "../fixtures/media-request";
import {
  manualReleaseCandidates,
  manualReleaseCsrfToken,
  mockManualReleaseGrab,
  mockManualReleaseSearch,
  mockManualReleaseSession,
  openManualReleaseWorkbench,
} from "../fixtures/manual-release";

async function mockQuietContinueWatching(page: Parameters<typeof mockDiscoveryFeed>[0]) {
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

async function expectStationaryPointerTarget(action: Locator) {
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  await action.hover();
  await expect
    .poll(() =>
      action.evaluate(async (element) => {
        const before = element.getBoundingClientRect();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const after = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          after.x + after.width / 2,
          after.y + after.height / 2,
        );
        const stationary = [
          Math.abs(before.x - after.x),
          Math.abs(before.y - after.y),
          Math.abs(before.width - after.width),
          Math.abs(before.height - after.height),
        ].every((delta) => delta < 0.1);
        return (
          stationary &&
          getComputedStyle(element).transform === "none" &&
          (hit === element || element.contains(hit))
        );
      }),
    )
    .toBe(true);
}

async function openAcquisitionTimeline(page: Page) {
  const disclosure = page.getByRole("button", { name: /2 acquisitions moving/i });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");

  const operation = page.getByRole("button", {
    name: "Inspect acquisition history for The Far Meridian",
  });
  await expectStationaryPointerTarget(operation);
  await operation.click();

  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(timeline).toBeVisible();
  return timeline;
}

test("dashboard supports keyboard-first operational disclosure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await expect(operations).toBeEnabled();
  await operations.focus();
  await page.keyboard.press("Enter");
  await expect(operations).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /Signal · S01E07/i })).toBeVisible();
});

test("unexpected route failures provide private, keyboard-usable recovery", async ({ page }) => {
  await page.goto("/?test-view=route-error");

  const recovery = page.getByRole("main");
  await expect(recovery).toBeFocused();
  await expect(
    page.getByRole("heading", { level: 1, name: "This view lost its signal." }),
  ).toBeVisible();
  await expect(page.getByText("Deterministic browser-only route failure")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.getByRole("link", { name: "Return home" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();
});

test("authenticated Continue Watching renders normalized progress and private artwork", async ({
  page,
}) => {
  await page.route("**/api/media/continue-watching", async (route) => {
    await route.fulfill({
      body: JSON.stringify(demoContinueWatchingFeed),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/media/*/images/poster", async (route) => {
    await route.fulfill({
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      contentType: "image/png",
      status: 200,
    });
  });

  await page.goto("/?test-view=continue-watching-live");
  const card = page.getByRole("button", { name: "Resume Northern Lights" });
  await expect(card).toHaveAccessibleDescription("33% watched");
  await expect(
    page.getByRole("progressbar", { name: "Northern Lights watch progress" }),
  ).toHaveAttribute("aria-valuenow", "33");
  await expect(card.locator(".media-card__art")).toHaveAttribute("data-artwork-source", "remote");
  await expect(card.locator(".media-card__artwork-image")).toHaveAttribute(
    "src",
    /\/api\/media\/media_b{22}\/images\/poster/u,
  );
  await expect(page.getByText("jellyfin-main")).toHaveCount(0);
});

test("Continue Watching keeps stable card geometry for sparse and dense feeds", async ({
  page,
}, testInfo) => {
  test.skip(
    !["chromium", "mobile", "ten-foot"].includes(testInfo.project.name),
    "Representative pointer, touch, and 10-foot profiles cover responsive rail geometry.",
  );
  let itemCount = 2;
  await page.route("**/api/media/continue-watching", async (route) => {
    await route.fulfill({
      body: JSON.stringify(continueWatchingFeedWithItemCount(itemCount)),
      contentType: "application/json",
      status: 200,
    });
  });

  const widths: number[] = [];
  for (const count of [1, 2, 7]) {
    itemCount = count;
    const path =
      testInfo.project.name === "ten-foot"
        ? "/?test-profile=ten-foot&test-view=continue-watching-live"
        : "/?test-view=continue-watching-live";
    await page.goto(path);
    const heading = page.getByRole("heading", { name: "Continue watching" });
    const rail = heading.locator("xpath=ancestor::section[contains(@class, 'media-rail')]");
    const cards = rail.locator(".media-card");
    await expect(cards).toHaveCount(count);
    const firstBox = await cards.first().boundingBox();
    expect(firstBox).not.toBeNull();
    widths.push(firstBox!.width);
    await expect(cards.first().locator(".media-card__action")).toBeVisible();

    if (count === 2) {
      const trailingSpace = await rail.locator(".media-rail__scroller").evaluate((scroller) => {
        const last = scroller.lastElementChild?.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (!last) return 0;
        return Math.max(0, bounds.right - last.right);
      });
      expect(trailingSpace).toBeGreaterThanOrEqual(16);
    }
  }

  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const maximumWidth =
    testInfo.project.name === "ten-foot" ? 300 : testInfo.project.name === "mobile" ? 182 : 230;
  expect(Math.max(...widths)).toBeLessThanOrEqual(maximumWidth + 1);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(144);
});

test("connected discovery renders live artwork and opens real title details", async ({ page }) => {
  await mockDiscoveryFeed(page);
  await mockDiscoveryFeedDetails(page);
  await mockQuietContinueWatching(page);

  await page.goto("/?test-view=continue-watching-live");
  await expect(page.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trending now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Popular movies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Series people are watching" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Coming soon" })).toBeVisible();
  await expect(page.getByText("View all")).toHaveCount(0);
  const spotlight = page.locator('.hero-spotlight[data-artwork-source="remote"]');
  await expect(spotlight).toBeVisible();
  const spotlightGeometry = await spotlight.evaluate((hero) => {
    const artwork = hero.querySelector<HTMLElement>(".hero-spotlight__art");
    if (!artwork) throw new Error("Spotlight artwork is missing.");
    const heroBox = hero.getBoundingClientRect();
    const artworkBox = artwork.getBoundingClientRect();
    const style = getComputedStyle(artwork);
    return {
      artwork: {
        bottom: artworkBox.bottom,
        left: artworkBox.left,
        right: artworkBox.right,
        top: artworkBox.top,
      },
      filter: style.filter,
      hero: {
        bottom: heroBox.bottom,
        left: heroBox.left,
        right: heroBox.right,
        top: heroBox.top,
      },
      transform: style.transform,
    };
  });
  expect(spotlightGeometry.filter).toBe("none");
  expect(spotlightGeometry.transform).toBe("none");
  expect(spotlightGeometry.artwork.left).toBeGreaterThanOrEqual(spotlightGeometry.hero.left);
  expect(spotlightGeometry.artwork.top).toBeGreaterThanOrEqual(spotlightGeometry.hero.top);
  expect(spotlightGeometry.artwork.right).toBeLessThanOrEqual(spotlightGeometry.hero.right);
  expect(spotlightGeometry.artwork.bottom).toBeLessThanOrEqual(spotlightGeometry.hero.bottom);

  await page.getByRole("button", { exact: true, name: "View details" }).click();
  const detail = page.getByRole("dialog", { name: "The Far Meridian details" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Follow the signal.")).toBeVisible();
});

test("operators can inspect a title-level acquisition trace before choosing recovery", async ({
  page,
}) => {
  await page.goto("/");
  const timeline = await openAcquisitionTimeline(page);
  await expect(timeline.getByRole("heading", { name: "The Far Meridian" })).toBeVisible();
  await expect(timeline.getByText("Release grabbed")).toBeVisible();
  await expect(timeline.getByText("Download failed", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Verified operational signal")).toBeVisible();

  const history = timeline.getByRole("region", { name: "Acquisition event history" });
  await history.focus();
  await expect(history).toBeFocused();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      history.evaluate(
        (region) => region.scrollHeight <= region.clientHeight + 1 || region.scrollTop > 0,
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(timeline).not.toBeVisible();
});

test("a strict live provenance snapshot replaces only its selected target", async ({ page }) => {
  const requestedUrls: string[] = [];
  await page.route("**/api/acquisitions/provenance/events?*", async (route) => {
    requestedUrls.push(route.request().url());
    const cursor = "provenance_event_ABCDEFGHIJKLMNOPQRSTUV";
    await route.fulfill({
      body: `id: ${cursor}\ndata: ${JSON.stringify({
        cursor,
        kind: "snapshot",
        provenance: {
          events: [],
          failures: [],
          generatedAt: "2026-07-29T20:00:00.000Z",
          state: "complete",
          target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
        },
      })}\n\n`,
      contentType: "text/event-stream; charset=utf-8",
      headers: { "cache-control": "no-store" },
      status: 200,
    });
  });

  await page.goto("/");
  const timeline = await openAcquisitionTimeline(page);
  await expect(timeline.getByRole("heading", { name: "No acquisition events yet" })).toBeVisible();
  const requestedUrl = new URL(requestedUrls[0]!);
  expect(`${requestedUrl.pathname}${requestedUrl.search}`).toBe(
    "/api/acquisitions/provenance/events?mediaId=42&service=radarr",
  );
  await expect(timeline.getByText("Release grabbed")).toHaveCount(0);
});

test("operators can explicitly pause whole-title monitoring without touching files", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockAcquisitionMonitoringSession(page);
  const capture = await mockAcquisitionMonitoringUpdate(page);
  await page.goto("/");
  const timeline = await openAcquisitionTimeline(page);
  const monitoringAction = timeline.getByRole("button", {
    name: "Pause monitoring for The Far Meridian",
  });
  await expect(monitoringAction).toBeVisible();
  await monitoringAction.scrollIntoViewIfNeeded();
  const interactionBoundary = await monitoringAction.evaluate((action) => {
    const scrollRegion = action.closest<HTMLElement>(".acquisition-timeline__body");
    if (!scrollRegion) throw new Error("acquisition_scroll_region_missing");

    const dialog = action.closest("dialog");
    if (!dialog) throw new Error("acquisition_dialog_missing");
    const footer = scrollRegion.querySelector<HTMLElement>(".acquisition-timeline__footer");
    if (!footer) throw new Error("acquisition_footer_missing");
    const hasSpatialEntrance = dialog.getAnimations().some((animation) => {
      if (!(animation.effect instanceof KeyframeEffect)) return false;
      return animation.effect
        .getKeyframes()
        .some((frame) => typeof frame.transform === "string" && frame.transform !== "none");
    });

    const bounds = action.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    return {
      footerPointerEvents: getComputedStyle(footer).pointerEvents,
      hasSpatialEntrance,
      overflowAnchor: getComputedStyle(scrollRegion).overflowAnchor,
      targetable: hit === action || action.contains(hit),
    };
  });
  expect(interactionBoundary).toEqual({
    footerPointerEvents: "none",
    hasSpatialEntrance: false,
    overflowAnchor: "none",
    targetable: true,
  });
  await monitoringAction.click();
  await expect(timeline.getByText("Pause monitoring for The Far Meridian?")).toBeVisible();
  await expect(timeline.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(timeline.getByText(/Existing files and downloads stay intact/u)).toBeVisible();
  await expect(timeline.getByRole("button", { name: /delete|remove|move/i })).toHaveCount(0);
  await timeline.getByRole("button", { name: "Pause" }).click();

  await expect(timeline.getByText("Monitoring paused", { exact: true })).toBeVisible();
  expect(capture.requests).toBe(1);
  expect(capture.body).toEqual({
    expectedMonitored: true,
    mediaId: 42,
    monitored: false,
    service: "radarr",
  });
  expect(capture.csrfToken).toBe(acquisitionMonitoringCsrfToken);
});

test("operators can queue one exact-target acquisition search", async ({ page }) => {
  test.setTimeout(60_000);
  await mockAcquisitionRecoverySession(page);
  const capture = await mockAcquisitionSearch(page);
  await page.goto("/");
  const timeline = await openAcquisitionTimeline(page);
  const recoveryAction = timeline.getByRole("button", { name: "Review search" });
  await expectStationaryPointerTarget(recoveryAction);
  await recoveryAction.click();
  await expect(timeline.getByText(/library files remain untouched/u)).toBeVisible();
  await expect(timeline.getByRole("button", { name: /delete|blocklist|remove/i })).toHaveCount(0);
  await timeline.getByRole("button", { name: "Queue search" }).click();

  await expect(timeline.getByText("Acquisition search is in motion")).toBeVisible();
  expect(capture.body).toEqual({ mediaId: 42, service: "radarr" });
  expect(capture.csrfToken).toBe(acquisitionRecoveryCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^acquisition-[0-9a-f-]{36}$/u);
});

test("operators can remove and blocklist one exact stalled queue item", async ({ page }) => {
  test.setTimeout(60_000);
  await mockAcquisitionRecoverySession(page);
  const capture = await mockAcquisitionQueueRecovery(page);
  await page.goto("/?test-view=queue-recovery");
  const timeline = await openAcquisitionTimeline(page);
  await timeline.getByRole("button", { name: "Recover stalled download" }).click();
  await expect(
    timeline.getByText(/removes the item and its data from the download client/u),
  ).toBeVisible();
  const confirmation = timeline.getByLabel("Type REMOVE to confirm");
  await confirmation.fill("remove");
  await expect(confirmation).toHaveValue("REMOVE");
  await timeline.getByRole("button", { name: "Remove and blocklist" }).click();

  await expect(timeline.getByText("Removed and blocklisted")).toBeVisible();
  await expect(timeline.getByText("No new search was started automatically.")).toBeVisible();
  expect(capture.body).toEqual({ reference: acquisitionQueueRecoveryReference });
  expect(capture.csrfToken).toBe(acquisitionRecoveryCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^queue-recovery-[0-9a-f-]{36}$/u);
});

test("operators can compare and explicitly override one exact manual release", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockManualReleaseSession(page);
  await mockManualReleaseSearch(page);
  const capture = await mockManualReleaseGrab(page);
  const workbench = await openManualReleaseWorkbench(page);

  await expect(page.getByRole("dialog", { name: "Signal history" })).not.toBeVisible();
  await expect(workbench.getByText("2 candidates")).toBeVisible();
  await workbench.getByRole("radio", { name: /1080p\.WEB-DL/u }).click();
  await expect(workbench.getByText("Quality profile does not allow WEB-1080p")).toBeVisible();
  await workbench.getByRole("button", { name: "Review grab" }).click();

  const submit = workbench.getByRole("button", { name: "Send release" });
  await expect(submit).toBeDisabled();
  await workbench.getByRole("checkbox", { name: /reviewed the rejection evidence/u }).check();
  await expect(submit).toBeEnabled();
  await submit.focus();
  await expect(submit).toBeFocused();
  await submit.press("Enter");

  await expect(workbench.getByText("Release accepted")).toBeVisible();
  expect(capture.requests).toBe(1);
  expect(capture.body).toEqual({
    overrideRejections: true,
    releaseId: manualReleaseCandidates.rejected.id,
  });
  expect(capture.csrfToken).toBe(manualReleaseCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^manual-grab-[0-9a-f-]{36}$/u);
});

test("global search discloses live discovery with keyboard and touch-safe controls", async ({
  page,
}) => {
  await mockDiscoverySearch(page);
  await page.goto("/");

  const search = page.getByRole("combobox", { name: "Search media and commands" });
  await search.click();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await search.fill("matrix");
  const firstResult = page.getByRole("option", { name: /The Matrix/i });
  await expect(firstResult).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Matrix" })).toBeVisible();
  await expect(search).toHaveAttribute("aria-expanded", "true");

  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(firstResult).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Breaking Bad/i })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(search).toHaveValue("matrix");
});

test("global search preserves the document position while focusing and typing", async ({
  page,
}) => {
  await mockDiscoverySearch(page);
  await page.goto("/");

  const initialScrollPosition = await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    const maximum = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(1200, Math.max(0, maximum)));
    return window.scrollY;
  });
  expect(initialScrollPosition).toBeGreaterThan(200);

  const search = page.getByRole("combobox", { name: "Search media and commands" });
  const bounds = await search.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect(search).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(initialScrollPosition);

  for (const character of "matrix") {
    await page.keyboard.type(character);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(initialScrollPosition);
  }
  await expect(page.getByRole("option", { name: /The Matrix/i })).toBeVisible();
});

test("command palette reveals only destinations allowed by the current session", async ({
  page,
}) => {
  await mockMediaRequestSession(page);
  await page.goto("/");

  const search = page.getByRole("combobox", { name: "Search media and commands" });
  await search.click();
  await expect(page.getByRole("option", { name: /Calendar/i })).toHaveAttribute(
    "href",
    "/calendar",
  );
  await expect(page.getByRole("option", { name: /Download queue/i })).toHaveCount(0);

  await search.fill("d");
  await expect(page.getByRole("option", { name: /Discover/i })).toBeVisible();
  await expect(page.getByRole("option", { name: /Download queue/i })).toHaveCount(0);
  await expect(
    page.getByText(/Keep typing to search movies, series, and people too/i),
  ).toBeVisible();
});

test("media details preserve search context and expose a guarded request handoff", async ({
  page,
}) => {
  await mockDiscoverySearch(page);
  await mockDiscoveryDetails(page);
  await page.goto("/");

  const search = page.getByRole("combobox", { name: "Search media and commands" });
  await search.fill("matrix");
  await page.getByRole("button", { name: "View details for The Matrix" }).click();
  const drawer = page.locator("dialog.media-detail");
  await expect(page.getByRole("dialog", { name: "The Matrix details" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "The Matrix" })).toBeVisible();
  await expect(drawer.getByAltText("The Matrix poster")).toBeVisible();
  await expect(drawer.locator(".media-detail__cast-profile").first()).toBeVisible();
  await expect(drawer.getByText("83%")).toBeVisible();
  await expect(drawer.getByRole("link", { name: /official trailer/iu })).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=m8e-FF8MsqU",
  );
  await drawer.getByRole("button", { name: /Keanu Reeves/iu }).click();
  await expect(page.getByRole("dialog", { name: "Keanu Reeves person context" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Keanu Reeves" })).toBeVisible();
  await expect(drawer.getByAltText("Keanu Reeves portrait")).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Biography" })).toBeVisible();
  await drawer.getByRole("button", { name: "Back to The Matrix" }).click();
  await expect(page.getByRole("dialog", { name: "The Matrix details" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "The Matrix" })).toBeVisible();
  const requestAction = drawer.getByRole("button", { name: "Request The Matrix" });
  await requestAction.scrollIntoViewIfNeeded();
  await expect(requestAction).toBeInViewport();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  expect(
    await drawer
      .locator(".media-detail__scroll")
      .evaluate((scrollRegion) => scrollRegion.scrollWidth <= scrollRegion.clientWidth + 1),
  ).toBe(true);

  await drawer.getByRole("button", { name: "Close media details" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(search).toHaveValue("matrix");
});

test("request composer delegates a bounded request through the verified session", async ({
  page,
}) => {
  await mockDiscoverySearch(page);
  await mockMediaRequestSession(page);
  const capture = await mockMediaRequestCreation(page);
  await page.goto("/");

  await page.getByRole("combobox").fill("matrix");
  await page.getByRole("button", { name: "Request The Matrix" }).click();
  const composer = page.getByRole("dialog", { name: "Compose request" });
  await expect(composer).toBeVisible();
  await expect(composer.getByText("Mina’s Jellyfin")).toBeVisible();
  const submitAction = composer.getByRole("button", { name: /Send request/i });
  await expectStationaryPointerTarget(submitAction);
  const rootScrollBeforeSubmission = await page.evaluate(() => document.documentElement.scrollTop);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    "clip",
  );
  await submitAction.click();

  await expect(composer.getByRole("heading", { name: "The signal is in motion" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(
    rootScrollBeforeSubmission,
  );
  expect(capture.body).toEqual({ is4k: false, kind: "movie", tmdbId: 603 });
  expect(capture.csrfToken).toBe(mediaRequestCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^media-[0-9a-f-]{36}$/u);
  expect(JSON.stringify(capture.body)).not.toContain("userId");

  await composer.getByRole("button", { name: "Done" }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("option", { name: /The Matrix.*Requested/i })).toBeVisible();
});

test("request composer delegates opaque advanced routing without exposing storage paths", async ({
  page,
}) => {
  await mockDiscoverySearch(page);
  await mockMediaRequestSession(page);
  await mockMediaRequestRouting(page);
  const capture = await mockMediaRequestCreation(page);
  await page.goto("/");

  await page.getByRole("combobox").fill("matrix");
  await page.getByRole("button", { name: "Request The Matrix" }).click();
  const composer = page.getByRole("dialog", { name: "Compose request" });
  await composer.getByText("Advanced routing").click();
  await expect(composer.getByRole("combobox", { name: /Destination/i })).toHaveValue(
    mediaRequestRoutingReference("radarr-primary"),
  );
  await composer
    .getByRole("combobox", { name: /Quality profile/i })
    .selectOption(mediaRequestRoutingReference("quality-remux"));
  await composer
    .getByRole("combobox", { name: /Root folder/i })
    .selectOption(mediaRequestRoutingReference("root-archive"));
  await composer.getByRole("button", { name: /Send request/i }).click();

  await expect(composer.getByRole("heading", { name: "The signal is in motion" })).toBeVisible();
  expect(capture.body).toEqual({
    is4k: false,
    kind: "movie",
    routing: {
      destination: mediaRequestRoutingReference("radarr-primary"),
      languageProfile: null,
      qualityProfile: mediaRequestRoutingReference("quality-remux"),
      rootFolder: mediaRequestRoutingReference("root-archive"),
    },
    tmdbId: 603,
  });
  expect(JSON.stringify(capture.body)).not.toContain("/srv/");
  await expect(composer).not.toContainText("/srv/");
});

test("production-first onboarding remains a complete route", async ({ page }) => {
  await page.goto("/?test-view=onboarding");

  await expect(page).toHaveURL(/\/\?test-view=onboarding$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Two essentials stand between first sign-in and movie night.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Validate Jellyfin service" }).first(),
  ).toHaveAttribute("href", "/settings/connectors");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run stack verification" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(1);
});

test("operations navigation opens the system health workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Operations" })).toHaveAttribute(
    "href",
    "/operations/health",
  );
});

test("authenticated route changes preserve the primary application shell", async ({ page }) => {
  await page.goto("/?test-view=discovery-performance");

  const rail = page.locator(".navigation-rail");
  await rail.evaluate((element) => {
    element.dataset.persistenceProbe = "present";
  });
  await rail.getByRole("link", { name: "Operations" }).click();

  await expect(page).toHaveURL(/\/operations\/health$/u);
  await expect(rail).toHaveAttribute("data-persistence-probe", "present");
  await expect(rail.getByRole("link", { name: "Operations" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".navigation-rail")).toHaveCount(1);
  await expect(page.locator(".top-command-bar")).toHaveCount(1);
  await expect(page.locator("#main-content")).toHaveCount(1);

  await rail.getByRole("link", { name: "Requests" }).click();
  await expect(page).toHaveURL(/\/operations\/requests$/u);
  await expect(rail).toHaveAttribute("data-persistence-probe", "present");
  await expect(rail.getByRole("link", { name: "Requests" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("system health preserves partial service visibility and private storage boundaries", async ({
  page,
}) => {
  await page.goto("/operations/health?test-view=degraded");

  await expect(
    page.getByRole("heading", { name: "The stack is holding, with gaps." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Cinema" })).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Television" })).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Indexers" })).toBeVisible();
  await expect(
    page.getByText("Indexers did not answer before the connector timeout."),
  ).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Cinema storage 1: 11 percent free" }),
  ).toHaveAttribute("aria-valuenow", "11");
  await expect(page.getByText(/private mount paths never leave the gateway/iu)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/srv/");
});

test("system health links every operational workspace and switches appearance", async ({
  page,
}) => {
  await page.goto("/operations/health?test-view=ready");

  await expect(page.getByRole("link", { name: "Downloads" })).toHaveAttribute(
    "href",
    "/operations/downloads",
  );
  await expect(page.getByRole("link", { name: "Indexers" })).toHaveAttribute(
    "href",
    "/operations/indexers",
  );
  await page.getByRole("radio", { name: "Light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("download queue supports focused search and attention filtering", async ({ page }) => {
  await page.goto("/operations/downloads?test-view=ready");
  await expect(page.getByRole("heading", { name: "Every byte, in motion." })).toBeVisible();
  const promotions = page.getByRole("button", { name: /^Move .+ to front of queue$/u });
  await expect(promotions).toHaveCount(3);
  const promotionTarget = await promotions.first().boundingBox();
  expect(promotionTarget).not.toBeNull();
  expect(promotionTarget!.height).toBeGreaterThanOrEqual(44);
  expect(promotionTarget!.width).toBeGreaterThanOrEqual(44);

  await page.getByRole("button", { name: "Attention" }).click();
  await expect(page.getByText("Glass.Horizon.2025.1080p.BluRay")).toBeVisible();
  await expect(page.getByText("Signal.S01E07.1080p.WEB-DL")).toHaveCount(0);

  await page.getByRole("button", { name: "All" }).click();
  await page.getByRole("searchbox", { name: "Search downloads" }).fill("signal");
  await expect(page.getByText("Signal.S01E07.1080p.WEB-DL")).toBeVisible();
  await expect(page.getByText("Glass.Horizon.2025.1080p.BluRay")).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search downloads" }).fill("");
  const resume = page.getByRole("button", { name: "Resume Signal.S01E07.1080p.WEB-DL" });
  await resume.click();
  await expect(page.getByText("Resume this transfer?")).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await expectStationaryPointerTarget(cancel);
  await cancel.click();
  await expect(resume).toBeFocused();
});

test("download queue bulk controls preserve exact filtered scope and cancel focus", async ({
  page,
}) => {
  await page.goto("/operations/downloads?test-view=ready");
  const pause = page.getByRole("button", { name: "Pause 1 active transfer" });
  await expect(pause).toBeEnabled();
  await expect(
    page.getByText(/All visible transfers · 2 clients · exact targets only/u),
  ).toBeVisible();
  await pause.click();
  await expect(page.getByText("Pause 1 transfer?")).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await expectStationaryPointerTarget(cancel);
  await cancel.click();
  await expect(pause).toBeFocused();

  await page.getByRole("button", { name: "Attention" }).click();
  await expect(page.getByRole("button", { name: "Pause 0 active transfers" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Resume 0 paused transfers" })).toBeDisabled();
  await expect(page.getByText(/Filtered scope · 1 client · exact targets only/u)).toBeVisible();
});

test("indexer intelligence hydrates without changing deterministic telemetry", async ({ page }) => {
  const hydrationErrors: string[] = [];
  const recordHydrationError = (message: string) => {
    if (/hydration|server rendered html|server-rendered html/iu.test(message)) {
      hydrationErrors.push(message);
    }
  };

  page.on("console", (message) => {
    if (message.type() === "error") recordHydrationError(message.text());
  });
  page.on("pageerror", (error) => recordHydrationError(error.message));

  await page.goto("/operations/indexers?test-view=ready");
  await expect(page.getByRole("heading", { name: "Know every source." })).toBeVisible();
  await expect(page.getByText("Jul 27, 5:18 PM UTC", { exact: true })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});

test("ten-foot posters support directional focus with focus-safe scrolling", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "ten-foot",
    "Directional remote behavior uses the 10-foot profile.",
  );
  await mockDiscoveryFeed(page);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-profile=ten-foot&test-view=continue-watching-live");

  const discover = page.getByRole("link", { name: "Discover" });
  await discover.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("link", { name: "Library" })).toBeFocused();

  const search = page.getByRole("combobox");
  await search.focus();
  await page.keyboard.press("ArrowRight");
  const status = page.getByRole("button", { name: "One service needs attention" });
  await expect(status).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Open profile menu" })).toBeFocused();

  const details = page.getByRole("button", { exact: true, name: "View details" });
  await details.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Request title" })).toBeFocused();

  const firstPoster = page.getByRole("button", { name: "View details for The Far Meridian" });
  const secondPoster = page.getByRole("button", { name: "View details for The Quiet Archive" });
  await firstPoster.evaluate((poster) => poster.focus({ preventScroll: true }));
  await page.keyboard.press("ArrowRight");

  await expect(secondPoster).toBeFocused();
  await expect
    .poll(() =>
      secondPoster.evaluate((poster) => {
        const box = poster.getBoundingClientRect();
        const commandBottom = document
          .querySelector<HTMLElement>(".top-command-bar")!
          .getBoundingClientRect().bottom;
        return box.top >= commandBottom + 5 && box.bottom <= window.innerHeight - 5;
      }),
    )
    .toBe(true);

  await page.keyboard.press("End");
  const lastPoster = page.getByRole("button", { name: "View details for Monolith Season" });
  await expect(lastPoster).toBeFocused();
  const edgeScrollPosition = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowRight");
  await expect(lastPoster).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate((position) => Math.abs(window.scrollY - position), edgeScrollPosition),
    )
    .toBeLessThanOrEqual(3);

  await page.goto("/?test-profile=ten-foot");
  const firstCalendarItem = page.getByRole("button", { name: /Signal \/ 1×07/i });
  await firstCalendarItem.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: /The Long Meridian/i })).toBeFocused();

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.click();
  await operations.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /The Far Meridian/i })).toBeFocused();

  const typeSizes = await page.evaluate(() => ({
    button: Number.parseFloat(
      getComputedStyle(document.querySelector(".button--primary")!).fontSize,
    ),
    metadata: Number.parseFloat(
      getComputedStyle(document.querySelector(".media-card__copy p")!).fontSize,
    ),
    calendarDate: Number.parseFloat(
      getComputedStyle(document.querySelector(".calendar-item__day")!).fontSize,
    ),
    serviceStatus: Number.parseFloat(
      getComputedStyle(document.querySelector(".connection-pulse__label")!).fontSize,
    ),
    title: Number.parseFloat(
      getComputedStyle(document.querySelector(".media-card__copy h3")!).fontSize,
    ),
  }));
  expect(typeSizes.button).toBeGreaterThanOrEqual(22);
  expect(typeSizes.calendarDate).toBeGreaterThanOrEqual(18);
  expect(typeSizes.metadata).toBeGreaterThanOrEqual(19);
  expect(typeSizes.serviceStatus).toBeGreaterThanOrEqual(19);
  expect(typeSizes.title).toBeGreaterThanOrEqual(22);
});

test("mobile navigation leaves primary actions and focus rings unobscured", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile",
    "Geometry regression is tied to the phone viewport.",
  );
  await page.goto("/");

  const geometry = await page.evaluate(() => {
    const navigation = document.querySelector<HTMLElement>(".mobile-navigation")!;
    const navigationBox = navigation.getBoundingClientRect();
    const navigationItems = Array.from(
      navigation.querySelectorAll<HTMLElement>(".mobile-navigation__item"),
    ).map((item) => {
      const box = item.getBoundingClientRect();
      return { height: box.height, top: Math.round(box.top), width: box.width };
    });
    const firstRailHeading = document
      .querySelector<HTMLElement>(".media-rail .section-heading")!
      .getBoundingClientRect();
    const actions = Array.from(
      document.querySelectorAll<HTMLElement>(".hero-spotlight__actions .button"),
    ).map((action) => {
      const box = action.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 1);
      return {
        bottomWithFocusOffset: box.bottom + 3,
        hitOwnControl: hit === action || action.contains(hit),
        navigationTop: navigationBox.top,
      };
    });
    const heroBox = document.querySelector<HTMLElement>(".hero-spotlight")!.getBoundingClientRect();
    return {
      actions,
      firstRailHeadingBottom: firstRailHeading.bottom,
      firstRailHeadingTop: firstRailHeading.top,
      heroBottom: heroBox.bottom,
      navigationBottom: navigationBox.bottom,
      navigationItems,
      navigationTop: navigationBox.top,
    };
  });

  expect(geometry.actions).toHaveLength(2);
  expect(geometry.navigationItems).toHaveLength(6);
  expect(new Set(geometry.navigationItems.map((item) => item.top)).size).toBe(1);
  for (const item of geometry.navigationItems) {
    expect(item.height).toBeGreaterThanOrEqual(44);
    expect(item.width).toBeGreaterThanOrEqual(44);
  }
  expect(geometry.heroBottom + 8).toBeLessThanOrEqual(geometry.navigationTop);
  expect(
    geometry.firstRailHeadingBottom <= geometry.navigationTop - 8 ||
      geometry.firstRailHeadingTop >= geometry.navigationBottom + 8,
  ).toBe(true);
  for (const action of geometry.actions) {
    expect(action.hitOwnControl).toBe(true);
    expect(action.bottomWithFocusOffset).toBeLessThanOrEqual(action.navigationTop);
  }
  await expect(page.locator(".connection-pulse > svg")).toBeVisible();

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.click();
  await operations.focus();
  await page.keyboard.press("ArrowDown");
  const firstOperation = page.getByRole("button", { name: /The Far Meridian/i });
  await expect(firstOperation).toBeFocused();
  await expect
    .poll(() =>
      firstOperation.evaluate((operation) => {
        const box = operation.getBoundingClientRect();
        const navigationTop = document
          .querySelector<HTMLElement>(".mobile-navigation")!
          .getBoundingClientRect().top;
        return box.bottom <= navigationTop - 4;
      }),
    )
    .toBe(true);

  await mockDiscoveryFeed(page);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-view=continue-watching-live");
  const firstPoster = page.getByRole("button", { name: "View details for The Far Meridian" });
  const secondPoster = page.getByRole("button", { name: "View details for The Quiet Archive" });
  await firstPoster.evaluate((poster) => poster.focus({ preventScroll: true }));
  await page.keyboard.press("ArrowRight");
  await expect(secondPoster).toBeFocused();
  await expect
    .poll(() =>
      secondPoster.evaluate((poster) => {
        const box = poster.getBoundingClientRect();
        const commandBottom = document
          .querySelector<HTMLElement>(".top-command-bar")!
          .getBoundingClientRect().bottom;
        const navigationTop = document
          .querySelector<HTMLElement>(".mobile-navigation")!
          .getBoundingClientRect().top;
        return box.top >= commandBottom + 4 && box.bottom <= navigationTop - 4;
      }),
    )
    .toBe(true);

  await page.goto("/?test-view=onboarding");
  await expect(page.locator(".mobile-navigation")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Validate Jellyfin service" }).first()).toBeVisible();
});

test("lifted media cards stay inside a seamless rail", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One desktop engine covers hover geometry and transparent rail surfaces.",
  );
  await mockDiscoveryFeed(page);
  await mockQuietContinueWatching(page);
  await page.goto("/?test-view=continue-watching-live");

  const firstPoster = page.getByRole("button", { name: "View details for The Far Meridian" });
  await firstPoster
    .locator("xpath=ancestor::*[contains(@class, 'media-rail__scroller')]")
    .evaluate((scroller) => {
      (scroller as HTMLElement).style.gridAutoColumns = "1000px";
    });
  await firstPoster.hover({ position: { x: 120, y: 120 } });

  await expect
    .poll(() =>
      firstPoster.evaluate((poster) => {
        const cardBox = poster.getBoundingClientRect();
        const scrollerBox = poster
          .closest<HTMLElement>(".media-rail__scroller")!
          .getBoundingClientRect();
        return cardBox.top - scrollerBox.top;
      }),
    )
    .toBeGreaterThanOrEqual(1);

  await expect
    .poll(() =>
      firstPoster.evaluate((poster) => {
        const cardBox = poster.getBoundingClientRect();
        const scrollerBox = poster
          .closest<HTMLElement>(".media-rail__scroller")!
          .getBoundingClientRect();
        return cardBox.left - scrollerBox.left;
      }),
    )
    .toBeGreaterThanOrEqual(1);

  const railBackgrounds = await firstPoster
    .locator("xpath=ancestor::section[contains(@class, 'media-rail')]")
    .evaluate((rail) => {
      const scroller = rail.querySelector<HTMLElement>(".media-rail__scroller")!;
      return [getComputedStyle(rail).backgroundColor, getComputedStyle(scroller).backgroundColor];
    });
  expect(railBackgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
});

test("liquid glass chrome responds optically to pointer position", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One desktop engine verifies the progressive pointer-light enhancement.",
  );
  await page.goto("/");

  const search = page.locator(".global-search");
  const bounds = await search.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.72, bounds!.y + bounds!.height * 0.45);

  await expect(search).toHaveAttribute("data-glass-active", "");
  await expect(page.locator("html")).not.toHaveAttribute("data-liquid-glass-ready", "");
  await page.keyboard.press("Tab");
  await expect(page.locator("html")).toHaveAttribute("data-liquid-glass-ready", "");
  const optics = await search.evaluate((surface) => {
    const style = getComputedStyle(surface);
    return {
      backdrop: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
      pointerX: (surface as HTMLElement).style.getPropertyValue("--glass-pointer-x"),
      pointerY: (surface as HTMLElement).style.getPropertyValue("--glass-pointer-y"),
    };
  });
  expect(optics.backdrop).toContain("blur");
  expect(Number.parseFloat(optics.pointerX)).toBeCloseTo(72, 0);
  expect(Number.parseFloat(optics.pointerY)).toBeCloseTo(45, 0);

  await page.mouse.move(700, 650);
  await expect(search).not.toHaveAttribute("data-glass-active", "");
});

test("touch users can disclose operations and navigate to settings", async ({ page }, testInfo) => {
  test.skip(
    !testInfo.project.use.hasTouch,
    "Touch interaction is covered by phone and tablet profiles.",
  );
  await page.goto("/");

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.tap();
  await expect(operations).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("link", { name: "Settings" }).tap();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Your identity, under your control." }),
  ).toBeVisible();
});

test("reduced motion removes nonessential transition travel", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One representative engine verifies the media query.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator(".media-card__action").first().waitFor();

  const motion = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".media-card__action")!;
    const durations = getComputedStyle(card)
      .transitionDuration.split(",")
      .map((duration) =>
        duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000,
      );
    return {
      maxTransitionMilliseconds: Math.max(...durations),
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });

  expect(motion.reduced).toBe(true);
  expect(motion.maxTransitionMilliseconds).toBeLessThanOrEqual(0.01);
  expect(motion.scrollBehavior).toBe("auto");

  const search = page.locator(".global-search");
  const bounds = await search.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect(search).not.toHaveAttribute("data-glass-active", "");
});

test("skip link reaches the main dashboard", async ({ browserName, page }, testInfo) => {
  test.skip(
    Boolean(testInfo.project.use.hasTouch),
    "Skip links are verified in keyboard-capable profiles.",
  );
  await page.goto("/");
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});
