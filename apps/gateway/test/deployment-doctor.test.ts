import Database from "better-sqlite3";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deploymentDoctorCheckSchema,
  deploymentDoctorReportSchema,
  runDeploymentDoctor,
  type DeploymentDoctorOptions,
} from "../src/operations/deployment-doctor.js";

const temporaryDirectories: string[] = [];
const generatedAt = new Date("2026-08-01T12:00:00.000Z");

async function createDeploymentStorage(options: { migrations?: boolean; mode?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-doctor-"));
  temporaryDirectories.push(directory);
  const backupDirectory = path.join(directory, "backups");
  const databasePath = path.join(directory, "omnifin.sqlite");
  await mkdir(backupDirectory, { mode: options.mode ?? 0o700 });
  await chmod(backupDirectory, options.mode ?? 0o700);

  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    if (options.migrations !== false) {
      database.exec(
        "create table __drizzle_migrations (id integer primary key, hash text not null, created_at integer not null)",
      );
      database
        .prepare("insert into __drizzle_migrations (id, hash, created_at) values (?, ?, ?)")
        .run(1, "fixture", generatedAt.getTime());
    }
  } finally {
    database.close();
  }

  return { backupDirectory, databasePath, directory };
}

function publicHeaders() {
  return {
    "content-security-policy":
      "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function response(body: object, url: string, init: ResponseInit = {}) {
  const result = new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function healthyFetch(overrides: { omitPublicHeaders?: boolean } = {}): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === "http://gateway:4000" && url.pathname === "/healthz") {
      return response({ status: "ok" }, url.href);
    }
    if (url.origin === "http://gateway:4000" && url.pathname === "/readyz") {
      return response({ checks: { database: "ok" }, status: "ready" }, url.href);
    }
    if (url.origin === "https://media.example.test" && url.pathname === "/healthz") {
      return response(
        { status: "ok" },
        url.href,
        overrides.omitPublicHeaders ? {} : { headers: publicHeaders() },
      );
    }
    throw new Error("unexpected_destination");
  };
}

