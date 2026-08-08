import {
  administratorRecoveryPreviewResponseSchema,
  sessionResponseSchema,
} from "@omnifin/contracts/auth";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  RECOVERY_DENIAL_AUDIT_MAX_ROWS,
  RECOVERY_DENIAL_AUDIT_WINDOW_MS,
  RecoveryAccessService,
} from "../src/auth/recovery-access-service.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import {
  MAX_RECOVERY_SESSION_ISSUANCES_PER_WINDOW,
  SESSION_ISSUANCE_WINDOW_MS,
  SessionService,
} from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { privacyHash } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const initialTime = new Date("2026-07-25T12:00:00.000Z");
const recoverySecret = Buffer.alloc(32, 17).toString("base64");
const wrongRecoverySecret = Buffer.alloc(32, 18).toString("base64");

function recoverySecretDigest() {
  return createHash("sha256").update(Buffer.from(recoverySecret, "base64")).digest();
}

function testConfig(
  options: { databaseUrl?: string; recoveryConfigured?: boolean } = {},
): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
    databaseUrl: options.databaseUrl ?? ":memory:",
    encryptionKey: Buffer.alloc(32, 23),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    ...(options.recoveryConfigured === false
      ? {}
      : { recoverySecretDigest: recoverySecretDigest() }),
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => new Date(initialTime),
    createId: () => `recovery-route-fixture-${(identifier += 1)}`,
    createToken: () => Buffer.alloc(32, (token += 1) % 255).toString("base64url"),
  };
}

function recoveryRequest(
  body: Record<string, unknown>,
  options: {
    cookie?: string;
    forwardedFor?: string;
    origin?: string;
    userAgent?: string;
  } = {},
) {
  return {
    body,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      origin: options.origin ?? baseUrl,
      "user-agent": options.userAgent ?? "recovery-route-test-agent",
      ...(options.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {}),
    },
    method: "POST" as const,
    url: "/v1/auth/recovery/session",
  };
}

function cookieHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join("; ") : (value ?? "");
}

