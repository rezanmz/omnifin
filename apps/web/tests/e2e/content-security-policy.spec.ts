import { expect, test } from "@playwright/test";

for (const route of ["/", "/login", "/settings", "/does-not-exist"] as const) {
  test(`${route} applies its response nonce to every script`, async ({ page }) => {
    const policyViolations: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /content security policy|refused to (?:execute|load)/iu.test(message.text())
      ) {
        policyViolations.push(message.text());
      }
    });

    const response = await page.goto(route);
    expect(response).not.toBeNull();
    const policy = response?.headers()["content-security-policy"] ?? "";
    const nonce = policy.match(/'nonce-([^']+)'/u)?.[1];
    expect(nonce).toMatch(/^[a-f0-9]{32}$/u);
    if (!nonce) throw new Error("The response CSP did not contain a script nonce.");

    const scriptNonces = await page
      .locator("script")
      .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce));
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(new Set(scriptNonces)).toEqual(new Set([nonce]));

    await page.waitForLoadState("networkidle");
    expect(policyViolations).toEqual([]);
  });
}
