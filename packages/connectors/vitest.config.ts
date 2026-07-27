import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@omnifin/contracts/acquisition": fileURLToPath(
        new URL("../contracts/src/acquisition.ts", import.meta.url),
      ),
      "@omnifin/contracts/connectors": fileURLToPath(
        new URL("../contracts/src/connectors.ts", import.meta.url),
      ),
      "@omnifin/contracts/discovery": fileURLToPath(
        new URL("../contracts/src/discovery.ts", import.meta.url),
      ),
      "@omnifin/contracts/requests": fileURLToPath(
        new URL("../contracts/src/requests.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      exclude: ["test/**"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
  },
});
