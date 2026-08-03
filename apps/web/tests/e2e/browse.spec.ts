import { expect, test } from "@playwright/test";

import { mockDiscoveryArtwork, mockDiscoveryBrowse } from "../fixtures/discovery";
import { mockMediaRequestSession } from "../fixtures/media-request";

test("browse keeps filtering, title context, and requests in one persistent workspace", async ({
  page,
}) => {
  await mockDiscoveryBrowse(page);
  await mockMediaRequestSession(page);
  await page.goto("/browse?test-view=ready");

  await expect(page.getByRole("heading", { name: "Browse without the guesswork." })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View details for The Far Meridian" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Request The Far Meridian" }).click();
  await expect(page.getByRole("dialog", { name: "Compose request" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Series" }).click();
  await expect(page).toHaveURL(/\/browse\?kind=series&minimumRating=7$/u);
  await expect(
    page.getByRole("button", { name: "View details for The Far Meridian Files" }),
  ).toBeVisible();
  await expect(page.getByText("238 candidates · page 1")).toBeVisible();
});

test("browse test data remains isolated from arbitrary public query parameters", async ({
  page,
}) => {
  await mockDiscoveryArtwork(page);
  await page.goto("/browse?test-view=ready&unexpected=private-upstream");

  await expect(
    page.getByText("Some shared filters were invalid and have been safely reset."),
  ).toBeVisible();
  await expect(page.getByText("private-upstream")).toHaveCount(0);
});

test("mobile Browse content clears the persistent liquid-glass navigation", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 393 });
  await mockDiscoveryBrowse(page);
  await page.goto("/browse?test-view=ready");

  const browser = page.locator("main");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const resultsHeading = page.getByRole("heading", { name: "Movies" });

  await expect(browser).toHaveCSS("gap", "16px");
  await expect(browser).toHaveCSS("padding-bottom", "104px");

  const navigationBox = await navigation.boundingBox();
  const headingBox = await resultsHeading.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(navigationBox!.y - 4);
});
