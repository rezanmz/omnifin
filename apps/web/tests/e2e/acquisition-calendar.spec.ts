import { expect, test } from "@playwright/test";

test("dashboard calendar entry points open the complete release observatory", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute(
    "href",
    "/calendar",
  );
  await expect(
    page
      .getByRole("region", { exact: true, name: "The Far Meridian" })
      .getByRole("link", { name: "Open calendar" }),
  ).toHaveAttribute("href", "/calendar");
  await expect(
    page.getByRole("region", { name: "This week" }).getByRole("link", { name: "Open calendar" }),
  ).toHaveAttribute("href", "/calendar");
});

test("calendar supports focused filtering and contextual event details", async ({ page }) => {
  await page.goto("/calendar?test-view=ready");
  await expect(page.getByRole("heading", { name: "See what arrives next." })).toBeVisible();

  await page.getByRole("button", { name: "Attention" }).click();
  await expect(page.getByRole("button", { name: /Inspect Glass Horizon/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Inspect Signal, S01E07/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Inspect The Far Meridian/i })).toHaveCount(0);

  const eventCard = page.getByRole("button", { name: /Inspect Glass Horizon/i });
  await eventCard.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Glass Horizon" })).toBeVisible();
  await expect(drawer.getByText("Read-only calendar signal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(eventCard).toBeFocused();
});

test("calendar title search preserves the verified source plane", async ({ page }) => {
  await page.goto("/calendar?test-view=ready");
  await page.getByRole("searchbox", { name: "Search calendar" }).fill("orison");

  await expect(page.getByRole("button", { name: /Inspect Last Light at Orison/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Inspect Signal/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Radarr · Cinema" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sonarr · Television" })).toBeVisible();
});

test("calendar month view keeps every day and event detail reachable", async ({ page }) => {
  await page.goto("/calendar?test-view=month");

  await expect(page.getByRole("heading", { name: "Month at a glance" })).toBeVisible();
  await expect(
    page.getByRole("grid", { name: /Month acquisition calendar, July 2026/u }),
  ).toBeVisible();
  await expect(page.getByRole("gridcell")).toHaveCount(42);
  await expect(page.getByRole("button", { name: "Month view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const eventCard = page.getByRole("button", { name: /Inspect The Far Meridian/i });
  await eventCard.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "The Far Meridian" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(eventCard).toBeFocused();
});
