import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
const visualTestMode = process.env.OMNIFIN_VISUAL_TEST === "true";
const isolatedTestMode = process.env.OMNIFIN_PLAYWRIGHT_TEST_MODE === "true";
const productionServer = isolatedTestMode || Boolean(process.env.CI);
const gracefulShutdown = { signal: "SIGTERM" as const, timeout: 5_000 };
const exhaustiveRouteMatrix = /tests\/a11y\/routes\.spec\.ts/;
const useChromiumMobileEmulation = process.platform === "darwin";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer between 1 and 65535.");
}

export default defineConfig({
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.005 },
  },
  failOnFlakyTests: Boolean(process.env.CI),
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: !visualTestMode,
  outputDir: "test-results",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  retries: process.env.CI && !visualTestMode ? 2 : 0,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}",
  timeout: 30_000,
  ...(visualTestMode || isolatedTestMode ? { workers: 1 } : {}),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: visualTestMode ? "off" : "retain-on-failure",
    video: visualTestMode ? "off" : "retain-on-failure",
  },
  webServer: {
    command: isolatedTestMode
      ? "exec next start --hostname 127.0.0.1"
      : process.env.CI
        ? "exec next start --hostname 127.0.0.1"
        : "pnpm dev",
    env: {
      OMNIFIN_DEMO_MODE: "true",
      OMNIFIN_GATEWAY_URL: "http://127.0.0.1:4000",
      OMNIFIN_TEST_MODE: "true",
      ...(productionServer ? { NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" } : {}),
      PORT: String(port),
    },
    gracefulShutdown,
    port,
    reuseExistingServer: !isolatedTestMode && !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { height: 1000, width: 1440 } },
    },
    {
      name: "firefox",
      testIgnore: exhaustiveRouteMatrix,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: exhaustiveRouteMatrix,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile",
      testIgnore: exhaustiveRouteMatrix,
      use: {
        ...devices["iPhone 15"],
        ...(useChromiumMobileEmulation ? { browserName: "chromium" } : {}),
        colorScheme: "dark",
      },
    },
    {
      name: "tablet",
      testIgnore: exhaustiveRouteMatrix,
      use: {
        ...devices["iPad Pro 11"],
        ...(useChromiumMobileEmulation ? { browserName: "chromium" } : {}),
        colorScheme: "dark",
      },
    },
    {
      name: "ten-foot",
      use: { ...devices["Desktop Chrome"], viewport: { height: 1080, width: 1920 } },
    },
  ],
});
