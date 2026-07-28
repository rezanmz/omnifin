import { expect, test } from "@playwright/test";
import {
  acquisitionRecoveryCsrfToken,
  mockAcquisitionRecoverySession,
  mockAcquisitionSearch,
} from "../fixtures/acquisition-recovery";
import { mockDiscoverySearch } from "../fixtures/discovery";
import {
  mediaRequestCsrfToken,
  mockMediaRequestCreation,
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

test("dashboard supports keyboard-first operational disclosure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.focus();
  await page.keyboard.press("Enter");
  await expect(operations).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /Signal · S01E07/i })).toBeVisible();
});

test("operators can inspect a title-level acquisition trace before choosing recovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();

  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await expect(timeline).toBeVisible();
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

test("operators can queue one exact-target acquisition search", async ({ page }) => {
  await mockAcquisitionRecoverySession(page);
  const capture = await mockAcquisitionSearch(page);
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();

  const timeline = page.getByRole("dialog", { name: "Signal history" });
  await timeline.getByRole("button", { name: "Review search" }).click();
  await expect(timeline.getByText(/library files remain untouched/u)).toBeVisible();
  await expect(timeline.getByRole("button", { name: /delete|blocklist|remove/i })).toHaveCount(0);
  await timeline.getByRole("button", { name: "Queue search" }).click();

  await expect(timeline.getByText("Acquisition search is in motion")).toBeVisible();
  expect(capture.body).toEqual({ mediaId: 42, service: "radarr" });
  expect(capture.csrfToken).toBe(acquisitionRecoveryCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^acquisition-[0-9a-f-]{36}$/u);
});

test("operators can compare and explicitly override one exact manual release", async ({ page }) => {
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
  await submit.click();

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

  const search = page.getByRole("combobox", { name: "Search movies, series, and people" });
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
  await composer.getByRole("button", { name: /Send request/i }).click();

  await expect(composer.getByRole("heading", { name: "The signal is in motion" })).toBeVisible();
  expect(capture.body).toEqual({ is4k: false, kind: "movie", tmdbId: 603 });
  expect(capture.csrfToken).toBe(mediaRequestCsrfToken);
  expect(capture.idempotencyKey).toMatch(/^media-[0-9a-f-]{36}$/u);
  expect(JSON.stringify(capture.body)).not.toContain("userId");

  await composer.getByRole("button", { name: "Done" }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("option", { name: /The Matrix.*Requested/i })).toBeVisible();
});

test("production-first onboarding remains a complete route", async ({ page }) => {
  await page.goto("/?test-view=onboarding");

  await expect(page).toHaveURL(/\/\?test-view=onboarding$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Your media control room is being prepared." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Review account access" })).toHaveAttribute(
    "href",
    "/settings",
  );
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
});

test("operations navigation opens the live download queue workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Operations" })).toHaveAttribute(
    "href",
    "/operations/downloads",
  );
});

test("download queue supports focused search and attention filtering", async ({ page }) => {
  await page.goto("/operations/downloads?test-view=ready");
  await expect(page.getByRole("heading", { name: "Every byte, in motion." })).toBeVisible();

  await page.getByRole("button", { name: "Attention" }).click();
  await expect(page.getByText("Glass.Horizon.2025.1080p.BluRay")).toBeVisible();
  await expect(page.getByText("Signal.S01E07.1080p.WEB-DL")).toHaveCount(0);

  await page.getByRole("button", { name: "All" }).click();
  await page.getByRole("searchbox", { name: "Search downloads" }).fill("signal");
  await expect(page.getByText("Signal.S01E07.1080p.WEB-DL")).toBeVisible();
  await expect(page.getByText("Glass.Horizon.2025.1080p.BluRay")).toHaveCount(0);
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
  await page.goto("/?test-profile=ten-foot");

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

  const play = page.getByRole("button", { name: "Play now" });
  await play.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Details" })).toBeFocused();

  const firstPoster = page.getByRole("button", { name: "Open Ember Coast" });
  const secondPoster = page.getByRole("button", { name: "Open The Quiet Archive" });
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
  const lastPoster = page.getByRole("button", { name: "Open Field Notes" });
  await expect(lastPoster).toBeFocused();
  const edgeScrollPosition = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowRight");
  await expect(lastPoster).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate((position) => Math.abs(window.scrollY - position), edgeScrollPosition),
    )
    .toBeLessThanOrEqual(3);

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
      navigationTop: navigationBox.top,
    };
  });

  expect(geometry.actions).toHaveLength(2);
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

  const firstPoster = page.getByRole("button", { name: "Open Ember Coast" });
  const secondPoster = page.getByRole("button", { name: "Open The Quiet Archive" });
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

  await page.goto("/?test-view=onboarding");
  await expect(page.locator(".mobile-navigation")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review account access" })).toBeVisible();
});

test("lifted media cards stay inside a seamless rail", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One desktop engine covers hover geometry and transparent rail surfaces.",
  );
  await page.goto("/");

  const firstPoster = page.getByRole("button", { name: "Open Ember Coast" });
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

  const railBackgrounds = await page
    .locator(".media-rail")
    .first()
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