function readyOptions(storage: { backupDirectory: string; databasePath: string }) {
  return {
    ...storage,
    baseUrl: "https://media.example.test/",
    environment: "production",
    gatewayHealthUrl: "http://gateway:4000/healthz",
    gatewayReadyUrl: "http://gateway:4000/readyz",
    imageReference: `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`,
  } satisfies DeploymentDoctorOptions;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("deployment doctor", () => {
  it("binds every attention reason to its owning check", () => {
    expect(
      deploymentDoctorCheckSchema.safeParse({
        code: "storage_unavailable",
        id: "runtime",
        state: "attention",
      }).success,
    ).toBe(false);
  });

  it("rejects reordered checks and summaries that do not match their checks", () => {
    const checks = [
      { id: "runtime", state: "ready" },
      { id: "image", state: "ready" },
      { id: "gateway", state: "ready" },
      { id: "public_boundary", state: "ready" },
      { id: "storage", state: "ready" },
      { id: "backup", state: "ready" },
    ];
    const report = {
      checks,
      generatedAt: generatedAt.toISOString(),
      readyCount: 6,
      schemaVersion: 1,
      state: "ready",
      total: 6,
    };

    expect(
      deploymentDoctorReportSchema.safeParse({
        ...report,
        checks: [checks[1], checks[0], ...checks.slice(2)],
      }).success,
    ).toBe(false);
    expect(
      deploymentDoctorReportSchema.safeParse({ ...report, readyCount: 5, state: "attention" })
        .success,
    ).toBe(false);
  });

  it("returns an ordered, versioned ready report without retaining deployment values", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const report = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: healthyFetch(),
    });

    expect(deploymentDoctorReportSchema.parse(report)).toEqual({
      checks: [
        { id: "runtime", state: "ready" },
        { id: "image", state: "ready" },
        { id: "gateway", state: "ready" },
        { id: "public_boundary", state: "ready" },
        { id: "storage", state: "ready" },
        { id: "backup", state: "ready" },
      ],
      generatedAt: generatedAt.toISOString(),
      readyCount: 6,
      schemaVersion: 1,
      state: "ready",
      total: 6,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(options.baseUrl);
    expect(serialized).not.toContain(options.databasePath);
    expect(serialized).not.toContain(options.backupDirectory);
    expect(serialized).not.toContain(options.imageReference);
  });

  it("returns fixed attention codes for an unprepared source preview", async () => {
    const storage = await createDeploymentStorage({ mode: 0o755 });
    const report = await runDeploymentDoctor(
      {
        ...storage,
        baseUrl: "http://127.0.0.1:3000/",
        databasePath: ":memory:",
        environment: "development",
        imageReference: "ghcr.io/rezanmz/omnifin:latest",
      },
      { clock: () => generatedAt, fetch: healthyFetch() },
    );

    expect(report).toMatchObject({
      checks: [
        { code: "runtime_not_production", id: "runtime", state: "attention" },
        { code: "image_reference_not_immutable", id: "image", state: "attention" },
        { code: "gateway_unavailable", id: "gateway", state: "attention" },
        { code: "public_origin_invalid", id: "public_boundary", state: "attention" },
        { code: "storage_not_persistent", id: "storage", state: "attention" },
        { code: "backup_directory_not_private", id: "backup", state: "attention" },
      ],
      readyCount: 0,
      state: "attention",
    });
  });

  it("distinguishes invalid private responses from public header failures", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/readyz") {
        return response({ checks: { database: "unknown" }, status: "ready" }, url.href);
      }
      return healthyFetch({ omitPublicHeaders: true })(input);
    };

    const report = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: fetchImplementation,
    });

    expect(report.checks[2]).toEqual({
      code: "gateway_response_invalid",
      id: "gateway",
      state: "attention",
    });
    expect(report.checks[3]).toEqual({
      code: "public_headers_invalid",
      id: "public_boundary",
      state: "attention",
    });
  });

  it("bounds private response bodies and rejects public redirects", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin === "http://gateway:4000" && url.pathname === "/healthz") {
        return response({ status: "ok" }, url.href, {
          headers: { "content-length": "4096" },
        });
      }
      if (url.origin === "https://media.example.test") {
        return response({}, url.href, {
          headers: { location: "https://elsewhere.test/" },
          status: 302,
        });
      }
      return healthyFetch()(input);
    };

    const report = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: fetchImplementation,
    });

    expect(report.checks[2]).toMatchObject({ code: "gateway_response_invalid" });
    expect(report.checks[3]).toMatchObject({ code: "public_response_invalid" });
  });

  it("distinguishes an unreadable database from an invalid migration ledger", async () => {
    const storage = await createDeploymentStorage({ migrations: false });
    const options = readyOptions(storage);
    const invalidLedger = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: healthyFetch(),
    });
    expect(invalidLedger.checks[4]).toEqual({
      code: "storage_integrity_failed",
      id: "storage",
      state: "attention",
    });

    const missingDatabase = await runDeploymentDoctor(
      { ...options, databasePath: path.join(storage.directory, "missing.sqlite") },
      { clock: () => generatedAt, fetch: healthyFetch() },
    );
    expect(missingDatabase.checks[4]).toEqual({
      code: "storage_unavailable",
      id: "storage",
      state: "attention",
    });

    const corruptPath = path.join(storage.directory, "corrupt.sqlite");
    await writeFile(corruptPath, "not a sqlite database", { mode: 0o600 });
    const corruptDatabase = await runDeploymentDoctor(
      { ...options, databasePath: corruptPath },
      { clock: () => generatedAt, fetch: healthyFetch() },
    );
    expect(corruptDatabase.checks[4]).toEqual({
      code: "storage_integrity_failed",
      id: "storage",
      state: "attention",
    });
  });

  it("rejects digest-shaped image values containing multiple references or whitespace", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const report = await runDeploymentDoctor(
      {
        ...options,
        imageReference: `ghcr.io/rezanmz/omnifin:latest other@sha256:${"a".repeat(64)}`,
      },
      { clock: () => generatedAt, fetch: healthyFetch() },
    );

    expect(report.checks[1]).toEqual({
      code: "image_reference_not_immutable",
      id: "image",
      state: "attention",
    });
  });

  it("normalizes bounded request timeouts without exposing thrown diagnostics", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const fetchImplementation: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private host detail")), {
          once: true,
        });
      });

    const report = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: fetchImplementation,
      timeoutMs: 5,
    });

    expect(report.checks[2]).toMatchObject({ code: "gateway_unavailable" });
    expect(report.checks[3]).toMatchObject({ code: "public_origin_unavailable" });
    expect(JSON.stringify(report)).not.toContain("private host detail");
  });

  it("keeps the timeout active while private response bodies are read", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== "http://gateway:4000") return healthyFetch()(input, init);
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("private stalled body detail")),
            { once: true },
          );
        },
      });
      const result = new Response(body, { headers: { "content-type": "application/json" } });
      Object.defineProperty(result, "url", { value: url.href });
      return result;
    };

    const report = await runDeploymentDoctor(options, {
      clock: () => generatedAt,
      fetch: fetchImplementation,
      timeoutMs: 5,
    });

    expect(report.checks[2]).toMatchObject({ code: "gateway_response_invalid" });
    expect(JSON.stringify(report)).not.toContain("private stalled body detail");
  });

  it("rejects invalid internal timing and clock dependencies", async () => {
    const storage = await createDeploymentStorage();
    const options = readyOptions(storage);
    await expect(runDeploymentDoctor(options, { timeoutMs: 0 })).rejects.toThrow(
      "deployment_doctor_configuration_invalid",
    );
    await expect(
      runDeploymentDoctor(options, {
        clock: () => new Date(Number.NaN),
        fetch: healthyFetch(),
      }),
    ).rejects.toThrow("deployment_doctor_integrity_failure");
  });
});
