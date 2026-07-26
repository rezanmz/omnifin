import { apiErrorSchema } from "@omnifin/contracts/errors";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { oidcProviders } from "../src/db/schema.js";
import { SafeHttpError } from "../src/http-error.js";
import { startupFailureDetails } from "../src/startup-error.js";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 4),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    jellyfinUrl: new URL("https://jellyfin.example"),
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

describe("gateway application", () => {
  it("starts the production image in an explicitly approved loopback preview", async () => {
    const app = await createApp({
      config: {
        ...testConfig(),
        baseUrl: new URL("http://localhost:3000"),
        environment: "production",
        insecureLoopbackPreview: true,
        secureCookies: false,
      },
      database: openDatabase(":memory:"),
    });
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("closes the transferred database handle when initialization fails", async () => {
    const database = openDatabase(":memory:");
    const close = vi.fn(database.close);
    database.close = close;
    database.migrate = () => {
      throw new Error("fixture migration failure");
    };

    let failure: unknown;
    try {
      await createApp({ config: testConfig(), database });
    } catch (error) {
      failure = error;
    }
    expect(startupFailureDetails(failure)).toEqual({
      category: "migration",
      code: "database_migration_failed",
    });
    expect((failure as Error).message).not.toContain("fixture migration failure");
    expect(close).toHaveBeenCalledOnce();
    expect(() => database.sqlite.prepare("select 1").get()).toThrow(/not open/i);
  });

  it("keeps the database open for requests and closes it exactly once during shutdown", async () => {
    const database = openDatabase(":memory:");
    const close = vi.fn(database.close);
    database.close = close;
    const app = await createApp({ config: testConfig(), database });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const providers = await app.inject({ method: "GET", url: "/v1/auth/providers" });

    expect(health.statusCode).toBe(200);
    expect(providers.statusCode).toBe(200);
    expect(close).not.toHaveBeenCalled();

    await app.close();
    await app.close();

    expect(close).toHaveBeenCalledOnce();
    expect(() => database.sqlite.prepare("select 1").get()).toThrow(/not open/i);
  });

  it("reports liveness and database readiness without leaking details", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(health.headers["x-request-id"]).toBeTruthy();

    const migrationsBefore = database.sqlite
      .prepare('select count(*) as count from "__drizzle_migrations"')
      .get() as { count: number };
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ checks: { database: "ok" }, status: "ready" });
    const migrationsAfter = database.sqlite
      .prepare('select count(*) as count from "__drizzle_migrations"')
      .get() as { count: number };
    expect(migrationsAfter.count).toBe(migrationsBefore.count);
    await app.close();
  });

  it("bounds readiness probes that perform a database writeability transaction", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });

    for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "GET", url: "/readyz" });
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe("request_failed");
    await app.close();
  });

  it("applies restrictive browser headers to production API responses", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: { ...testConfig(), environment: "production" },
      database,
    });

    const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    await app.close();
  });

  it("rejects readiness when the database has not been migrated", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database, migrate: false });

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("service_unavailable");
    await app.close();
  });

  it("revokes recovery access on startup even when a pre-migrated deployment skips migrations", async () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.sqlite.exec(`
      insert into sessions (
        id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
        created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
      ) values (
        'pre-migrated-recovery', '${"r".repeat(43)}', 'recovery', '${"c".repeat(43)}',
        'v2.fixture-csrf', 1000, 1000, 1000, 2000, 3000
      )
    `);

    const app = await createApp({
      config: testConfig(),
      database,
      migrate: false,
      sessionDependencies: { clock: () => new Date(2_000) },
    });
    expect(
      database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = 'pre-migrated-recovery'")
        .get(),
    ).toEqual({ revokedAt: expect.any(Number) });
    expect(
      database.sqlite
        .prepare(
          `select event_type as eventType
           from audit_events
           where target_id = 'pre-migrated-recovery'`,
        )
        .get(),
    ).toEqual({ eventType: "auth.recovery_session.revoked" });
    await app.close();
  });

  it("rejects readiness when required schema is missing", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    database.sqlite.exec("drop table role_mappings");

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("service_unavailable");
    await app.close();
  });

  it("rejects readiness when the migrated database cannot accept a write transaction", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    database.sqlite.pragma("query_only = ON");

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("service_unavailable");
    database.sqlite.pragma("query_only = OFF");
    await app.close();
  });

  it("fails readiness without starving the event loop behind a competing writer", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-readiness-"));
    const databasePath = path.join(directory, "omnifin.db");
    const database = openDatabase(databasePath);
    const app = await createApp({
      config: { ...testConfig(), databaseUrl: databasePath },
      database,
    });
    const competingWriter = openDatabase(databasePath);
    competingWriter.sqlite.exec("begin immediate");

    try {
      const startedAt = performance.now();
      let timerFiredAt: number | undefined;
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFiredAt = performance.now();
          resolve();
        }, 10);
      });
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => app.inject({ method: "GET", url: "/readyz" })),
      );
      await timer;

      expect(responses).toHaveLength(20);
      for (const response of responses) {
        expect(response.statusCode).toBe(503);
        expect(apiErrorSchema.parse(response.json()).error.code).toBe("service_unavailable");
      }
      expect((timerFiredAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(250);
    } finally {
      if (competingWriter.sqlite.inTransaction) competingWriter.sqlite.exec("rollback");
      competingWriter.close();
      await app.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects readiness when the database connection is closed", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    database.sqlite.close();
    database.close = () => undefined;

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("service_unavailable");
    await app.close();
  });

  it("reports configured providers and the implemented Jellyfin login methods", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    database.db
      .insert(oidcProviders)
      .values({
        allowJitProvisioning: true,
        clientId: "omnifin",
        displayName: "Home identity",
        id: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        slug: "home",
      })
      .run();

    const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      providers: [
        {
          displayName: "Home identity",
          id: "oidc-home",
          issuer: "https://id.example.test/application/o/omnifin/",
          jitProvisioningEnabled: true,
          kind: "oidc",
          state: "unavailable",
          supportsBackChannelLogout: false,
          supportsFrontChannelLogout: false,
          supportsRpInitiatedLogout: false,
        },
        {
          displayName: "Jellyfin",
          id: "jellyfin",
          kind: "jellyfin",
          pairingRequiredAfterOidc: true,
          passwordLoginAvailable: true,
          quickConnectAvailable: true,
          state: "available",
        },
      ],
    });
    expect(response.body).not.toMatch(/token|password"|secret/i);
    await app.close();
  });

  it("denies state-changing requests without the configured public origin", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.post(
      "/v1/test-mutation",
      { config: { omnifinSecurity: { kind: "public-browser" } } },
      async () => ({ accepted: true }),
    );

    const denied = await app.inject({ method: "POST", url: "/v1/test-mutation" });
    expect(denied.statusCode).toBe(403);
    expect(apiErrorSchema.parse(denied.json()).error.code).toBe("origin_denied");
    expect(denied.headers["x-request-id"]).toBeTypeOf("string");
    expect(denied.headers["permissions-policy"]).toContain("camera=()");

    const accepted = await app.inject({
      headers: { origin: "https://omnifin.example" },
      method: "POST",
      url: "/v1/test-mutation",
    });
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });

  it("does not reflect invalid payload details in validation errors", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.post(
      "/v1/validated",
      {
        config: { omnifinSecurity: { kind: "public-browser" } },
        schema: {
          body: { type: "object", required: ["safe"], properties: { safe: { type: "string" } } },
        },
      },
      async () => ({ accepted: true }),
    );
    const response = await app.inject({
      headers: { origin: "https://omnifin.example" },
      method: "POST",
      payload: { password: "must-not-reflect" },
      url: "/v1/validated",
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
    expect(response.body).not.toContain("must-not-reflect");
    await app.close();
  });

  it("preserves explicitly safe domain errors without exposing their causes", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.get("/v1/domain-failure", async () => {
      throw new SafeHttpError({
        cause: new Error("password=private and /private/media/path"),
        code: "authentication_required",
        details: { relinkRequired: true },
        message: "Sign in to continue.",
        statusCode: 401,
      });
    });

    const response = await app.inject({ method: "GET", url: "/v1/domain-failure" });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json())).toEqual({
      error: {
        code: "authentication_required",
        details: { relinkRequired: true },
        message: "Sign in to continue.",
        requestId: response.headers["x-request-id"],
      },
    });
    expect(response.body).not.toContain("password=private");
    expect(response.body).not.toContain("/private/media/path");
    await app.close();
  });

  it("keeps internal failures generic and honors only safe request identifiers", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.get("/v1/failure", async () => {
      throw new Error("database path /private/media and token secret-value");
    });

    const failed = await app.inject({
      headers: { "x-request-id": "accepted_request_123" },
      method: "GET",
      url: "/v1/failure",
    });
    expect(failed.statusCode).toBe(500);
    expect(apiErrorSchema.parse(failed.json()).error.code).toBe("internal_error");
    expect(failed.headers["x-request-id"]).toBe("accepted_request_123");
    expect(failed.body).not.toContain("private/media");
    expect(failed.body).not.toContain("secret-value");

    const generated = await app.inject({
      headers: { "x-request-id": "bad id with spaces" },
      method: "GET",
      url: "/healthz",
    });
    expect(generated.headers["x-request-id"]).not.toBe("bad id with spaces");
    await app.close();
  });

  it("does not trust invalid status codes on internal errors", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.get("/v1/invalid-error-status", async () => {
      throw Object.assign(new Error("private connector failure"), {
        code: "UPSTREAM_PRIVATE_CODE",
        statusCode: 200,
      });
    });

    const response = await app.inject({ method: "GET", url: "/v1/invalid-error-status" });

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("internal_error");
    expect(response.body).not.toContain("UPSTREAM_PRIVATE_CODE");
    expect(response.body).not.toContain("private connector failure");
    await app.close();
  });

  it("uses the shared error envelope for routes that do not exist", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });

    const response = await app.inject({ method: "GET", url: "/v1/not-present" });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("request_failed");
    await app.close();
  });

  it("fails closed on the dedicated signed-logout surface until validation is wired", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.post(
      "/v1/auth/oidc/backchannel/:providerId",
      { config: { omnifinSecurity: { kind: "oidc-backchannel" } } },
      async () => ({ accepted: true }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/oidc/backchannel/provider",
    });
    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe(
      "backchannel_authentication_denied",
    );
    await app.close();
  });

  it("refuses to register mutations without an explicit request-security policy", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });

    expect(() => app.post("/v1/unsafe-mutation", async () => ({ accepted: true }))).toThrow(
      /must declare an Omnifin security policy/i,
    );
    expect(() =>
      app.post(
        "/v1/unsafe-backchannel",
        { config: { omnifinSecurity: { kind: "oidc-backchannel" } } },
        async () => ({ accepted: true }),
      ),
    ).toThrow(/limited to its dedicated POST route/i);
    await app.close();
  });

  it("denies session mutations when their CSRF proof is unavailable", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.delete(
      "/v1/session-bound",
      { config: { omnifinSecurity: { kind: "session" } } },
      async () => ({ accepted: true }),
    );

    const response = await app.inject({
      headers: { origin: "https://omnifin.example", "x-omnifin-csrf": "untrusted" },
      method: "DELETE",
      url: "/v1/session-bound",
    });
    expect(response.statusCode).toBe(403);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("csrf_denied");
    await app.close();
  });

  it("isolates rate limits by the nearest client and ignores spoofed forwarding prefixes", async () => {
    const proxyConfig = { ...testConfig(), trustProxyHops: 1 };
    const app = await createApp({ config: proxyConfig, database: openDatabase(":memory:") });

    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      const response = await app.inject({
        headers: {
          "x-forwarded-for": `203.0.113.${requestNumber % 250}, 198.51.100.20`,
        },
        method: "GET",
        url: "/v1/auth/providers",
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({
      headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.20" },
      method: "GET",
      url: "/v1/auth/providers",
    });
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe("request_failed");

    const otherClient = await app.inject({
      headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.21" },
      method: "GET",
      url: "/v1/auth/providers",
    });
    expect(otherClient.statusCode).toBe(200);
    await app.close();
  });

  it("applies the global fallback limit to routes without a stricter override", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    app.get("/v1/unconfigured-limit", async () => ({ accepted: true }));

    for (let requestNumber = 0; requestNumber < 300; requestNumber += 1) {
      const response = await app.inject({ method: "GET", url: "/v1/unconfigured-limit" });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "GET", url: "/v1/unconfigured-limit" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe("request_failed");
    await app.close();
  });
});
