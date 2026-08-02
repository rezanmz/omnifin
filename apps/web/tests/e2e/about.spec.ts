import { expect, test } from "@playwright/test";

test("about exposes exact verified provenance without contacting the source host", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://github.com/")) externalRequests.push(request.url());
  });

  await page.goto("/about?test-view=verified");

  await expect(page.getByRole("heading", { name: "Know exactly what is running." })).toBeVisible();
  await expect(page.getByText("Release verified")).toBeVisible();
  await expect(page.getByText("1.0.0")).toBeVisible();
  const source = page.getByRole("link", { name: "View corresponding source" });
  await expect(source).toHaveAttribute(
    "href",
    "https://github.com/rezanmz/omnifin/tree/0123456789abcdef0123456789abcdef01234567",
  );
  await expect(source).toHaveAttribute("rel", "noreferrer");
  expect(externalRequests).toEqual([]);
});

test("about distinguishes development and unavailable build identities", async ({ page }) => {
  await page.goto("/about?test-view=development");
  await expect(page.getByText("Development build")).toBeVisible();
  await expect(page.getByText("Not release-verified")).toBeVisible();
  await expect(page.getByText("Local development")).toBeVisible();

  await page.goto("/about?test-view=unavailable");
  await expect(page.getByRole("status")).toContainText("Build identity is unavailable");
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/about");
  await expect(page.getByRole("link", { name: /source/i })).toHaveCount(0);
});

test("about provides persistent theme controls before sign-in", async ({ page }) => {
  await page.goto("/about?test-view=verified");

  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("radio", { name: "Light" })).toBeChecked();
});

test("about keeps all build-passport actions inside narrow phone geometry", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Phone geometry uses the mobile project");
  await page.goto("/about?test-view=verified");

  await expect(page.getByRole("button", { name: "Copy support identity" })).toBeVisible();
  await expect(page.getByRole("link", { name: "View corresponding source" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
