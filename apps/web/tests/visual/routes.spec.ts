import { expect, test } from "@playwright/test";

const visualProjects = new Set(["chromium", "mobile", "tablet", "ten-foot"]);
const stateVisualProjects = new Set(["chromium", "mobile"]);

test.use({ contextOptions: { reducedMotion: "reduce" } });

function routeForProject(path: string, projectName: string) {
  if (projectName !== "ten-foot") return path;
  const url = new URL(path, "http://omnifin.test");
  url.searchParams.set("test-profile", "ten-foot");
  return `${url.pathname}${url.search}`;
}

test("dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true });
});

test("first-run dashboard visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/?test-view=onboarding", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("dashboard-onboarding.png", { fullPage: true });
});

test("login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("login.png", { fullPage: true });
});

test("Jellyfin credential login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login/jellyfin", testInfo.project.name));
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login.png", { fullPage: true });
});

test("Jellyfin credential denial visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Credential errors cover representative desktop and phone geometry",
  );
  await page.goto("/login/jellyfin?test-view=invalid-credentials");
  await page.locator("main").waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login-invalid-credentials.png", {
    fullPage: true,
  });
});

test("Jellyfin Quick Connect visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Quick Connect covers representative desktop and phone geometry",
  );
  await page.goto("/login/jellyfin?test-view=quick-connect");
  await page.getByText("Waiting for approval", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-login-quick-connect.png", { fullPage: true });
});

test("Jellyfin account pairing visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Pairing baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/link/jellyfin", testInfo.project.name));
  await page.getByRole("button", { name: "Link Jellyfin account" }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing.png", { fullPage: true });
});

test("Jellyfin pairing session-expired visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Pairing errors cover representative desktop and phone geometry",
  );
  await page.goto("/link/jellyfin?test-view=session-expired");
  await page.getByRole("link", { name: "Return to sign in" }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing-session-expired.png", {
    fullPage: true,
  });
});

test("Jellyfin Quick Connect pairing visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Quick Connect pairing covers representative desktop and phone geometry",
  );
  await page.goto("/link/jellyfin?test-view=quick-connect");
  await page.getByText("Waiting for approval", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("jellyfin-pairing-quick-connect.png", {
    fullPage: true,
  });
});

test("account security visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Account controls cover representative desktop and phone geometry",
  );
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: "visual_account_csrf_token_0123456789abcdefghij",
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "oidc", providerId: "authentik" },
          displayName: "Riley Morgan",
          linkedServices: [],
          permissions: [
            "media.view",
            "playback.use",
            "identities.self.manage",
            "sessions.self.revoke",
          ],
          role: "viewer",
          sessionId: "visual-session",
          userId: "visual-user",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/auth/identity-links", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        links: [
          {
            displayName: "Riley",
            externalUserId: "jellyfin-user-1",
            health: "linked",
            id: "jellyfin-link-1",
            lastVerifiedAt: "2026-07-26T12:00:00.000Z",
            linkedAt: "2026-07-25T12:00:00.000Z",
            service: "jellyfin",
            username: "riley",
          },
        ],
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.goto("/settings");
  await page.getByText("Riley Morgan", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("account-security.png", { fullPage: true });
});

test("unconfigured login visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !visualProjects.has(testInfo.project.name),
    "Visual baselines use representative Chromium viewports",
  );
  await page.goto(routeForProject("/login?test-view=unconfigured", testInfo.project.name));
  await page.getByText("No sign-in providers are configured", { exact: true }).waitFor();
  await expect(page).toHaveScreenshot("login-unconfigured.png", { fullPage: true });
});

for (const state of ["unavailable", "authentication-error"] as const) {
  test(`${state} login visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Login states cover representative desktop and phone geometry",
    );
    const path =
      state === "unavailable" ? "/login?test-view=unavailable" : "/login?authError=invalid_request";
    await page.goto(path);
    await page.locator("main").waitFor();
    await expect(page).toHaveScreenshot(`login-${state}.png`, { fullPage: true });
  });
}

for (const focusTarget of ["first", "last"] as const) {
  test(`provider overflow ${focusTarget} focus visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "Provider overflow covers representative desktop and phone geometry",
    );
    await page.goto("/login?test-view=provider-overflow");
    const providers = page
      .getByRole("list", { name: "Sign-in methods" })
      .locator("[data-directional-item]");
    const focusedProvider = focusTarget === "first" ? providers.first() : providers.last();
    await focusedProvider.focus();
    await expect
      .poll(async () => {
        const [listBox, providerBox] = await Promise.all([
          page.getByRole("list", { name: "Sign-in methods" }).boundingBox(),
          focusedProvider.boundingBox(),
        ]);
        return Boolean(
          listBox &&
          providerBox &&
          providerBox.y >= listBox.y + 5 &&
          providerBox.y + providerBox.height <= listBox.y + listBox.height - 5,
        );
      })
      .toBe(true);
    await expect(page).toHaveScreenshot(`login-provider-overflow-focus-${focusTarget}.png`, {
      fullPage: true,
    });
  });
}

for (const state of ["loading", "empty", "offline", "terminal-error", "quiet"] as const) {
  test(`${state} dashboard visual baseline`, async ({ page }, testInfo) => {
    test.skip(
      !stateVisualProjects.has(testInfo.project.name),
      "State baselines cover representative desktop and phone geometry",
    );
    await page.goto(`/?test-view=${state}`);
    await page.locator("main").waitFor();
    await expect(page).toHaveScreenshot(`dashboard-${state}.png`, { fullPage: true });
  });
}

test("expanded operations visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Expanded operations covers representative desktop and phone geometry",
  );
  await page.goto("/");
  const operations = page.getByRole("button", { name: /2 acquisitions moving/i });
  await operations.click();
  await expect(page.locator("#operations-details")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await operations.evaluate((control) => control.blur());
  await expect(page).toHaveScreenshot("dashboard-operations-expanded.png", { fullPage: true });
});

test("focus-visible visual baseline", async ({ page }, testInfo) => {
  test.skip(
    !stateVisualProjects.has(testInfo.project.name),
    "Focus treatment covers representative desktop and phone geometry",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Play now" }).focus();
  await expect(page.getByRole("button", { name: "Play now" })).toBeFocused();
  await expect(page).toHaveScreenshot("dashboard-focus-visible.png", { fullPage: true });
});
