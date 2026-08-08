import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";

const executeFile = promisify(execFile);
const cleanupDirectories: string[] = [];
const gatewayDirectory = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function cliFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-maintenance-cli-"));
  cleanupDirectories.push(directory);
  const databasePath = path.join(directory, "omnifin.db");
  const database = openDatabase(databasePath);
  database.migrate();
  database.close();
  return { databasePath, directory };
}

async function runMaintenance(
  arguments_: string[],
  fixture: Awaited<ReturnType<typeof cliFixture>>,
) {
  return executeFile(process.execPath, ["--import", "tsx", "src/maintenance.ts", ...arguments_], {
    cwd: gatewayDirectory,
    env: {
      ...process.env,
      NODE_ENV: "production",
      OMNIFIN_BACKUP_DIRECTORY: fixture.directory,
      OMNIFIN_DATABASE_URL: fixture.databasePath,
      OMNIFIN_IMAGE_REF: `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`,
    },
  });
}

describe("maintenance CLI", () => {
  it("creates a privacy-safe retained backup for host schedulers", async () => {
    const fixture = await cliFixture();

    const result = await runMaintenance(["backup-retained", "--retain", "2"], fixture);

    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      operation: "backup-retained",
      retention: { candidates: 1, removed: 0, retained: 1, state: "ready" },
      status: "ok",
    });
    expect(JSON.stringify(report)).not.toContain(fixture.directory);
    expect(JSON.stringify(report)).not.toContain(fixture.databasePath);
    expect(JSON.stringify(report)).toMatch(/omnifin-auto-\d{8}T\d{9}Z-[0-9a-f-]{36}\.sqlite/);
    expect(result.stderr).toBe("");
  });

  it("returns a usage error for an out-of-policy retention count", async () => {
    const fixture = await cliFixture();
    let failure: (ExecFileException & { stderr: string; stdout: string }) | undefined;

    try {
      await runMaintenance(["backup-retained", "--retain", "1"], fixture);
    } catch (error) {
      failure = error as ExecFileException & { stderr: string; stdout: string };
    }

    expect(failure?.code).toBe(64);
    expect(failure?.stdout).toBe("");
    expect(failure?.stderr).toContain("backup-retained --retain 14");
    expect(failure?.stderr).not.toContain(fixture.directory);
    expect(failure?.stderr).not.toContain(fixture.databasePath);
  });

  it("returns a temporary failure with safe partial-success evidence when pruning is blocked", async () => {
    const fixture = await cliFixture();
    await writeFile(
      path.join(
        fixture.directory,
        "omnifin-auto-20260731T120000000Z-60000000-0000-4000-8000-000000000001.sqlite",
      ),
      "incomplete",
      { mode: 0o600 },
    );

    let failure: (ExecFileException & { stderr: string; stdout: string }) | undefined;
    try {
      await runMaintenance(["backup-retained", "--retain", "2"], fixture);
    } catch (error) {
      failure = error as ExecFileException & { stderr: string; stdout: string };
    }

    expect(failure?.code).toBe(75);
    expect(failure?.stderr).toBe("");
    const report = JSON.parse(failure?.stdout ?? "") as Record<string, unknown>;
    expect(report).toMatchObject({
      operation: "backup-retained",
      retention: {
        reason: "retention_set_invalid",
        removed: 0,
        state: "attention",
      },
      status: "attention",
    });
    expect(JSON.stringify(report)).not.toContain(fixture.directory);
    expect(JSON.stringify(report)).not.toContain(fixture.databasePath);
  });
});
