import { expect, test } from "@playwright/test";

test("administrator readiness keeps core and optional progress distinct", async ({ page }) => {
  await page.goto("/onboarding?test-view=partial");

  await expect(page.getByRole("progressbar", { name: "Essential setup progress" })).toHaveAttribute(
    "aria-valuenow",
    "2",
  );
  await expect(page.getByText("2 of 2 essentials ready")).toBeVisible();
  await expect(page.getByText("3 of 6 stack extensions ready")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Production posture is ready." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OpenID Connect" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Movie & series automation" })).toBeVisible();
  await expect(page.getByText("Partially ready", { exact: true })).toBeVisible();
  await expect(page.getByText(/recovery secret|jellyfin-user-1|example\.test/iu)).toHaveCount(0);
});

test("deployment attention remains actionable without hiding connector readiness", async ({
  page,
}) => {
  await page.goto("/onboarding?test-view=deployment-attention");

  await expect(
    page.getByRole("heading", { name: "Finish the host hardening boundary." }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Deployment readiness checks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Core is ready/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Review the deployment boundary/i })).toHaveAttribute(
    "href",
    /docs\/deployment\.md/u,
  );
});

test("deployment-check failure preserves the independently verified stack snapshot", async ({
  page,
}) => {
  await page.goto("/onboarding?test-view=deployment-unavailable");

  await expect(
    page.getByRole("heading", { name: "Deployment posture could not be verified." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Check host again/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Core is ready/u })).toBeVisible();
});

test("the next core action is keyboard reachable and exact", async ({ page }) => {
  await page.goto("/onboarding?test-view=needs-core");

  const nextAction = page.getByRole("link", { name: /Validate Jellyfin service/i }).first();
  await nextAction.focus();
  await expect(nextAction).toBeFocused();
  await expect(nextAction).toHaveAttribute("href", "/settings/connectors");
});

test("setup appearance follows an explicit light preference", async ({ page }) => {
  await page.goto("/onboarding?test-view=partial");

  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
});
