import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onboardingRewriteTarget, proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("first-run route selection", () => {
  it("internally serves onboarding at the public root without dropping security headers", () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "false");
    const request = new NextRequest("https://omnifin.example.test/");

    expect(onboardingRewriteTarget(request)?.href).toBe("https://omnifin.example.test/onboarding");

    const response = proxy(request);
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "https://omnifin.example.test/onboarding",
    );
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("strict-transport-security")).toContain("includeSubDomains");
  });

  it("keeps the interactive dashboard at root when demo data is enabled", () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "true");

    expect(onboardingRewriteTarget(new NextRequest("http://127.0.0.1:3000/"))).toBeUndefined();
  });

  it("preserves the explicit 10-foot test profile without forwarding unrelated parameters", () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "true");
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    const target = onboardingRewriteTarget(
      new NextRequest(
        "http://127.0.0.1:3000/?test-view=onboarding&test-profile=ten-foot&secret=discarded",
      ),
    );

    expect(target?.pathname).toBe("/onboarding");
    expect(target?.search).toBe("?test-profile=ten-foot");
  });

  it("does not rewrite mutations or non-root routes", () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "false");

    expect(
      onboardingRewriteTarget(new NextRequest("http://127.0.0.1:3000/", { method: "POST" })),
    ).toBeUndefined();
    expect(onboardingRewriteTarget(new NextRequest("http://127.0.0.1:3000/login"))).toBeUndefined();
  });
});
