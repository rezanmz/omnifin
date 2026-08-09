import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("invite exchange removes the fragment and has no automatically detectable accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Invite audit uses desktop Chromium");
  await page.emulateMedia({ reducedMotion: "reduce" });

  const token = `A${"2".repeat(42)}`;
  let exchangeRequestBody: unknown;
  await page.route("**/api/auth/invitations/exchange", async (route) => {
    exchangeRequestBody = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });

  await page.goto(`/invite#invite=${token}`);
  await expect.poll(() => exchangeRequestBody).toEqual({ token });
  await expect(
    page.getByRole("heading", { name: /Make this space yours\.|Let’s try that again\./u }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/invite$/u);
  await expect(page.locator("body")).not.toContainText(token);
  expect(
    await page.evaluate(() => ({ hash: window.location.hash, state: window.history.state })),
  ).toEqual({ hash: "", state: null });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const link of ["/invite", "/invite#invite=invalid"]) {
  test(`invite ${link.includes("#") ? "invalid-link" : "no-fragment"} state has no automatically detectable accessibility violations`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Invite audit uses desktop Chromium");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Let’s try that again." })).toBeVisible();
    await expect(page.getByText("This invitation link is not valid.")).toBeVisible();
    await expect(page).toHaveURL(/\/invite$/u);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
