import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const criticalCss = readFileSync(resolve(process.cwd(), "app/dashboard-critical.css"), "utf8");
const deferredCss = readFileSync(resolve(process.cwd(), "app/dashboard.css"), "utf8");

describe("dashboard critical CSS", () => {
  it("stays within the initial-paint transfer budget", () => {
    expect(gzipSync(criticalCss).byteLength).toBeLessThanOrEqual(5_300);
  });

  it.each([
    ".calendar-item {",
    ".discovery-boundary__lens {",
    ".operations-dock__summary {",
    ".quiet-state {",
  ])("defers post-activation selector %s", (selector) => {
    expect(criticalCss).not.toContain(selector);
    expect(deferredCss).toContain(selector);
  });
});
