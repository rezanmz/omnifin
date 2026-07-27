import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Browser-mode tests need this CommonJS package pre-bundled so its named
  // accessibility exports are available as native browser modules.
  optimizeDeps: { include: ["aria-query"] },
  test: {
    coverage: {
      exclude: ["app/**", ".storybook/**", "**/*.stories.tsx"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    projects: [
      {
        test: {
          environment: "jsdom",
          include: ["**/*.test.{ts,tsx}"],
          maxWorkers: 4,
          name: "unit",
          restoreMocks: true,
          setupFiles: ["./test/setup.ts"],
        },
      },
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(import.meta.dirname, ".storybook"),
            tags: { exclude: [], include: ["test"], skip: [] },
          }),
        ],
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: playwright({}),
          },
          name: "storybook",
        },
      },
    ],
  },
});
