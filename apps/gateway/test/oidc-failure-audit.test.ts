import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  OIDC_FAILURE_AUDIT_EVENT_TYPE,
  OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW,
  OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
  OIDC_FAILURE_AUDIT_SCOPE,
  OIDC_FAILURE_AUDIT_WINDOW_MS,
  OidcFailureAuditService,
} from "../src/auth/oidc/failure-audit.js";
import { openDatabase } from "../src/db/client.js";
import { privacyHash } from "../src/security/crypto.js";

const auditTime = new Date("2026-07-25T18:00:00.000Z");
const privacyKey = Buffer.alloc(32, 41);
const bucketCapacity = OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW - 1;

function idFactory(prefix: string) {
  let id = 0;
  return () => `${prefix}-${(id += 1)}`;
}

function recordUnique(service: OidcFailureAuditService, index: number) {
  return service.record({
    ipAddress: `2001:db8:${Math.floor(index / 65_536).toString(16)}:${(index % 65_536).toString(16)}::1`,
    outcome: index % 2 === 0 ? "denied" : "failure",
    reason: "callback_validation_failed",
    requestId: `request-${index}`,
  });
}

function readScope(database: ReturnType<typeof openDatabase>) {
  return database.sqlite
    .prepare(
      `select
         scope,
         generation,
         window_started_at as windowStartedAt,
         clock_watermark_at as clockWatermarkAt,
         rollback_started_at as rollbackStartedAt,
         saturated,
         suppressed_count as suppressedCount
       from audit_budget_scopes
       where scope = ?`,
    )
    .get(OIDC_FAILURE_AUDIT_SCOPE) as {
    clockWatermarkAt: number;
    generation: number;
    rollbackStartedAt: number | null;
    saturated: number;
    scope: string;
    suppressedCount: number;
    windowStartedAt: number;
  };
}

type AuditWorkerResult =
  | { dispositions: Record<string, number>; status: "fulfilled" }
  | { message: string; status: "rejected" };

interface AuditWorkerHandle {
  ready: Promise<void>;
  result: Promise<AuditWorkerResult>;
  worker: Worker;
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

const auditWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    const { tsImport } = await import(workerData.tsxApiUrl);
    const { OidcFailureAuditService } = await tsImport(
      workerData.auditModuleUrl,
      workerData.parentUrl,
    );
    const { openDatabase } = await tsImport(
      workerData.databaseModuleUrl,
      workerData.parentUrl,
    );
    const database = openDatabase(workerData.databasePath);
    const gate = new Int32Array(workerData.gate);
    const dispositions = { coalesced: 0, recorded: 0, saturated: 0 };
    let identifier = 0;
    let result;

    try {
      const service = new OidcFailureAuditService(
        database,
        { encryptionKey: Buffer.from(workerData.encryptionKey, "base64") },
        {
          clock: () => new Date(workerData.now),
          createId: () => workerData.workerId + "-" + (++identifier),
        },
      );
      parentPort.postMessage({ kind: "ready" });
      Atomics.wait(gate, 0, 0);
      try {
        for (let index = 0; index < workerData.attempts; index += 1) {
          const bucket = workerData.workerIndex * workerData.attempts + index;
          const disposition = service.record({
            ipAddress: "2001:db8:" + workerData.workerIndex.toString(16) + ":" + index.toString(16) + "::1",
            outcome: index % 2 === 0 ? "denied" : "failure",
            reason: "callback_validation_failed",
            requestId: "worker-" + workerData.workerIndex + "-request-" + index,
          });
          dispositions[disposition] += 1;
        }
        result = { dispositions, status: "fulfilled" };
      } catch (error) {
        result = {
          message: error instanceof Error ? error.message : "Unknown audit failure.",
          status: "rejected",
        };
      }
    } finally {
      database.close();
    }

    parentPort.postMessage({ kind: "result", result });
  })().catch((error) => {
    parentPort.postMessage({
      kind: "fatal",
      message: error instanceof Error ? error.message : String(error),
    });
  });
