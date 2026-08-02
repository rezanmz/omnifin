import { expect, test } from "@playwright/test";

for (const route of [
  "/",
  "/login",
  "/settings",
  "/settings/identity-providers?test-view=ready",
  "/settings/audit?test-view=ready",
  "/operations/health?test-view=ready",
  "/operations/indexers?test-view=ready",
  "/operations/downloads?test-view=ready",
  "/operations/issues?test-view=ready",
  "/does-not-exist",
] as const) {
  test(`${route} enforces its response nonce and trusted dynamic scripts`, async ({ page }) => {
    const policyViolations: string[] = [];
    await page.addInitScript(() => {
      const violations: string[] = [];
      Object.defineProperty(window, "__omnifinCspViolations", { value: violations });
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push(`${event.effectiveDirective}: ${event.blockedURI || "inline"}`);
      });
    });
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

    const scripts = await page.locator("script").evaluateAll((elements) =>
      elements.map((element) => {
        const script = element as HTMLScriptElement;
        const source = script.src ? new URL(script.src, window.location.href) : undefined;
        return {
          executable: Boolean(script.src || script.textContent?.trim()),
          nonce: script.nonce,
          path: source?.pathname,
          sameOrigin: source?.origin === window.location.origin,
        };
      }),
    );
    expect(scripts.length).toBeGreaterThan(0);

    const responseScripts = scripts.filter((script) => script.nonce);
    expect(responseScripts.length).toBeGreaterThan(0);
    expect(new Set(responseScripts.map((script) => script.nonce))).toEqual(new Set([nonce]));

    // Production `strict-dynamic` propagates trust from a nonced framework
    // script. Turbopack development uses the explicit same-origin source
    // because its route-loading chunks are not consistently nonce-bearing.
    // In either profile, runtime chunks must remain canonical Next.js assets.
    for (const script of scripts.filter((candidate) => !candidate.nonce && candidate.executable)) {
      expect(script.sameOrigin).toBe(true);
      expect(decodeURIComponent(script.path ?? "")).toMatch(
        /^\/_next\/static\/chunks\/[A-Za-z0-9._/\[\]-]+\.js$/u,
      );
    }

    await page.waitForLoadState("load");
    const eventViolations = await page.evaluate(
      () =>
        (
          window as Window & {
            __omnifinCspViolations?: string[];
          }
        ).__omnifinCspViolations ?? [],
    );
    expect(policyViolations).toEqual([]);
    expect(eventViolations).toEqual([]);
  });
}
