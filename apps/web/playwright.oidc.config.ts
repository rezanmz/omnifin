import { defineConfig } from "@playwright/test";

// Keep this canary off the normal browser-test port so sequential CI runs do
// not race the previous Next.js process while it releases port 3000.
const webPort = 4316;
const webOrigin = `http://127.0.0.1:${webPort}`;
// Deliberately differs from the source and image defaults so the production
// canary proves that the immutable web build honors its runtime gateway URL.
const gatewayPort = 4317;
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
const gracefulShutdown = { signal: "SIGTERM" as const, timeout: 5_000 };

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
      gracefulShutdown,
      name: "Synthetic OIDC gateway",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 60_000,
      // Phase 0 readiness requires production database key state. This
      // in-memory rewrite fixture needs liveness; each test proves route health.
      url: `${gatewayOrigin}/healthz`,
    },
    {
      command: "pnpm start",
      env: {
        OMNIFIN_DEMO_MODE: "false",
        OMNIFIN_GATEWAY_URL: gatewayOrigin,
        OMNIFIN_TEST_MODE: "false",
        OMNIFIN_WEB_TRUST_PROXY_HOPS: "1",
        PORT: String(webPort),
      },
      name: "Production web",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 60_000,
      url: `${webOrigin}/login`,
    },
  ],
  workers: 1,
});
