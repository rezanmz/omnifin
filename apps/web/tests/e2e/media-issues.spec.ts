import { expect, test } from "@playwright/test";

test("operator confirms one guarded issue resolution", async ({ page }) => {
  let requestBody: unknown;
  let csrfHeader: string | undefined;
  let idempotencyHeader: string | undefined;
  const issueId = `issue_${"a".repeat(22)}`;

  await page.route("**/api/issues/*/status", async (route) => {
    const request = route.request();
    requestBody = request.postDataJSON();
    csrfHeader = request.headers()["x-omnifin-csrf"];
    idempotencyHeader = request.headers()["idempotency-key"];
    await route.fulfill({
      body: JSON.stringify({
        category: "subtitles",
        createdAt: "2026-07-28T19:24:00.000Z",
        episodeNumber: 3,
        id: issueId,
        kind: "episode",
        positionSeconds: null,
        reportedBy: "Mara Chen",
        seasonNumber: 2,
        source: "seerr",
        status: "resolved",
        summary: "Captions drift after the opening scene.",
        title: "Northern Lights",
        updatedAt: "2026-07-28T20:13:00.000Z",
        year: 2026,
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 200,
    });
  });

  await page.goto("/operations/issues?test-view=ready");
  const card = page.getByText("Northern Lights").locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
  await page.getByRole("button", { name: "Resolve issue" }).click();

  await expect(page.getByRole("status")).toContainText("Northern Lights was resolved.");
  expect(requestBody).toEqual({ status: "resolved" });
  expect(csrfHeader).toBe("test_media_issue_csrf_0123456789abcdefghijklmnopqr");
  expect(idempotencyHeader).toMatch(/^issue-status-[0-9a-f-]{36}$/u);
  await expect(page.getByRole("heading", { name: "Northern Lights" })).toHaveCount(0);
});
