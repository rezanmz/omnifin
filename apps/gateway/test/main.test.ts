import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
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

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
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

  it("handles SIGTERM during a real listener lifecycle without a startup race", async () => {
    const port = await unusedPort();
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
      NODE_ENV: "production",
      OMNIFIN_BASE_URL: "https://omnifin.example",
      OMNIFIN_DATABASE_URL: ":memory:",
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OMNIFIN_IMAGE_REF: `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`,
      OMNIFIN_LOG_LEVEL: "info",
      OMNIFIN_PORT: String(port),
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const deadline = Date.now() + 8_000;
    try {
      while (!output.includes('"operation":"gateway.listen"') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(output).toContain('"operation":"gateway.listen"');
      child.kill("SIGTERM");
      const [exitCode, exitSignal] = await Promise.race([
        new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
          child.once("exit", (code, signal) => resolve([code, signal]));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Gateway did not shut down promptly.")), 8_000),
        ),
      ]);
      expect(exitCode).toBe(0);
      expect(exitSignal).toBeNull();
      expect(output).toContain('"operation":"gateway.shutdown"');
      expect(output).not.toContain('"operation":"gateway.startup"');
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  }, 20_000);
});