function sessionCookie(token: string) {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function authenticatedSessionBody(value: unknown) {
  const body = sessionResponseSchema.parse(value);
  if (!body.principal) throw new Error("Expected an authenticated session response.");
  return body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recovery access route", () => {
  it("issues a bounded recovery session without advertising or persisting the credential", async () => {
    const database = openDatabase(":memory:");
    const config = testConfig();
    const app = await createApp({
      config,
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      const providers = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      expect(providers.body).not.toContain("recovery");

      const response = await app.inject(
        recoveryRequest({ secret: recoverySecret }, { userAgent: "private recovery agent" }),
      );
      const body = authenticatedSessionBody(response.json());
      const cookie = cookieHeader(response.headers["set-cookie"]);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(body.principal).toMatchObject({
        accountState: "recovery",
        authenticationMethod: { kind: "recovery" },
        role: "admin",
        userId: null,
      });
      expect(
        Date.parse(body.principal.absoluteExpiresAt) - Date.parse(body.principal.issuedAt),
      ).toBe(15 * 60 * 1_000);
      expect(response.body).not.toContain(recoverySecret);
      expect(cookie).toMatch(/^__Host-omnifin_session=/);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Expires=");
      expect(cookie).not.toContain("Domain=");
      expect(cookie).not.toContain(recoverySecret);

      const storedSession = database.sqlite
        .prepare(
          `select
            auth_method as authMethod,
            ip_hash as ipHash,
            user_agent_hash as userAgentHash,
            token_hash as tokenHash
           from sessions
           where id = ?`,
        )
        .get(body.principal.sessionId) as {
        authMethod: string;
        ipHash: string;
        tokenHash: string;
        userAgentHash: string;
      };
      expect(storedSession).toEqual({
        authMethod: "recovery",
        ipHash: privacyHash("ip_address", "127.0.0.1", config.encryptionKey),
        tokenHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        userAgentHash: privacyHash("user_agent", "private recovery agent", config.encryptionKey),
      });

      const accessAudit = database.sqlite
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
           from audit_events
           where event_type = 'auth.recovery_access.attempt'`,
        )
        .get() as Record<string, unknown>;
      expect(accessAudit).toMatchObject({
        actorAuthMethod: "recovery",
        actorSessionId: body.principal.sessionId,
        eventType: "auth.recovery_access.attempt",
        ipHash: privacyHash("ip_address", "127.0.0.1", config.encryptionKey),
        outcome: "success",
        requestId: expect.any(String),
        targetId: body.principal.sessionId,
        targetType: "recovery_access",
      });
      expect(JSON.parse(accessAudit.metadataJson as string)).toEqual({
        reason: "credential_verified",
        userAgentHash: privacyHash("user_agent", "private recovery agent", config.encryptionKey),
      });

      const databaseBytes = database.sqlite.serialize().toString("utf8");
      expect(databaseBytes).not.toContain(recoverySecret);
      expect(databaseBytes).not.toContain("private recovery agent");
      expect(databaseBytes).not.toContain("127.0.0.1");
    } finally {
      await app.close();
    }
  });

  it("fails closed with a bounded denial after the durable recovery issuance budget", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      for (let issuance = 0; issuance < MAX_RECOVERY_SESSION_ISSUANCES_PER_WINDOW; issuance += 1) {
        app.sessionService.createSession({ attribution: { authMethod: "recovery" } });
      }
      const storageBefore = database.sqlite
        .prepare(
          `select
             (select count(*) from sessions) as sessions,
             (select count(*) from session_secret_reservations) as reservations,
             (select count(*) from audit_events where event_type = 'auth.session.created') as creationAudits`,
        )
        .get();

      const response = await app.inject(recoveryRequest({ secret: recoverySecret }));

      expect(response.statusCode).toBe(429);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["retry-after"]).toBe(
        String(Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000)),
      );
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from sessions) as sessions,
               (select count(*) from session_secret_reservations) as reservations,
               (select count(*) from audit_events where event_type = 'auth.session.created') as creationAudits`,
          )
          .get(),
      ).toEqual(storageBefore);
      expect(
        database.sqlite
          .prepare(
            `select outcome, json_extract(metadata_json, '$.reason') as reason
             from audit_events
             where event_type = 'auth.recovery_access.attempt'
             order by created_at desc
             limit 1`,
          )
          .get(),
      ).toEqual({ outcome: "denied", reason: "rate_limited" });
    } finally {
      await app.close();
    }
  });

  it("makes missing configuration, wrong credentials, and malformed bodies indistinguishable", async () => {
    const cases: {
      body: Record<string, unknown>;
      configured: boolean;
      reason: "credential_mismatch" | "invalid_request";
    }[] = [
      { body: { secret: recoverySecret }, configured: false, reason: "credential_mismatch" },
      { body: { secret: wrongRecoverySecret }, configured: true, reason: "credential_mismatch" },
      { body: { secret: "not canonical base64" }, configured: true, reason: "invalid_request" },
      { body: {}, configured: true, reason: "invalid_request" },
      {
        body: { secret: recoverySecret, unexpected: true },
        configured: true,
        reason: "invalid_request",
      },
    ];
    const denials: { code: string; message: string; status: number }[] = [];

    for (const testCase of cases) {
      const database = openDatabase(":memory:");
      const app = await createApp({
        config: testConfig({ recoveryConfigured: testCase.configured }),
        database,
      });
      try {
        const response = await app.inject(recoveryRequest(testCase.body));
        const error = apiErrorSchema.parse(response.json()).error;
        denials.push({ code: error.code, message: error.message, status: response.statusCode });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
          count: 0,
        });
        const audit = database.sqlite
          .prepare(
            `select outcome, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.recovery_access.attempt'`,
          )
          .get() as { metadataJson: string; outcome: string };
        expect(audit).toEqual({
          metadataJson: JSON.stringify({
            reason: testCase.reason,
            userAgentHash: privacyHash(
              "user_agent",
              "recovery-route-test-agent",
              testConfig().encryptionKey,
            ),
          }),
          outcome: "denied",
        });
        expect(database.sqlite.serialize().toString("utf8")).not.toContain(
          typeof (testCase.body as { secret?: unknown })?.secret === "string"
            ? ((testCase.body as { secret: string }).secret ?? "unreachable")
            : recoverySecret,
        );
      } finally {
        await app.close();
      }
    }

    expect(new Set(denials.map((denial) => JSON.stringify(denial)))).toEqual(
      new Set([
        JSON.stringify({
          code: "recovery_access_denied",
          message: "Recovery access was denied.",
          status: 401,
        }),
      ]),
    );
  });

  it("requires the exact public origin and audits policy denials without invoking recovery", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      const response = await app.inject(
        recoveryRequest(
          { secret: recoverySecret },
          { origin: "https://omnifin.example.attacker.test" },
        ),
      );

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("origin_denied");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(
        database.sqlite
          .prepare(
            `select outcome, json_extract(metadata_json, '$.reason') as reason
             from audit_events
             where event_type = 'auth.recovery_access.attempt'`,
          )
          .get(),
      ).toEqual({ outcome: "denied", reason: "origin_denied" });
    } finally {
      await app.close();
    }
  });

  it("coalesces hundreds of route and global rate-limit denials into bounded durable audits", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      recoveryAccessDependencies: { clock: () => new Date(initialTime) },
    });
    try {
      let globalLimitDenials = 0;
      let routeLimitDenials = 0;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = await app.inject(recoveryRequest({ secret: wrongRecoverySecret }));
        if (attempt < 5) {
          expect(response.statusCode).toBe(401);
          continue;
        }
        expect(response.statusCode).toBe(429);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        if (response.headers["x-ratelimit-limit"] === "5") routeLimitDenials += 1;
        if (response.headers["x-ratelimit-limit"] === "300") globalLimitDenials += 1;
      }

      expect(routeLimitDenials).toBeGreaterThan(0);
      expect(globalLimitDenials).toBeGreaterThan(0);
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count
             from audit_events
             where event_type = 'auth.recovery_access.attempt'
               and json_extract(metadata_json, '$.reason') = 'rate_limited'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count
             from audit_events
             where event_type = 'auth.recovery_access.attempt'`,
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      await app.close();
    }
  });

  it("enforces one fixed denial-audit budget with a reserved saturation marker", () => {
    const database = openDatabase(":memory:");
    const config = testConfig();
    let now = new Date(initialTime);
    let auditId = 0;
    try {
      database.migrate();
      const access = new RecoveryAccessService(
        database,
        new SessionService(database, config),
        config,
        {
          clock: () => new Date(now),
          createId: () => `rate-limit-audit-${(auditId += 1)}`,
        },
      );
      let recorded = 0;
      const attemptedClients = RECOVERY_DENIAL_AUDIT_MAX_ROWS * 4;
      for (let client = 0; client < attemptedClients; client += 1) {
        if (
          access.recordRateLimitDeniedAttempt({
            ipAddress: `2001:db8::${client.toString(16)}`,
            requestId: `rotating-client-${client}`,
          })
        ) {
          recorded += 1;
        }
      }

      expect(recorded).toBe(RECOVERY_DENIAL_AUDIT_MAX_ROWS - 1);
      expect(access.denialAuditBudgetState).toEqual({
        bucketCount: RECOVERY_DENIAL_AUDIT_MAX_ROWS - 1,
        saturated: true,
        suppressedCount: attemptedClients - (RECOVERY_DENIAL_AUDIT_MAX_ROWS - 1),
        window: Math.floor(initialTime.getTime() / RECOVERY_DENIAL_AUDIT_WINDOW_MS),
      });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count
             from audit_events
             where json_extract(metadata_json, '$.reason') = 'rate_limited'`,
          )
          .get(),
      ).toEqual({ count: RECOVERY_DENIAL_AUDIT_MAX_ROWS - 1 });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count
             from audit_events
             where json_extract(metadata_json, '$.reason') = 'audit_budget_saturated'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: RECOVERY_DENIAL_AUDIT_MAX_ROWS,
      });
      expect(access.recordRateLimitDeniedAttempt({ ipAddress: "2001:db8::0" })).toBe(false);
      expect(
        access.recordRateLimitDeniedAttempt({
          ipAddress: `2001:db8::${attemptedClients.toString(16)}`,
        }),
      ).toBe(false);
      expect(database.sqlite.serialize().toString("utf8")).not.toContain("2001:db8::");

      now = new Date(now.getTime() + RECOVERY_DENIAL_AUDIT_WINDOW_MS);
      expect(
        access.recordRateLimitDeniedAttempt({
          ipAddress: `2001:db8::${attemptedClients.toString(16)}`,
        }),
      ).toBe(true);
      expect(access.denialAuditBudgetState).toEqual({
        bucketCount: 1,
        saturated: false,
        suppressedCount: 0,
        window: Math.floor(now.getTime() / RECOVERY_DENIAL_AUDIT_WINDOW_MS),
      });
    } finally {
      database.close();
    }
  });

  it(
    "caps mixed denial writes when trusted client addresses rotate below per-IP limits",
    { timeout: 30_000 },
    async () => {
      const database = openDatabase(":memory:");
      const app = await createApp({
        config: { ...testConfig(), trustProxyHops: 1 },
        database,
      });
      try {
        const clients = 300;
        for (let client = 0; client < clients; client += 1) {
          const forwardedFor = `192.0.2.10, 2001:db8:0:${client.toString(16)}::1`;
          const requests = [
            recoveryRequest({ secret: wrongRecoverySecret }, { forwardedFor }),
            recoveryRequest({}, { forwardedFor }),
            recoveryRequest(
              { secret: wrongRecoverySecret },
              { forwardedFor, origin: "https://attacker.example" },
            ),
            recoveryRequest({ secret: wrongRecoverySecret }, { forwardedFor }),
            recoveryRequest({ secret: wrongRecoverySecret }, { forwardedFor }),
          ];
          for (const [index, request] of requests.entries()) {
            const response = await app.inject(request);
            expect(response.statusCode).toBe(index === 2 ? 403 : 401);
            expect(response.headers["set-cookie"]).toBeUndefined();
          }
        }

        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          {
            count: RECOVERY_DENIAL_AUDIT_MAX_ROWS,
          },
        );
        expect(
          database.sqlite
            .prepare(
              `select outcome, ip_hash as ipHash, request_id as requestId
             from audit_events
             where json_extract(metadata_json, '$.reason') = 'audit_budget_saturated'`,
            )
            .all(),
        ).toEqual([{ ipHash: null, outcome: "failure", requestId: null }]);
        const recordedReasons = database.sqlite
          .prepare(
            `select distinct json_extract(metadata_json, '$.reason') as reason
           from audit_events
           order by reason`,
          )
          .all() as { reason: string }[];
        expect(recordedReasons.map(({ reason }) => reason)).toEqual([
          "audit_budget_saturated",
          "credential_mismatch",
          "invalid_request",
          "origin_denied",
        ]);
        expect(database.sqlite.serialize().toString("utf8")).not.toContain("2001:db8:");
      } finally {
        await app.close();
      }
    },
  );

  it("preserves an existing valid session on denial and atomically replaces it on success", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      const existing = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const existingCookie = sessionCookie(existing.sessionToken);
      for (const deniedBody of [
        { secret: wrongRecoverySecret },
        {},
        { secret: recoverySecret, unexpected: true },
      ]) {
        const denied = await app.inject(recoveryRequest(deniedBody, { cookie: existingCookie }));

        expect(denied.statusCode).toBe(401);
        expect(denied.headers["set-cookie"]).toBeUndefined();
        expect(
          database.sqlite
            .prepare("select revoked_at as revokedAt from sessions where id = ?")
            .get(existing.principal.sessionId),
        ).toEqual({ revokedAt: null });
      }
      const stillAuthenticated = await app.inject({
        headers: { cookie: existingCookie },
        method: "GET",
        url: "/v1/auth/session",
      });
      expect(sessionResponseSchema.parse(stillAuthenticated.json()).principal?.sessionId).toBe(
        existing.principal.sessionId,
      );

      const replacement = await app.inject(
        recoveryRequest({ secret: recoverySecret }, { cookie: existingCookie }),
      );
      const replacementBody = authenticatedSessionBody(replacement.json());
      expect(replacement.statusCode).toBe(200);
      expect(replacementBody.principal.sessionId).not.toBe(existing.principal.sessionId);
      expect(replacement.headers["set-cookie"]).toBeTruthy();
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(existing.principal.sessionId),
      ).toEqual({ revokedAt: initialTime.getTime() });
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType
             from audit_events
             where target_id = ? and event_type = 'auth.session.replaced'`,
          )
          .get(existing.principal.sessionId),
      ).toEqual({ eventType: "auth.session.replaced" });
    } finally {
      await app.close();
    }
  });

  it("acquires the immediate write lock before recovery session issuance begins", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "omnifin-recovery-lock-"));
    const databasePath = path.join(temporaryDirectory, "gateway.sqlite");
    const lockOwner = openDatabase(databasePath);
    const contender = openDatabase(databasePath);
    let sessionClockCalls = 0;
    try {
      lockOwner.migrate();
      contender.sqlite.pragma("busy_timeout = 0");
      const config = testConfig({ databaseUrl: databasePath });
      const dependencies = sessionDependencies();
      const sessionService = new SessionService(contender, config, {
        ...dependencies,
        clock: () => {
          sessionClockCalls += 1;
          return new Date(initialTime);
        },
      });
      const access = new RecoveryAccessService(contender, sessionService, config);
      lockOwner.sqlite.exec("begin immediate");

      expect(() =>
        access.authenticate({
          denialReason: "credential_mismatch",
          secret: recoverySecret,
        }),
      ).toThrow(/database is locked/i);
      expect(sessionClockCalls).toBe(0);
      expect(lockOwner.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(
        lockOwner.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 0 });
      expect(lockOwner.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      if (lockOwner.sqlite.inTransaction) lockOwner.sqlite.exec("rollback");
      contender.close();
      lockOwner.close();
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("preserves an existing valid session when recovery is not configured", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig({ recoveryConfigured: false }),
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      const existing = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const response = await app.inject(
        recoveryRequest(
          { secret: recoverySecret },
          { cookie: sessionCookie(existing.sessionToken) },
        ),
      );

      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(existing.principal.sessionId),
      ).toEqual({ revokedAt: null });
    } finally {
      await app.close();
    }
  });

  it("rejects oversized request bodies before credential handling and audits the denial", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      const response = await app.inject(recoveryRequest({ secret: "x".repeat(300) }));
      expect(response.statusCode).toBe(413);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(
        database.sqlite
          .prepare(
            `select outcome, json_extract(metadata_json, '$.reason') as reason
             from audit_events
             where event_type = 'auth.recovery_access.attempt'`,
          )
          .get(),
      ).toEqual({ outcome: "denied", reason: "invalid_request" });
    } finally {
      await app.close();
    }
  });

  it("rolls back replacement and withholds a cookie when durable auditing fails", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      const existing = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      database.sqlite.exec(`
        create trigger fail_recovery_access_audit
        before insert on audit_events
        when new.event_type = 'auth.recovery_access.attempt'
        begin
          select raise(abort, 'fixture audit failure');
        end
      `);

      const response = await app.inject(
        recoveryRequest(
          { secret: recoverySecret },
          { cookie: sessionCookie(existing.sessionToken) },
        ),
      );

      expect(response.statusCode).toBe(500);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(recoverySecret);
      expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
        code: "internal_error",
        message: "The gateway could not complete the request.",
      });
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(existing.principal.sessionId),
      ).toEqual({ revokedAt: null });
    } finally {
      await app.close();
    }
  });

  it("records an allowlisted failure audit when recovery session persistence fails", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      sessionDependencies: sessionDependencies(),
    });
    try {
      const existing = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      database.sqlite.exec(`
        create trigger fail_recovery_session_insert
        before insert on sessions
        when new.auth_method = 'recovery'
        begin
          select raise(abort, 'fixture session failure');
        end
      `);

      const response = await app.inject(
        recoveryRequest(
          { secret: recoverySecret },
          { cookie: sessionCookie(existing.sessionToken) },
        ),
      );

      expect(response.statusCode).toBe(500);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(existing.principal.sessionId),
      ).toEqual({ revokedAt: null });
      expect(
        database.sqlite
          .prepare(
            `select outcome, json_extract(metadata_json, '$.reason') as reason
             from audit_events
             where event_type = 'auth.recovery_access.attempt'`,
          )
          .get(),
      ).toEqual({ outcome: "failure", reason: "internal_failure" });
    } finally {
      await app.close();
    }
  });

  it("revokes a route-issued recovery session when the gateway starts again", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-recovery-route-"));
    const databaseUrl = path.join(directory, "omnifin.db");
    const config = testConfig({ databaseUrl });
    let sessionId: string;
    try {
      const firstDatabase = openDatabase(databaseUrl);
      const firstApp = await createApp({
        config,
        database: firstDatabase,
        sessionDependencies: sessionDependencies(),
      });
      const response = await firstApp.inject(recoveryRequest({ secret: recoverySecret }));
      sessionId = authenticatedSessionBody(response.json()).principal.sessionId;
      await firstApp.close();

      const restartedDatabase = openDatabase(databaseUrl);
      const restartedApp = await createApp({ config, database: restartedDatabase });
      try {
        expect(
          restartedDatabase.sqlite
            .prepare("select revoked_at as revokedAt from sessions where id = ?")
            .get(sessionId),
        ).toEqual({ revokedAt: expect.any(Number) });
        expect(
          restartedDatabase.sqlite
            .prepare(
              `select event_type as eventType
               from audit_events
               where target_id = ? and event_type = 'auth.recovery_session.revoked'`,
            )
            .get(sessionId),
        ).toEqual({ eventType: "auth.recovery_session.revoked" });
      } finally {
        await restartedApp.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not write a presented recovery credential to application logs", async () => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: { ...testConfig(), logLevel: "info" },
      database,
    });
    await app.inject(recoveryRequest({ secret: wrongRecoverySecret }));
    await app.close();
    stdout.mockRestore();

    expect(output.join("\n")).not.toContain(wrongRecoverySecret);
    expect(database.sqlite.open).toBe(false);
  });
});

describe("administrator recovery preview route", () => {
  it("is hidden, CSRF-bound, recovery-only, and returns no upstream identifiers", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      recoveryAccessDependencies: { clock: () => new Date(initialTime) },
      sessionDependencies: sessionDependencies(),
    });
    try {
      database.db
        .insert(connectorConfigs)
        .values({
          baseUrl: "https://jellyfin.example.test",
          createdAt: initialTime,
          displayName: "Home Jellyfin",
          encryptedCredentials: "v2.private-connector-secret",
          id: "jellyfin-home",
          type: "jellyfin",
          updatedAt: initialTime,
        })
        .run();
      database.db
        .insert(users)
        .values({
          createdAt: initialTime,
          displayName: "Current administrator",
          id: "opaque-administrator",
          role: "admin",
          roleSource: "manual",
          status: "active",
          updatedAt: initialTime,
        })
        .run();
      database.db
        .insert(serviceIdentityLinks)
        .values({
          connectorId: "jellyfin-home",
          createdAt: initialTime,
          deviceId: "private-device-id",
          encryptedAccessToken: "v2.private-access-token",
          externalDisplayName: "Upstream administrator",
          externalServerId: "private-server-id",
          externalUserId: "private-upstream-user-id",
          externalUsername: "upstream-admin",
          healthState: "linked",
          id: "administrator-link",
          lastVerifiedAt: initialTime,
          service: "jellyfin",
          tokenCreatedAt: initialTime,
          updatedAt: initialTime,
          userId: "opaque-administrator",
        })
        .run();
      const administrator = app.sessionService.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "administrator-link",
          userId: "opaque-administrator",
        },
      });
      const recovery = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const endpoint = "/v1/auth/recovery/administrator-replacement/preview";
      const blocked = await Promise.all([
        app.inject({
          body: {},
          headers: { origin: baseUrl },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body: {},
          headers: {
            cookie: sessionCookie(administrator.sessionToken),
            origin: baseUrl,
            "x-omnifin-csrf": administrator.csrfToken,
          },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body: {},
          headers: { cookie: sessionCookie(recovery.sessionToken), origin: baseUrl },
          method: "POST",
          url: endpoint,
        }),
        app.inject({
          body: {},
          headers: {
            cookie: sessionCookie(recovery.sessionToken),
            origin: "https://attacker.example",
            "x-omnifin-csrf": recovery.csrfToken,
          },
          method: "POST",
          url: endpoint,
        }),
      ]);
      expect(blocked.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);

      const response = await app.inject({
        body: {},
        headers: {
          cookie: sessionCookie(recovery.sessionToken),
          origin: baseUrl,
          "x-omnifin-csrf": recovery.csrfToken,
        },
        method: "POST",
        url: endpoint,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(administratorRecoveryPreviewResponseSchema.parse(response.json())).toEqual({
        administrator: {
          activeSessions: 1,
          authenticationMethods: ["jellyfin"],
          displayName: "Current administrator",
          id: "opaque-administrator",
          updatedAt: initialTime.toISOString(),
        },
        status: "available",
      });
      expect(response.body).not.toMatch(/private-|upstream-admin|administrator-link|jellyfin-home/);
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
