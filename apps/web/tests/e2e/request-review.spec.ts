import { expect, test } from "@playwright/test";

test("operator confirms one guarded Seerr approval", async ({ page }) => {
  let requestBody: unknown;
  let csrfHeader: string | undefined;
  let idempotencyHeader: string | undefined;

  await page.route("**/api/requests/*/review", async (route) => {
    const request = route.request();
    requestBody = request.postDataJSON();
    csrfHeader = request.headers()["x-omnifin-csrf"];
    idempotencyHeader = request.headers()["idempotency-key"];
    await route.fulfill({
      body: JSON.stringify({
        createdAt: "2026-07-28T15:54:00.000Z",
        id: "request:184",
        is4k: true,
        kind: "movie",
        requestedBy: "Mara Chen",
        seasons: null,
        source: "seerr",
        status: "approved",
        title: "A House of Dynamite",
        tmdbId: 1234821,
        updatedAt: "2026-07-28T16:21:00.000Z",
        year: 2025,
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 200,
    });
  });

  await page.goto("/operations/requests?test-view=ready");
  const card = page.getByText("A House of Dynamite").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog", { name: "Send this into acquisition?" })).toBeVisible();
  await page.getByRole("button", { name: "Approve request" }).click();

  await expect(page.getByRole("status")).toContainText("A House of Dynamite was approved.");
  expect(requestBody).toEqual({ decision: "approve" });
  expect(csrfHeader).toBe("test_request_review_csrf_0123456789abcdefghijklmnop");
  expect(idempotencyHeader).toMatch(/^review-[0-9a-f-]{36}$/u);
  await expect(page.getByRole("heading", { name: "A House of Dynamite" })).toHaveCount(0);
});
