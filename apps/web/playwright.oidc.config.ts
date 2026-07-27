import { defineConfig } from "@playwright/test";

const webOrigin = "http://127.0.0.1:3000";
// Deliberately differs from the source and image defaults so the production
// canary proves that the immutable web build honors its runtime gateway URL.
const gatewayPort = 4317;
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results/oidc-rewrite",
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "tests/integration",
  timeout: 30_000,
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @omnifin/gateway exec tsx test/fixtures/oidc-rewrite-gateway.ts",
      env: {
        OMNIFIN_OIDC_REWRITE_GATEWAY_PORT: String(gatewayPort),
        OMNIFIN_OIDC_REWRITE_WEB_ORIGIN: webOrigin,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${gatewayOrigin}/readyz`,
    },
    {
      command: "pnpm start",
      env: {
        OMNIFIN_DEMO_MODE: "false",
        OMNIFIN_GATEWAY_URL: gatewayOrigin,
        OMNIFIN_TEST_MODE: "false",
        OMNIFIN_WEB_TRUST_PROXY_HOPS: "1",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${webOrigin}/login`,
    },
  ],
  workers: 1,
});
