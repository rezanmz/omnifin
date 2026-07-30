import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
const visualTestMode = process.env.OMNIFIN_VISUAL_TEST === "true";

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
  fullyParallel: true,
  outputDir: "test-results",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  retries: process.env.CI && !visualTestMode ? 2 : 0,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: visualTestMode ? "off" : "retain-on-failure",
    video: visualTestMode ? "off" : "retain-on-failure",
  },
  webServer: {
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    env: {
      OMNIFIN_DEMO_MODE: "true",
      OMNIFIN_GATEWAY_URL: "http://127.0.0.1:4000",
      OMNIFIN_TEST_MODE: "true",
      PORT: String(port),
    },
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { height: 1000, width: 1440 } },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["iPhone 15"], colorScheme: "dark" } },
    { name: "tablet", use: { ...devices["iPad Pro 11"], colorScheme: "dark" } },
    {
      name: "ten-foot",
      use: { ...devices["Desktop Chrome"], viewport: { height: 1080, width: 1920 } },
    },
  ],
});
