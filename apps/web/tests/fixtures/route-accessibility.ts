import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function expectRouteAccessible(page: Page, path: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(path);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const deferredLoadingLabel = path.startsWith("/settings/audit")
    ? "Loading operator audit trail"
    : path.startsWith("/settings/users")
      ? "Loading user access administration"
      : path.startsWith("/settings/connectors")
        ? "Loading service connections"
        : path.startsWith("/calendar")
          ? "Loading acquisition calendar"
          : undefined;

  if (deferredLoadingLabel) {
    await page.getByLabel(deferredLoadingLabel).waitFor({ state: "hidden" });
  }

  await page.evaluate(() => document.fonts.ready);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}
