import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test("system appearance follows live operating-system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme-preference", "system");
  await expect(root).toHaveAttribute("data-resolved-theme", "light");
  await expect(root).not.toHaveAttribute("data-theme");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-resolved-theme", "dark");
  await expect(root).not.toHaveAttribute("data-theme");
});

test("explicit appearance persists and overrides the operating system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");
  await page.getByRole("radio", { name: /light/i }).click();

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-resolved-theme", "light");

  await page.reload();
  await expect(page.getByRole("radio", { name: /light/i })).toBeChecked();
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-resolved-theme", "light");
});

test("dashboard profile controls expose appearance and account access", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open profile menu" });
  await trigger.click();

  await expect(page.getByRole("dialog", { name: "Profile and appearance" })).toBeVisible();
  await expect(page.getByRole("link", { name: /account & access/i })).toHaveAttribute(
    "href",
    "/settings",
  );
  await page.getByRole("radio", { name: /dark/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Profile and appearance" })).toBeHidden();
  await expect(trigger).toBeFocused();
});
