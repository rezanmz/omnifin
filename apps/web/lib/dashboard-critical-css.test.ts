import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const criticalCss = readFileSync(resolve(process.cwd(), "app/dashboard-critical.css"), "utf8");
const deferredCss = readFileSync(resolve(process.cwd(), "app/dashboard.css"), "utf8");
const shellCss = readFileSync(resolve(process.cwd(), "app/(shell)/shell.css"), "utf8");
const shellEnhancementsCss = readFileSync(
  resolve(process.cwd(), "app/(shell)/shell-enhancements.css"),
  "utf8",
);

describe("dashboard critical CSS", () => {
  it("stays within the initial-paint transfer budget", () => {
    expect(gzipSync(criticalCss).byteLength).toBeLessThanOrEqual(5_300);
    expect(gzipSync(shellCss).byteLength).toBeLessThanOrEqual(2_750);
  });

  it("defers optical shell refinement without deferring shell geometry", () => {
    expect(shellCss).toContain(".application-frame {");
    expect(shellCss).toContain(".navigation-rail {");
    expect(shellCss).not.toContain(".navigation-rail::before");
    expect(shellEnhancementsCss).toContain(".navigation-rail::before");
    expect(shellEnhancementsCss).toContain(":root[data-liquid-glass-ready]");
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
