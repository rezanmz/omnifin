import { expect, test } from "@playwright/test";

test("login exposes OIDC and Jellyfin without implying account matching", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome to your control room." })).toBeVisible();
  await expect(page.locator(".login-card__header")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".login-card__header")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("link", { name: /Continue with Authentik/i })).toHaveAttribute(
    "href",
    "/api/auth/oidc/authentik/start",
  );
  await expect(page.getByRole("link", { name: /Continue with Jellyfin/i })).toHaveAttribute(
    "href",
    "/login/jellyfin",
  );
});

test("production-first login explains an unconfigured identity boundary", async ({ page }) => {
  await page.goto("/login?test-view=unconfigured");

  await expect(page.getByRole("status")).toContainText("No sign-in providers are configured");
  await expect(page.getByRole("link", { name: /Continue with/i })).toHaveCount(0);
});

test("login renders only allowlisted authentication feedback", async ({ page }) => {
  await page.goto("/login?authError=invalid_request");
  await expect(page.locator(".login-card__auth-error")).toContainText(
    "That sign-in attempt expired or was already used.",
  );

  await page.goto("/login?authError=private-upstream-canary");
  await expect(page.locator(".login-card__auth-error")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("private-upstream-canary");

  await page.goto("/login?authError=session_limit_reached");
  await expect(page.locator(".login-card__auth-error")).toContainText("sign-in safety limit");
});

test("login distinguishes a temporary control-plane failure", async ({ page }) => {
  await page.goto("/login?test-view=unavailable");
  await expect(page.getByRole("status")).toContainText("The control plane is unavailable");
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
});

test("login bounds fifty providers without clipping labels or TV focus", async ({ page }) => {
  await page.goto("/login?test-view=provider-overflow");
  const list = page.getByRole("list", { name: "Sign-in methods" });
  const interactiveProviders = list.locator("[data-directional-item]");

  await expect(list.locator(":scope > li")).toHaveCount(50);
  await expect(interactiveProviders).toHaveCount(49);
  const geometry = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  const first = interactiveProviders.first();
  const last = interactiveProviders.last();
  await first.focus();
  await first.press("End");
  await expect(last).toBeFocused();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const [listBox, lastBox] = await Promise.all([list.boundingBox(), last.boundingBox()]);
      return Boolean(
        listBox &&
        lastBox &&
        lastBox.y >= listBox.y + 5 &&
        lastBox.y + lastBox.height <= listBox.y + listBox.height - 5,
      );
    })
    .toBe(true);
  const lastBounds = await Promise.all([list.boundingBox(), last.boundingBox()]);
  expect(lastBounds[0]).not.toBeNull();
  expect(lastBounds[1]).not.toBeNull();
  expect(lastBounds[1]!.y).toBeGreaterThanOrEqual(lastBounds[0]!.y + 5);
  expect(lastBounds[1]!.y + lastBounds[1]!.height).toBeLessThanOrEqual(
    lastBounds[0]!.y + lastBounds[0]!.height - 5,
  );

  await last.press("Home");
  await expect(first).toBeFocused();
});

test("Jellyfin credential sign-in keeps password bytes out of the URL and clears a denial", async ({
  page,
}) => {
  let submittedBody = "";
  await page.route("**/api/auth/jellyfin/password", async (route) => {
    submittedBody = route.request().postData() ?? "";
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: "authentication_denied",
          message: "The Jellyfin username or password was not accepted.",
          requestId: "fixture-request",
        },
      }),
      contentType: "application/json",
      status: 401,
    });
  });
  await page.goto("/login/jellyfin");

  await expect(page.getByRole("heading", { name: "Step into your library." })).toBeVisible();
  await page.getByRole("textbox", { name: "Username" }).fill("riley");
  await page.getByRole("textbox", { name: "Password" }).fill("private-password");
  await page.getByRole("button", { name: "Continue to Omnifin" }).click();

  await expect(page.locator('.jellyfin-login-form__feedback [role="alert"]')).toContainText(
    "was not accepted",
  );
  await expect(page.getByRole("textbox", { name: "Password" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Password" })).toBeFocused();
  expect(JSON.parse(submittedBody)).toEqual({ password: "private-password", username: "riley" });
  expect(page.url()).not.toContain("private-password");
});

test("Jellyfin credential controls remain keyboard-usable and meet target geometry", async ({
  page,
}) => {
  await page.goto("/login/jellyfin");
  const password = page.getByRole("textbox", { name: "Password" });
  const reveal = page.getByRole("button", { name: "Show password" });

  await password.fill("private-password");
  await password.press("Tab");
  await expect(reveal).toBeFocused();
  await reveal.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  const hiddenReveal = page.getByRole("button", { name: "Hide password" });
  await expect(hiddenReveal).toBeFocused();
  const bounds = await hiddenReveal.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
});
