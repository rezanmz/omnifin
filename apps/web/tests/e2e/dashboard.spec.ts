import { expect, test } from "@playwright/test";
import { mockDiscoverySearch } from "../fixtures/discovery";

test("dashboard supports keyboard-first operational disclosure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "The Far Meridian" })).toBeVisible();

  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.focus();
  await page.keyboard.press("Enter");
  await expect(operations).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /Signal · S01E07/i })).toBeVisible();
});

test("global search discloses live discovery with keyboard and touch-safe controls", async ({
  page,
}, testInfo) => {
  await mockDiscoverySearch(page);
  await page.goto("/");

  const search = page.getByRole("combobox", { name: "Search movies, series, and people" });
  await search.fill("matrix");
  const firstResult = page.getByRole("option", { name: /The Matrix/i });
  await expect(firstResult).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("heading", { name: "The Matrix" })).toHaveCount(0);
  } else {
    await expect(page.getByRole("heading", { name: "The Matrix" })).toBeVisible();
  }
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

test("production-first onboarding remains a complete route", async ({ page }) => {
  await page.goto("/?test-view=onboarding");

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
    page.getByRole("heading", { name: "Account setup is still being secured." }),
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
