import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && name !== "NODE_ENV" && !name.startsWith("OMNIFIN_"),
  ),
);

function spawnGateway(overrides: Record<string, string | undefined>) {
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    NODE_ENV: "production",
    OMNIFIN_BASE_URL: "https://omnifin.example",
    OMNIFIN_DATABASE_URL: ":memory:",
    OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OMNIFIN_LOG_LEVEL: "info",
    OMNIFIN_IMAGE_REF: `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`,
    ...overrides,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }

  return spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: environment as NodeJS.ProcessEnv,
    timeout: 5_000,
  });
}

describe("gateway process bootstrap", () => {
  it.each([
    {
      category: "secrets",
      code: "encryption_key_missing",
      marker: "",
      overrides: { OMNIFIN_ENCRYPTION_KEY: undefined },
    },
    {
      category: "secrets",
      code: "encryption_key_invalid",
      marker: "sensitive-malformed-key",
      overrides: { OMNIFIN_ENCRYPTION_KEY: "sensitive-malformed-key" },
    },
    {
      category: "secrets",
      code: "encryption_key_file_unreadable",
      marker: "/private/sensitive-encryption-key",
      overrides: {
        OMNIFIN_ENCRYPTION_KEY: undefined,
        OMNIFIN_ENCRYPTION_KEY_FILE: "/private/sensitive-encryption-key",
      },
    },
    {
      category: "database",
      code: "database_directory_unavailable",
      marker: "/dev/null/sensitive-database-path",
      overrides: { OMNIFIN_DATABASE_URL: "/dev/null/sensitive-database-path/omnifin.db" },
    },
  ])("reports the allowlisted $code startup failure without raw details", (fixture) => {
    const result = spawnGateway(fixture.overrides);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"operation":"gateway.startup"');
    expect(result.stderr).toContain(`"startupErrorCategory":"${fixture.category}"`);
    expect(result.stderr).toContain(`"startupErrorCode":"${fixture.code}"`);
    expect(result.stderr).toContain('"message":"Gateway startup failed"');
    if (fixture.marker) expect(result.stderr).not.toContain(fixture.marker);
    expect(result.stderr).not.toMatch(/mkdirSync|readFileSync|stack|chunk-[A-Z0-9]+/i);
  });
});