`;

const tsxApiUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
const auditModuleUrl = new URL("../src/auth/oidc/failure-audit.ts", import.meta.url).href;
const databaseModuleUrl = new URL("../src/db/client.ts", import.meta.url).href;

function startAuditWorker(input: {
  attempts: number;
  databasePath: string;
  gate: SharedArrayBuffer;
  workerIndex: number;
}): AuditWorkerHandle {
  const ready = deferred<void>();
  const result = deferred<AuditWorkerResult>();
  let receivedReady = false;
  let receivedResult = false;
  const worker = new Worker(auditWorkerSource, {
    eval: true,
    workerData: {
      attempts: input.attempts,
      auditModuleUrl,
      databaseModuleUrl,
      databasePath: input.databasePath,
      encryptionKey: privacyKey.toString("base64"),
      gate: input.gate,
      now: auditTime.toISOString(),
      parentUrl: import.meta.url,
      tsxApiUrl,
      workerId: `audit-worker-${input.workerIndex}`,
      workerIndex: input.workerIndex,
    },
  });

  worker.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("kind" in message)) return;
    const workerMessage = message as {
      kind: unknown;
      message?: unknown;
      result?: AuditWorkerResult;
    };
    if (workerMessage.kind === "ready") {
      receivedReady = true;
      ready.resolve();
      return;
    }
    if (workerMessage.kind === "result" && workerMessage.result) {
      receivedResult = true;
      result.resolve(workerMessage.result);
      return;
    }
    if (workerMessage.kind === "fatal") {
      const error = new Error(
        typeof workerMessage.message === "string" ? workerMessage.message : "Audit worker failed.",
      );
      ready.reject(error);
      result.reject(error);
    }
  });
  worker.once("error", (error) => {
    ready.reject(error);
    result.reject(error);
  });
  worker.once("exit", (code) => {
    if (code === 0 && receivedReady && receivedResult) return;
    const error = new Error(`Audit worker exited before completing (code ${code}).`);
    ready.reject(error);
    result.reject(error);
  });
  return { ready: ready.promise, result: result.promise, worker };
}

describe("OIDC failure audit service", () => {
  it("snapshots hostile reason and outcome getters exactly once before writing", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => auditTime, createId: idFactory("hostile-input") },
    );
    let outcomeReads = 0;
    let reasonReads = 0;
    const input = new Proxy(
      { ipAddress: "192.0.2.44", requestId: "hostile-input-request" },
      {
        get(target, property, receiver) {
          if (property === "outcome") {
            outcomeReads += 1;
            if (outcomeReads > 1) throw new Error("outcome getter was read twice");
            return "denied";
          }
          if (property === "reason") {
            reasonReads += 1;
            if (reasonReads > 1) throw new Error("reason getter was read twice");
            return "authorization_denied";
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    ) as unknown as Parameters<OidcFailureAuditService["record"]>[0];

    try {
      database.migrate();
      expect(service.record(input)).toBe("recorded");
      expect({ outcomeReads, reasonReads }).toEqual({ outcomeReads: 1, reasonReads: 1 });
      expect(
        database.sqlite
          .prepare("select outcome, metadata_json as metadataJson from audit_events")
          .get(),
      ).toEqual({
        metadataJson: expect.stringContaining('"reason":"authorization_denied"'),
        outcome: "denied",
      });
    } finally {
      database.close();
    }
  });

  it("rejects a throwing input proxy before creating persistent budget state", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(database, { encryptionKey: privacyKey });
    let outcomeReads = 0;
    const input = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "outcome") {
            outcomeReads += 1;
            throw new Error("private hostile getter detail");
          }
          return "authorization_denied";
        },
      },
    ) as Parameters<OidcFailureAuditService["record"]>[0];
    try {
      database.migrate();
      expect(() => service.record(input)).toThrow("OIDC failure audit input is invalid.");
      expect(outcomeReads).toBe(1);
      expect(
        database.sqlite.prepare("select count(*) as count from audit_budget_scopes").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("redacts hostile context accessor errors before creating persistent state", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(database, { encryptionKey: privacyKey });
    const reads = { ipAddress: 0, outcome: 0, reason: 0, requestId: 0, userAgent: 0 };
    const input = new Proxy(
      {},
      {
        get(_target, property) {
          if (property in reads) reads[property as keyof typeof reads] += 1;
          if (property === "outcome") return "failure";
          if (property === "reason") return "internal_failure";
          if (property === "userAgent") throw new Error("private-provider-assertion");
          return undefined;
        },
      },
    ) as Parameters<OidcFailureAuditService["record"]>[0];
    try {
      database.migrate();
      expect(() => service.record(input)).toThrow("OIDC failure audit input is invalid.");
      expect(reads).toEqual({ ipAddress: 1, outcome: 1, reason: 1, requestId: 1, userAgent: 1 });
      expect(
        database.sqlite.prepare("select count(*) as count from audit_budget_scopes").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("stores only allowlisted, bounded failure context with domain-separated hashes", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => auditTime, createId: idFactory("safe-audit") },
    );
    const ipAddress = "203.0.113.42";
    const userAgent = "private-authentication-client";
    const sensitive = {
      assertion: "private-provider-assertion",
      authorizationCode: "private-authorization-code",
      cookie: "private-session-cookie",
      state: "private-authorization-state",
      token: "private-provider-token",
    };
    try {
      database.migrate();
      expect(
        service.record({
          ipAddress,
          outcome: "denied",
          reason: "callback_validation_failed",
          requestId: "request-safe-1",
          userAgent,
          ...sensitive,
        }),
      ).toBe("recorded");
      expect(
        service.record({
          ipAddress,
          outcome: "failure",
          reason: "callback_validation_failed",
          requestId: "invalid request identifier",
          userAgent,
          ...sensitive,
        }),
      ).toBe("coalesced");

      const scope = readScope(database);
      expect(scope).toMatchObject({
        clockWatermarkAt: auditTime.getTime(),
        generation: 1,
        rollbackStartedAt: null,
        saturated: 0,
        scope: OIDC_FAILURE_AUDIT_SCOPE,
        suppressedCount: 1,
        windowStartedAt: auditTime.getTime(),
      });
      const row = database.sqlite
        .prepare(
          `select
             actor_session_id as actorSessionId,
             actor_auth_method as actorAuthMethod,
             event_type as eventType,
             outcome,
             target_type as targetType,
             target_id as targetId,
             request_id as requestId,
             metadata_json as metadataJson,
             ip_hash as ipHash
           from audit_events`,
        )
        .get() as Record<string, unknown>;
      const metadata = JSON.parse(row.metadataJson as string) as Record<string, unknown>;
      expect(row).toMatchObject({
        actorAuthMethod: null,
        actorSessionId: null,
        eventType: OIDC_FAILURE_AUDIT_EVENT_TYPE,
        ipHash: privacyHash("oidc_failure_audit_ip_address", ipAddress, privacyKey),
        outcome: "denied",
        requestId: "request-safe-1",
        targetId: null,
        targetType: "oidc_authentication",
      });
      expect(metadata).toEqual({
        bucketHash: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        budgetGeneration: 1,
        reason: "callback_validation_failed",
        userAgentHash: privacyHash("oidc_failure_audit_user_agent", userAgent, privacyKey),
      });
      expect(metadata.bucketHash).not.toBe(row.ipHash);
      expect(metadata.bucketHash).not.toBe(metadata.userAgentHash);

      const databaseBytes = database.sqlite.serialize().toString("utf8");
      expect(databaseBytes).not.toContain(ipAddress);
      expect(databaseBytes).not.toContain(userAgent);
      for (const value of Object.values(sensitive)) expect(databaseBytes).not.toContain(value);
      expect(service.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 1,
        window: 1,
      });
      expect(() =>
        service.record({ outcome: "success", reason: "private_reason" } as never),
      ).toThrow(/reason|outcome/);
    } finally {
      database.close();
    }
  });

  it("groups canonical IPv4 and mapped IPv6 equivalents without merging unrelated clients", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => auditTime, createId: idFactory("mapped-ipv4") },
    );
    const recordFrom = (ipAddress: string) =>
      service.record({ ipAddress, outcome: "denied", reason: "authorization_denied" });
    try {
      database.migrate();
      expect(recordFrom("192.0.2.44")).toBe("recorded");
      expect(recordFrom("::ffff:192.0.2.44")).toBe("coalesced");
      expect(recordFrom("::ffff:c000:022c")).toBe("coalesced");
      expect(recordFrom("::ffff:192.0.2.45")).toBe("recorded");
      expect(recordFrom("2001:db8::1")).toBe("recorded");
      expect(service.metrics).toEqual({
        bucketCount: 3,
        saturated: false,
        suppressedCount: 2,
        window: 1,
      });
    } finally {
      database.close();
    }
  });

  it("coalesces missing and malformed clients while keeping failure reasons separate", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => auditTime, createId: idFactory("unattributed-client") },
    );
    try {
      database.migrate();
      expect(service.record({ outcome: "denied", reason: "authorization_denied" })).toBe(
        "recorded",
      );
      expect(service.record({ outcome: "failure", reason: "authorization_denied" })).toBe(
        "coalesced",
      );
      expect(service.record({ outcome: "failure", reason: "callback_validation_failed" })).toBe(
        "recorded",
      );

      for (let index = 0; index < 256; index += 1) {
        expect(
          service.record({
            ipAddress: `malformed-client-${index}`,
            outcome: "failure",
            reason: "provider_unavailable",
          }),
        ).toBe(index === 0 ? "recorded" : "coalesced");
      }

      expect(service.metrics).toEqual({
        bucketCount: 3,
        saturated: false,
        suppressedCount: 256,
        window: 1,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 3,
      });
    } finally {
      database.close();
    }
  });

  it("coalesces IPv6 /64 clients while key rotation consumes the existing generation", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const first = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("first-key") },
      );
      expect(
        first.record({
          ipAddress: "2001:db8:1:2::1",
          outcome: "denied",
          reason: "authorization_denied",
        }),
      ).toBe("recorded");
      expect(
        first.record({
          ipAddress: "2001:0db8:0001:0002:ffff::abcd",
          outcome: "denied",
          reason: "authorization_denied",
        }),
      ).toBe("coalesced");

      const rotated = new OidcFailureAuditService(
        database,
        { encryptionKey: Buffer.alloc(32, 42) },
        { clock: () => auditTime, createId: idFactory("rotated-key") },
      );
      expect(
        rotated.record({
          ipAddress: "2001:db8:1:2::1",
          outcome: "denied",
          reason: "authorization_denied",
        }),
      ).toBe("recorded");
      expect(rotated.metrics).toEqual({
        bucketCount: 2,
        saturated: false,
        suppressedCount: 1,
        window: 1,
      });
      expect(readScope(database).generation).toBe(1);
    } finally {
      database.close();
    }
  });

  it(
    "enforces one hard cap across true workers and separate database connections",
    { timeout: 30_000 },
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "omnifin-oidc-audit-workers-"));
      const databasePath = path.join(directory, "audit.db");
      const database = openDatabase(databasePath);
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const workers = Array.from({ length: 4 }, (_, workerIndex) =>
        startAuditWorker({ attempts: 64, databasePath, gate, workerIndex }),
      );
      try {
        database.migrate();
        await Promise.all(workers.map(({ ready }) => ready));
        const view = new Int32Array(gate);
        Atomics.store(view, 0, 1);
        Atomics.notify(view, 0, workers.length);
        const results = await Promise.all(workers.map(({ result }) => result));
        expect(results.every(({ status }) => status === "fulfilled")).toBe(true);

        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          {
            count: OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW,
          },
        );
        expect(
          database.sqlite.prepare("select count(*) as count from audit_budget_entries").get(),
        ).toEqual({ count: bucketCapacity });
        expect(
          database.sqlite
            .prepare(
              `select count(*) as count
               from audit_events
               where json_extract(metadata_json, '$.reason') = 'audit_saturated'`,
            )
            .get(),
        ).toEqual({ count: 1 });

        const restarted = new OidcFailureAuditService(database, { encryptionKey: privacyKey });
        expect(restarted.metrics).toEqual({
          bucketCount: bucketCapacity,
          saturated: true,
          suppressedCount: 256 - bucketCapacity,
          window: 1,
        });
      } finally {
        await Promise.all(workers.map(({ worker }) => worker.terminate()));
        database.close();
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("persists and saturates the suppressed counter without creating more audit rows", () => {
    const database = openDatabase(":memory:");
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => auditTime, createId: idFactory("suppressed") },
    );
    try {
      database.migrate();
      expect(recordUnique(service, 1)).toBe("recorded");
      for (let attempt = 0; attempt < OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT + 20; attempt += 1) {
        expect(recordUnique(service, 1)).toBe("coalesced");
      }
      expect(service.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
        window: 1,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it(
    "keeps a saturated generation bounded through ten thousand novel clients",
    { timeout: 30_000 },
    () => {
      const database = openDatabase(":memory:");
      const service = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("novel-saturation") },
      );
      try {
        database.migrate();
        for (let index = 0; index < bucketCapacity; index += 1) {
          expect(recordUnique(service, index)).toBe("recorded");
        }
        expect(recordUnique(service, bucketCapacity)).toBe("saturated");
        for (let index = 0; index < 10_000; index += 1) {
          expect(recordUnique(service, 10_000 + index)).toBe("saturated");
        }

        expect(service.metrics).toEqual({
          bucketCount: bucketCapacity,
          saturated: true,
          suppressedCount: OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
          window: 1,
        });
        expect(
          database.sqlite.prepare("select count(*) as count from audit_budget_entries").get(),
        ).toEqual({ count: bucketCapacity });
        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          { count: OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW },
        );
        expect(
          database.sqlite
            .prepare(
              `select count(*) as count
               from audit_events
               where json_extract(metadata_json, '$.reason') = 'audit_saturated'`,
            )
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    },
  );

  it("keeps budget decisions independent of a large immutable audit history", () => {
    const database = openDatabase(":memory:");
    const preparedSql: string[] = [];
    const originalPrepare = database.sqlite.prepare;
    try {
      database.migrate();
      const insertHistory = database.sqlite.prepare(
        `insert into audit_events (
           id, event_type, outcome, metadata_json, created_at
         ) values (?, 'fixture.history', 'success', '{}', ?)`,
      );
      database.sqlite.transaction(() => {
        for (let index = 0; index < 20_000; index += 1) {
          insertHistory.run(`history-${index}`, index);
        }
      })();

      database.sqlite.prepare = ((source: string) => {
        preparedSql.push(source);
        return originalPrepare.call(database.sqlite, source);
      }) as typeof database.sqlite.prepare;
      const service = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("large-history") },
      );
      expect(recordUnique(service, 1)).toBe("recorded");
      database.sqlite.prepare = originalPrepare;

      const budgetReads = preparedSql.filter((statement) => /^\s*select\b/iu.test(statement));
      expect(budgetReads).toHaveLength(2);
      expect(budgetReads.every((statement) => !/\baudit_events\b/iu.test(statement))).toBe(true);
      const plans = budgetReads.flatMap(
        (statement) =>
          database.sqlite
            .prepare(`explain query plan ${statement}`)
            .all({ scope: OIDC_FAILURE_AUDIT_SCOPE }) as { detail: string }[],
      );
      const planText = plans.map(({ detail }) => detail).join("\n");
      expect(planText).toContain("audit_budget_scopes");
      expect(planText).toContain("audit_budget_entries");
      expect(planText).not.toContain("audit_events");
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 20_001,
      });
      expect(service.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 0,
        window: 1,
      });
    } finally {
      database.sqlite.prepare = originalPrepare;
      database.close();
    }
  });

  it("advances normal windows atomically and exposes DB-backed metrics after restart", () => {
    const database = openDatabase(":memory:");
    let now = new Date(auditTime);
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => new Date(now), createId: idFactory("normal-rollover") },
    );
    try {
      database.migrate();
      expect(recordUnique(service, 1)).toBe("recorded");
      expect(recordUnique(service, 1)).toBe("coalesced");
      now = new Date(auditTime.getTime() + OIDC_FAILURE_AUDIT_WINDOW_MS);
      expect(recordUnique(service, 1)).toBe("recorded");
      expect(service.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 0,
        window: 2,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 2,
      });
      expect(
        database.sqlite.prepare("select distinct generation from audit_budget_entries").all(),
      ).toEqual([{ generation: 2 }]);

      const restarted = new OidcFailureAuditService(database, { encryptionKey: privacyKey });
      expect(restarted.metrics).toEqual(service.metrics);
    } finally {
      database.close();
    }
  });

  it("retains budgets through clock rollback and forward/backward alternation", () => {
    const database = openDatabase(":memory:");
    let now = new Date(auditTime);
    const service = new OidcFailureAuditService(
      database,
      { encryptionKey: privacyKey },
      { clock: () => new Date(now), createId: idFactory("clock-state") },
    );
    const future = auditTime.getTime() + 60 * 60 * 1_000;
    try {
      database.migrate();
      expect(recordUnique(service, 1)).toBe("recorded");

      now = new Date(future);
      expect(recordUnique(service, 2)).toBe("recorded");
      expect(service.metrics.window).toBe(2);

      now = new Date(auditTime.getTime() + 60_000);
      expect(recordUnique(service, 3)).toBe("recorded");
      expect(readScope(database)).toMatchObject({
        clockWatermarkAt: future,
        generation: 2,
        rollbackStartedAt: auditTime.getTime() + 60_000,
      });

      now = new Date(auditTime.getTime() + 60_000 + OIDC_FAILURE_AUDIT_WINDOW_MS);
      expect(recordUnique(service, 4)).toBe("recorded");
      expect(readScope(database)).toMatchObject({
        clockWatermarkAt: future,
        generation: 3,
        rollbackStartedAt: now.getTime(),
        windowStartedAt: now.getTime(),
      });

      now = new Date(future);
      expect(recordUnique(service, 4)).toBe("coalesced");
      now = new Date(auditTime.getTime() + 60_000 + OIDC_FAILURE_AUDIT_WINDOW_MS);
      expect(recordUnique(service, 4)).toBe("coalesced");
      now = new Date(future);
      expect(recordUnique(service, 4)).toBe("coalesced");
      expect(service.metrics).toMatchObject({ bucketCount: 1, window: 3 });

      now = new Date(auditTime.getTime());
      expect(recordUnique(service, 5)).toBe("recorded");
      expect(readScope(database).rollbackStartedAt).toBe(auditTime.getTime());
      now = new Date(auditTime.getTime() + OIDC_FAILURE_AUDIT_WINDOW_MS);
      expect(recordUnique(service, 6)).toBe("recorded");
      expect(service.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 0,
        window: 4,
      });
    } finally {
      database.close();
    }
  });

  it("persists rollback progress across a restart and advances after downtime", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-oidc-audit-rollback-"));
    const databasePath = path.join(directory, "audit.db");
    let database: ReturnType<typeof openDatabase> | undefined = openDatabase(databasePath);
    let now = new Date(auditTime);
    const serviceFor = (prefix: string) =>
      new OidcFailureAuditService(
        database!,
        { encryptionKey: privacyKey },
        { clock: () => new Date(now), createId: idFactory(prefix) },
      );
    const future = auditTime.getTime() + 60 * 60 * 1_000;
    try {
      database.migrate();
      const initial = serviceFor("before-restart");
      expect(recordUnique(initial, 1)).toBe("recorded");
      now = new Date(future);
      expect(recordUnique(initial, 2)).toBe("recorded");
      now = new Date(auditTime.getTime() + 60_000);
      expect(recordUnique(initial, 3)).toBe("recorded");
      expect(readScope(database)).toMatchObject({
        clockWatermarkAt: future,
        generation: 2,
        rollbackStartedAt: now.getTime(),
      });

      database.close();
      database = undefined;
      now = new Date(auditTime.getTime() + 60_000 + OIDC_FAILURE_AUDIT_WINDOW_MS);
      database = openDatabase(databasePath);
      const restarted = serviceFor("after-restart");
      expect(restarted.metrics).toEqual({
        bucketCount: 2,
        saturated: false,
        suppressedCount: 0,
        window: 2,
      });
      expect(recordUnique(restarted, 4)).toBe("recorded");
      expect(restarted.metrics).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 0,
        window: 3,
      });
      expect(readScope(database)).toMatchObject({
        clockWatermarkAt: future,
        generation: 3,
        rollbackStartedAt: now.getTime(),
        windowStartedAt: now.getTime(),
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 4,
      });
    } finally {
      database?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rolls back bucket and saturation state when the audit insert fails", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const duplicateId = "duplicate-audit-id";
      const collision = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: () => duplicateId },
      );
      expect(recordUnique(collision, 1)).toBe("recorded");
      expect(() => recordUnique(collision, 2)).toThrow();
      expect(collision.metrics).toMatchObject({ bucketCount: 1, saturated: false });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });

      const retry = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("retry") },
      );
      expect(recordUnique(retry, 2)).toBe("recorded");

      for (let index = 3; index <= bucketCapacity; index += 1) {
        expect(recordUnique(retry, index)).toBe("recorded");
      }
      expect(retry.metrics).toEqual({
        bucketCount: bucketCapacity,
        saturated: false,
        suppressedCount: 0,
        window: 1,
      });

      const markerCollision = new OidcFailureAuditService(
        database,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: () => duplicateId },
      );
      expect(() => recordUnique(markerCollision, 10_000)).toThrow();
      expect(markerCollision.metrics).toEqual({
        bucketCount: bucketCapacity,
        saturated: false,
        suppressedCount: 0,
        window: 1,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: bucketCapacity,
      });

      expect(recordUnique(retry, 10_000)).toBe("saturated");
      expect(retry.metrics).toEqual({
        bucketCount: bucketCapacity,
        saturated: true,
        suppressedCount: 1,
        window: 1,
      });
      const marker = database.sqlite
        .prepare(
          `select request_id as requestId, ip_hash as ipHash, metadata_json as metadataJson
           from audit_events
           where json_extract(metadata_json, '$.reason') = 'audit_saturated'`,
        )
        .get() as { ipHash: string | null; metadataJson: string; requestId: string | null };
      expect(marker).toEqual({
        ipHash: null,
        metadataJson: JSON.stringify({ budgetGeneration: 1, reason: "audit_saturated" }),
        requestId: null,
      });
    } finally {
      database.close();
    }
  });

  it("fails closed on persistent corruption and on a busy writer", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-oidc-audit-state-"));
    const databasePath = path.join(directory, "audit.db");
    const first = openDatabase(databasePath);
    let second: ReturnType<typeof openDatabase> | undefined;
    try {
      first.migrate();
      const firstService = new OidcFailureAuditService(
        first,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("busy-first") },
      );
      expect(recordUnique(firstService, 1)).toBe("recorded");

      second = openDatabase(databasePath);
      second.sqlite.pragma("busy_timeout = 1");
      first.sqlite.exec("begin immediate");
      const blocked = new OidcFailureAuditService(
        second,
        { encryptionKey: privacyKey },
        { clock: () => auditTime, createId: idFactory("busy-second") },
      );
      expect(() => recordUnique(blocked, 2)).toThrow(/busy|locked/i);
      first.sqlite.exec("rollback");
      expect(blocked.metrics).toMatchObject({ bucketCount: 1, window: 1 });

      first.sqlite.exec("drop trigger audit_budget_scopes_update_guarded");
      first.sqlite.pragma("ignore_check_constraints = ON");
      first.sqlite
        .prepare("update audit_budget_scopes set suppressed_count = 4097 where scope = ?")
        .run(OIDC_FAILURE_AUDIT_SCOPE);
      first.sqlite.pragma("ignore_check_constraints = OFF");
      expect(() => recordUnique(firstService, 3)).toThrow(/state is invalid/);
      expect(() => firstService.metrics).toThrow(/state is invalid/);
    } finally {
      if (first.sqlite.inTransaction) first.sqlite.exec("rollback");
      second?.close();
      first.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
