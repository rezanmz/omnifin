import { expect, type Page } from "@playwright/test";

export async function expandOperationsDock(page: Page) {
  const disclosure = page.getByRole("button", { name: /2 acquisitions moving/i });
  await expect(disclosure).toBeEnabled();
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
    await disclosure.click();
  }
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#operations-details")).toBeVisible();
}
