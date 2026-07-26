import { PENDING_LINK_PERMISSIONS } from "@omnifin/contracts/auth";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";
import { SessionService } from "../src/auth/session-service.js";
import { hashToken } from "../src/security/crypto.js";

const initialTime = new Date("2026-07-25T12:00:00.000Z");

type IssuanceWorkerResult =
  | { csrfToken: string; sessionId: string; sessionToken: string; status: "fulfilled" }
  | { message: string; status: "rejected" };

interface IssuanceWorkerHandle {
  ready: Promise<void>;
  result: Promise<IssuanceWorkerResult>;
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

const issuanceWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    const { tsImport } = await import(workerData.tsxApiUrl);
    const { SessionService } = await tsImport(
      workerData.sessionServiceModuleUrl,
      workerData.parentUrl,
    );
    const { openDatabase } = await tsImport(
      workerData.databaseModuleUrl,
      workerData.parentUrl,
    );
    const database = openDatabase(workerData.databasePath);
    const gate = new Int32Array(workerData.gate);
    let identifier = 0;
    let tokenIndex = 0;
    let result;

    try {
      const service = new SessionService(
        database,
        {
          encryptionKey: Buffer.from(workerData.encryptionKey, "base64"),
          session: workerData.sessionConfig,
        },
        {
          clock: () => new Date(workerData.now),
          createId: () => workerData.workerId + "-" + (++identifier),
          createToken: () => workerData.tokens[tokenIndex++],
        },
      );
      parentPort.postMessage({ kind: "ready" });
      Atomics.wait(gate, 0, 0);
      try {
        const issued = service.createSession({ attribution: { authMethod: "recovery" } });
        result = {
          csrfToken: issued.csrfToken,
          sessionId: issued.principal.sessionId,
          sessionToken: issued.sessionToken,
          status: "fulfilled",
        };
      } catch (error) {
        result = {
          message: error instanceof Error ? error.message : "Unknown issuance failure.",
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
const sessionServiceModuleUrl = new URL("../src/auth/session-service.ts", import.meta.url).href;
const databaseModuleUrl = new URL("../src/db/client.ts", import.meta.url).href;

function startIssuanceWorker(input: {
  databasePath: string;
  gate: SharedArrayBuffer;
  tokens: string[];
  workerId: string;
}): IssuanceWorkerHandle {
  const ready = deferred<void>();
  const result = deferred<IssuanceWorkerResult>();
  let receivedReady = false;
  let receivedResult = false;
  const worker = new Worker(issuanceWorkerSource, {
    eval: true,
    workerData: {
      databaseModuleUrl,
      databasePath: input.databasePath,
      encryptionKey: Buffer.alloc(32, 9).toString("base64"),
      gate: input.gate,
      now: initialTime.toISOString(),
      parentUrl: import.meta.url,
      sessionConfig: sessionConfig(),
      sessionServiceModuleUrl,
      tokens: input.tokens,
      tsxApiUrl,
      workerId: input.workerId,
    },
  });

  worker.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("kind" in message)) return;
    const workerMessage = message as {
      kind: unknown;
      message?: unknown;
      result?: IssuanceWorkerResult;
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
        typeof workerMessage.message === "string"
          ? workerMessage.message
          : "Issuance worker failed.",
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
    const error = new Error(`Issuance worker exited before completing (code ${code}).`);
    ready.reject(error);
    result.reject(error);
  });

  return { ready: ready.promise, result: result.promise, worker };
}

function fixtureToken(byte: number) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function sessionConfig(overrides: Partial<AppConfig["session"]> = {}) {
  return {
    absoluteTtlMs: 60 * 60 * 1_000,
    inactivityTtlMs: 10 * 60 * 1_000,
    recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
    rotationIntervalMs: 5 * 60 * 1_000,
    ...overrides,
  };
}

function createHarness(
  database: DatabaseHandle,
  overrides: Partial<AppConfig["session"]> = {},
  dependencies: { createToken?: () => string } = {},
) {
  let now = new Date(initialTime);
  let identifier = 0;
  let token = 0;
  const service = new SessionService(
    database,
    { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig(overrides) },
    {
      clock: () => new Date(now),
      createId: () => `session-fixture-${(identifier += 1)}`,
      createToken:
        dependencies.createToken ?? (() => Buffer.alloc(32, (token += 1)).toString("base64url")),
    },
  );
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    service,
  };
}

function seedLinkedOidcIdentity(database: DatabaseHandle) {
  database.db
    .insert(users)
    .values({ displayName: "Riley", id: "user-1", role: "requester", status: "active" })
    .run();
  database.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin",
      displayName: "Home identity",
      id: "oidc-home",
      issuer: "https://id.example.test/application/o/omnifin/",
      slug: "home",
    })
    .run();
  database.db
    .insert(externalIdentities)
    .values({
      displayClaimsJson: JSON.stringify({
        displayName: "Riley",
        email: "riley@example.test",
      }),
      id: "identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      lastLoginAt: initialTime,
      providerId: "oidc-home",
      subject: "immutable-subject",
      userId: "user-1",
    })
    .run();
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: initialTime,
      deviceId: "device-1",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Riley",
      externalServerId: "server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "riley",
      healthState: "linked",
      id: "link-1",
      lastVerifiedAt: initialTime,
      service: "jellyfin",
      tokenCreatedAt: initialTime,
      userId: "user-1",
    })
    .run();
}

function seedSecondLinkedJellyfinUser(database: DatabaseHandle) {
  database.db
    .insert(users)
    .values({ displayName: "Morgan", id: "user-2", role: "viewer", status: "active" })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: initialTime,
      deviceId: "device-2",
      encryptedAccessToken: "v2.fixture-access-token-2",
      externalDisplayName: "Morgan",
      externalServerId: "server-1",
      externalUserId: "jellyfin-user-2",
      externalUsername: "morgan",
      healthState: "linked",
      id: "link-2",
      lastVerifiedAt: initialTime,
      service: "jellyfin",
      tokenCreatedAt: initialTime,
      userId: "user-2",
    })
    .run();
}

function issueOidcSession(service: SessionService) {
  return service.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "identity-1",
      idTokenHint: "private-id-token-hint",
      oidcProviderId: "oidc-home",
      oidcSessionId: "private-upstream-session-id",
      serviceIdentityLinkId: "link-1",
      userId: "user-1",
    },
    ipAddress: "192.0.2.10",
    requestId: "request_creation_123",
    userAgent: "fixture-browser/1.0",
  });
}

describe("SessionService", () => {
  it("persists only hashes and encrypted proofs while resolving complete OIDC attribution", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);

      const issued = issueOidcSession(service);
      const stored = database.db.select().from(sessions).get();

      expect(issued.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
        linkedServices: [{ id: "link-1", service: "jellyfin" }],
        role: "requester",
        userId: "user-1",
      });
      expect(stored).toMatchObject({
        csrfTokenHash: hashToken(issued.csrfToken),
        tokenHash: hashToken(issued.sessionToken),
      });
      const persisted = JSON.stringify(stored);
      expect(persisted).not.toContain(issued.sessionToken);
      expect(persisted).not.toContain(issued.csrfToken);
      expect(persisted).not.toContain("private-id-token-hint");
      expect(persisted).not.toContain("private-upstream-session-id");
      expect(stored?.encryptedCsrfToken).toMatch(/^v2\./);
      expect(stored?.encryptedIdTokenHint).toMatch(/^v2\./);
      expect(stored?.ipHash).toHaveLength(22);
      expect(stored?.userAgentHash).toHaveLength(22);
      const creationAudit = database.sqlite
        .prepare(
          `select
             event_type as eventType,
             metadata_json as metadataJson,
             request_id as requestId,
             ip_hash as ipHash
           from audit_events
           where event_type = 'auth.session.created'`,
        )
        .get();
      expect(creationAudit).toEqual({
        eventType: "auth.session.created",
        ipHash: expect.any(String),
        metadataJson: '{"authenticationMethod":"oidc"}',
        requestId: "request_creation_123",
      });
      expect(JSON.stringify(creationAudit)).not.toContain(issued.sessionToken);
      expect(JSON.stringify(creationAudit)).not.toContain(issued.csrfToken);
    } finally {
      database.close();
    }
  });

  it("caps recovery sessions at fifteen minutes even when configuration is more permissive", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database, {
        inactivityTtlMs: 60 * 60 * 1_000,
        recoveryAbsoluteTtlMs: 4 * 60 * 60 * 1_000,
      });

      const issued = service.createSession({ attribution: { authMethod: "recovery" } });

      expect(issued.principal).toMatchObject({
        accountState: "recovery",
        authenticationMethod: { kind: "recovery" },
        userId: null,
      });
      expect(issued.absoluteExpiresAt.getTime() - initialTime.getTime()).toBe(15 * 60 * 1_000);
      expect(issued.inactivityExpiresAt).toEqual(issued.absoluteExpiresAt);
    } finally {
      database.close();
    }
  });

  it("requires the exact usable Jellyfin identity link for direct sessions", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);

      expect(() =>
        service.createSession({
          attribution: {
            authMethod: "jellyfin",
            serviceIdentityLinkId: "missing-link",
            userId: "user-1",
          },
        }),
      ).toThrow(/foreign key/i);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);

      const issued = service.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });
      expect(issued.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        linkedServices: [{ id: "link-1" }],
      });

      database.db.update(connectorConfigs).set({ enabled: false }).run();
      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
    } finally {
      database.close();
    }
  });

  it("rolls back the session and both reservations when creation auditing fails", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      database.sqlite.exec(`create trigger fail_session_creation_audit
        before insert on audit_events
        when new.event_type = 'auth.session.created'
        begin
          select raise(abort, 'fixture creation audit failure');
        end`);

      expect(() => service.createSession({ attribution: { authMethod: "recovery" } })).toThrow(
        "fixture creation audit failure",
      );
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 0,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("resolves an OIDC identity without Jellyfin as a pairing-only pending account", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      database.db.delete(serviceIdentityLinks).run();
      database.db.delete(connectorConfigs).run();
      const { service } = createHarness(database);

      const issued = service.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          userId: "user-1",
        },
      });

      expect(issued.principal).toMatchObject({
        accountState: "pending_link",
        linkedServices: [],
        permissions: PENDING_LINK_PERMISSIONS,
      });
    } finally {
      database.close();
    }
  });

  it("rotates bearer hashes atomically, rejects the old token, and caps inactivity at absolute expiry", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database, {
        absoluteTtlMs: 20 * 60 * 1_000,
        inactivityTtlMs: 10 * 60 * 1_000,
      });
      const issued = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);

      const rotated = harness.service.resolveAndRefresh(issued.sessionToken);

      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");
      expect(rotated?.rotatedSessionToken).not.toBe(issued.sessionToken);
      expect(rotated?.inactivityExpiresAt).toEqual(
        new Date(initialTime.getTime() + 16 * 60 * 1_000),
      );
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toMatchObject({
        principal: { sessionId: issued.principal.sessionId },
      });
      const storedAfterRotation = database.db.select().from(sessions).get();
      expect(storedAfterRotation?.tokenHash).toBe(hashToken(rotated!.rotatedSessionToken!));
      expect(JSON.stringify(storedAfterRotation)).not.toContain(rotated!.rotatedSessionToken!);

      harness.advance(10_001);
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(harness.service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toBeNull();

      harness.advance(9 * 60 * 1_000);
      const nearAbsoluteExpiry = harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!);
      expect(nearAbsoluteExpiry?.inactivityExpiresAt).toEqual(
        new Date(initialTime.getTime() + 20 * 60 * 1_000),
      );
    } finally {
      database.close();
    }
  });

  it("fails closed at inactivity expiry and for malformed bearer cookies", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const harness = createHarness(database);
      const issued = harness.service.createSession({ attribution: { authMethod: "recovery" } });

      expect(harness.service.resolveAndRefresh("unbounded-or-malformed")).toBeNull();
      harness.advance(10 * 60 * 1_000);
      expect(harness.service.resolveAndRefresh(issued.sessionToken)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("validates CSRF proofs against both their hash and encrypted value without storing attempts", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      const incorrectCsrf = Buffer.alloc(32, 99).toString("base64url");

      expect(service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toMatchObject({
        sessionId: issued.principal.sessionId,
      });
      expect(
        service.validateSessionCsrf(issued.sessionToken, incorrectCsrf, {
          ipAddress: "192.0.2.11",
          requestId: "request_fixture_123",
        }),
      ).toBeNull();

      const audit = database.sqlite
        .prepare(
          `select
            event_type as eventType,
            outcome,
            metadata_json as metadataJson,
            request_id as requestId,
            ip_hash as ipHash
           from audit_events
           where event_type = 'auth.session.csrf_denied'`,
        )
        .get();
      expect(audit).toEqual({
        eventType: "auth.session.csrf_denied",
        ipHash: expect.any(String),
        metadataJson: '{"reason":"csrf_mismatch"}',
        outcome: "denied",
        requestId: "request_fixture_123",
      });
      expect(JSON.stringify(audit)).not.toContain(incorrectCsrf);
      expect(JSON.stringify(audit)).not.toContain(issued.csrfToken);
    } finally {
      database.close();
    }
  });

  it("revokes sessions whose encrypted CSRF proof fails integrity verification", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      database.sqlite
        .prepare("update sessions set encrypted_csrf_token = ?")
        .run("v2.invalid.invalid.invalid");

      expect(service.validateSessionCsrf(issued.sessionToken, issued.csrfToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select event_type as eventType, metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({
        eventType: "auth.session.invalidated",
        metadataJson: '{"reason":"csrf_integrity_failure"}',
      });
    } finally {
      database.close();
    }
  });

  it("revokes a session when joined provider attribution becomes unusable", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const issued = issueOidcSession(service);
      database.db.update(oidcProviders).set({ enabled: false }).run();

      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({ metadataJson: '{"reason":"attribution_invalid"}' });
    } finally {
      database.close();
    }
  });

  it("invalidates recovery records whose persisted absolute lifetime exceeds the hard cap", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });
      database.sqlite
        .prepare("update sessions set expires_at = ?, absolute_expires_at = ?")
        .run(initialTime.getTime() + 30 * 60 * 1_000, initialTime.getTime() + 60 * 60 * 1_000);

      expect(service.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(initialTime);
      expect(
        database.sqlite
          .prepare(
            `select metadata_json as metadataJson
             from audit_events
             where event_type = 'auth.session.invalidated'`,
          )
          .get(),
      ).toEqual({ metadataJson: '{"reason":"recovery_ttl_invalid"}' });
    } finally {
      database.close();
    }
  });

  it("atomically replaces a valid same-user session with replacement audit semantics", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);

      const replacement = service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          idTokenHint: "replacement-id-token-hint",
          oidcProviderId: "oidc-home",
          oidcSessionId: "replacement-upstream-session-id",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
        ipAddress: "192.0.2.20",
        requestId: "request_reauthentication_123",
        userAgent: "replacement-browser/1.0",
      });

      expect(replacement.principal).toMatchObject({
        authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
        userId: "user-1",
      });
      expect(replacement.principal.sessionId).not.toBe(previous.principal.sessionId);
      expect(service.resolveAndRefresh(previous.sessionToken)).toBeNull();
      expect(service.resolveAndRefresh(replacement.sessionToken)).toMatchObject({
        principal: { sessionId: replacement.principal.sessionId, userId: "user-1" },
      });
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(previous.principal.sessionId),
      ).toEqual({ revokedAt: initialTime.getTime() });

      const replacementAudit = database.sqlite
        .prepare(
          `select
             actor_user_id as actorUserId,
             actor_session_id as actorSessionId,
             actor_auth_method as actorAuthMethod,
             event_type as eventType,
             target_id as targetId,
             request_id as requestId,
             metadata_json as metadataJson
           from audit_events
           where event_type = 'auth.session.replaced'`,
        )
        .get();
      expect(replacementAudit).toEqual({
        actorAuthMethod: "oidc",
        actorSessionId: previous.principal.sessionId,
        actorUserId: "user-1",
        eventType: "auth.session.replaced",
        metadataJson: JSON.stringify({
          authenticationMethod: "oidc",
          reason: "reauthentication",
          replacementSessionId: replacement.principal.sessionId,
        }),
        requestId: "request_reauthentication_123",
        targetId: previous.principal.sessionId,
      });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
      const durableState = JSON.stringify({
        audits: database.sqlite.prepare("select * from audit_events").all(),
        sessions: database.db.select().from(sessions).all(),
      });
      expect(durableState).not.toContain(previous.sessionToken);
      expect(durableState).not.toContain(replacement.sessionToken);
      expect(durableState).not.toContain(replacement.csrfToken);
      expect(durableState).not.toContain("replacement-id-token-hint");
      expect(durableState).not.toContain("replacement-upstream-session-id");
    } finally {
      database.close();
    }
  });

  it("attributes a different-user replacement to the previous authenticated session", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      seedSecondLinkedJellyfinUser(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);

      const replacement = service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "link-2",
          userId: "user-2",
        },
        requestId: "request_account_switch_123",
      });

      expect(replacement.principal).toMatchObject({
        authenticationMethod: { kind: "jellyfin" },
        role: "viewer",
        userId: "user-2",
      });
      expect(service.resolveAndRefresh(previous.sessionToken)).toBeNull();
      expect(service.resolveAndRefresh(replacement.sessionToken)).toMatchObject({
        principal: { sessionId: replacement.principal.sessionId, userId: "user-2" },
      });
      expect(
        database.sqlite
          .prepare(
            `select
               actor_user_id as actorUserId,
               actor_session_id as actorSessionId,
               actor_auth_method as actorAuthMethod,
               metadata_json as metadataJson,
               target_id as targetId
             from audit_events
             where event_type = 'auth.session.replaced'`,
          )
          .get(),
      ).toEqual({
        actorAuthMethod: "oidc",
        actorSessionId: previous.principal.sessionId,
        actorUserId: "user-1",
        metadataJson: JSON.stringify({
          authenticationMethod: "jellyfin",
          reason: "reauthentication",
          replacementSessionId: replacement.principal.sessionId,
        }),
        targetId: previous.principal.sessionId,
      });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["no cookie", () => undefined],
    ["a malformed cookie", () => "not-a-session-token"],
    ["an unknown canonical cookie", () => Buffer.alloc(32, 91).toString("base64url")],
  ])("does not revoke another session when replacement receives %s", (_label, currentToken) => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const unrelated = issueOidcSession(service);

      const replacement = service.replaceSession(currentToken(), {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(service.resolveAndRefresh(unrelated.sessionToken)).toMatchObject({
        principal: { sessionId: unrelated.principal.sessionId },
      });
      expect(service.resolveAndRefresh(replacement.sessionToken)).toMatchObject({
        principal: { sessionId: replacement.principal.sessionId },
      });
      expect(database.db.select().from(sessions).all()).toHaveLength(2);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("does not replace an expired session", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database);
      const expired = issueOidcSession(harness.service);
      harness.advance(10 * 60 * 1_000);

      const replacement = harness.service.replaceSession(expired.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(harness.service.resolveAndRefresh(expired.sessionToken)).toBeNull();
      expect(harness.service.resolveAndRefresh(replacement.sessionToken)).not.toBeNull();
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(expired.principal.sessionId),
      ).toEqual({ revokedAt: null });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("does not replace a revoked session", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const revoked = issueOidcSession(service);
      database.sqlite
        .prepare("update sessions set revoked_at = ? where id = ?")
        .run(initialTime.getTime(), revoked.principal.sessionId);

      const replacement = service.replaceSession(revoked.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(service.resolveAndRefresh(revoked.sessionToken)).toBeNull();
      expect(service.resolveAndRefresh(replacement.sessionToken)).not.toBeNull();
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("retries token generation rather than reusing the presented cookie token", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      let identifier = 0;
      const previousToken = Buffer.alloc(32, 31).toString("base64url");
      const replacementToken = Buffer.alloc(32, 33).toString("base64url");
      const tokens = [
        previousToken,
        Buffer.alloc(32, 32).toString("base64url"),
        previousToken,
        replacementToken,
        Buffer.alloc(32, 34).toString("base64url"),
      ];
      const service = new SessionService(
        database,
        { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig() },
        {
          clock: () => new Date(initialTime),
          createId: () => `session-retry-${(identifier += 1)}`,
          createToken: () => tokens.shift() ?? Buffer.alloc(32, 99).toString("base64url"),
        },
      );
      const previous = issueOidcSession(service);

      const replacement = service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(previous.sessionToken).toBe(previousToken);
      expect(replacement.sessionToken).toBe(replacementToken);
      expect(replacement.sessionToken).not.toBe(previous.sessionToken);
      expect(service.resolveAndRefresh(previous.sessionToken)).toBeNull();
      expect(service.resolveAndRefresh(replacement.sessionToken)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects another user's active bearer and CSRF hashes for both replacement secrets", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      seedSecondLinkedJellyfinUser(database);
      let generated = [fixtureToken(41), fixtureToken(42), fixtureToken(43), fixtureToken(44)];
      const harness = createHarness(database, {}, { createToken: () => generated.shift()! });
      const previous = issueOidcSession(harness.service);
      const otherUser = harness.service.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "link-2",
          userId: "user-2",
        },
      });
      const replacementBearer = fixtureToken(45);
      const replacementCsrf = fixtureToken(46);
      generated = [
        otherUser.sessionToken,
        otherUser.csrfToken,
        replacementBearer,
        otherUser.sessionToken,
        otherUser.csrfToken,
        replacementCsrf,
      ];

      const replacement = harness.service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(replacement.sessionToken).toBe(replacementBearer);
      expect(replacement.csrfToken).toBe(replacementCsrf);
      expect(replacement.sessionToken).not.toBe(otherUser.sessionToken);
      expect(replacement.sessionToken).not.toBe(otherUser.csrfToken);
      expect(replacement.csrfToken).not.toBe(otherUser.sessionToken);
      expect(replacement.csrfToken).not.toBe(otherUser.csrfToken);
      generated = [fixtureToken(47)];
      expect(harness.service.resolveAndRefresh(otherUser.sessionToken)).toMatchObject({
        principal: { sessionId: otherUser.principal.sessionId, userId: "user-2" },
      });
      expect(
        database.sqlite
          .prepare(
            `select count(*) as count
             from audit_events
             where event_type not in ('auth.session.created', 'auth.session.replaced')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects another active bearer while generating a rotated bearer", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      seedSecondLinkedJellyfinUser(database);
      let generated = [fixtureToken(51), fixtureToken(52), fixtureToken(53), fixtureToken(54)];
      const harness = createHarness(database, {}, { createToken: () => generated.shift()! });
      const rotating = issueOidcSession(harness.service);
      const otherUser = harness.service.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "link-2",
          userId: "user-2",
        },
      });
      const safeRotatedBearer = fixtureToken(55);
      generated = [otherUser.sessionToken, otherUser.csrfToken, safeRotatedBearer];
      harness.advance(6 * 60 * 1_000);

      const rotated = harness.service.resolveAndRefresh(rotating.sessionToken);

      expect(rotated?.rotatedSessionToken).toBe(safeRotatedBearer);
      generated = [fixtureToken(56)];
      expect(harness.service.resolveAndRefresh(otherUser.sessionToken)).toMatchObject({
        principal: { sessionId: otherUser.principal.sessionId },
      });
      expect(database.db.select().from(sessions).all()).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("never reuses a live rotation-grace bearer as a replacement CSRF secret", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const graceBearer = fixtureToken(61);
      const rotatedBearer = fixtureToken(63);
      const replacementBearer = fixtureToken(64);
      const replacementCsrf = fixtureToken(65);
      const generated = [
        graceBearer,
        fixtureToken(62),
        rotatedBearer,
        replacementBearer,
        graceBearer,
        replacementCsrf,
      ];
      const harness = createHarness(database, {}, { createToken: () => generated.shift()! });
      const previous = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(previous.sessionToken);
      expect(rotated?.rotatedSessionToken).toBe(rotatedBearer);

      const replacement = harness.service.replaceSession(rotatedBearer, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(replacement.sessionToken).toBe(replacementBearer);
      expect(replacement.csrfToken).toBe(replacementCsrf);
      expect(replacement.csrfToken).not.toBe(graceBearer);
    } finally {
      database.close();
    }
  });

  for (const inactiveLifecycle of ["expired", "revoked"] as const) {
    it(`never reissues secrets reserved by ${inactiveLifecycle} rows`, () => {
      const database = openDatabase(":memory:");
      try {
        database.migrate();
        let generated = [fixtureToken(71), fixtureToken(72)];
        const harness = createHarness(database, {}, { createToken: () => generated.shift()! });
        const historical = harness.service.createSession({
          attribution: { authMethod: "recovery" },
        });
        if (inactiveLifecycle === "expired") {
          harness.advance(10 * 60 * 1_000);
        } else {
          database.sqlite
            .prepare("update sessions set revoked_at = ? where id = ?")
            .run(initialTime.getTime(), historical.principal.sessionId);
        }
        const newBearer = fixtureToken(73);
        const newCsrf = fixtureToken(74);
        generated = [historical.sessionToken, newBearer, historical.csrfToken, newCsrf];

        const issued = harness.service.createSession({
          attribution: { authMethod: "recovery" },
        });

        expect(issued.sessionToken).toBe(newBearer);
        expect(issued.csrfToken).toBe(newCsrf);
        expect(issued.sessionToken).not.toBe(historical.sessionToken);
        expect(issued.csrfToken).not.toBe(historical.csrfToken);
        expect(database.db.select().from(sessions).all()).toHaveLength(2);
        expect(
          database.sqlite
            .prepare(
              `select count(*) as count
               from audit_events
               where event_type <> 'auth.session.created'`,
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    });
  }

  it("prunes expired rotation grace while permanently retaining its reservation", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const graceBearer = fixtureToken(81);
      const generated = [
        graceBearer,
        fixtureToken(82),
        fixtureToken(83),
        fixtureToken(84),
        graceBearer,
        fixtureToken(85),
      ];
      const harness = createHarness(database, {}, { createToken: () => generated.shift()! });
      const previous = harness.service.createSession({ attribution: { authMethod: "recovery" } });
      harness.advance(6 * 60 * 1_000);
      expect(harness.service.resolveAndRefresh(previous.sessionToken)?.rotatedSessionToken).toBe(
        fixtureToken(83),
      );
      harness.advance(10_001);

      const issued = harness.service.createSession({ attribution: { authMethod: "recovery" } });

      expect(issued.sessionToken).toBe(fixtureToken(84));
      expect(issued.csrfToken).toBe(fixtureToken(85));
      expect(
        database.sqlite
          .prepare("select count(*) as count from session_rotation_aliases where token_hash = ?")
          .get(hashToken(graceBearer)),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare("select purpose from session_secret_reservations where secret_hash = ?")
          .get(hashToken(graceBearer)),
      ).toEqual({ purpose: "bearer" });
    } finally {
      database.close();
    }
  });

  it("keeps rotation grace durable across restart and expires it at the exact boundary", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "omnifin-session-grace-"));
    const databasePath = join(temporaryDirectory, "gateway.sqlite");
    const encryptionKey = Buffer.alloc(32, 9);
    let database: DatabaseHandle | undefined;
    let now = initialTime.getTime();
    let identifier = 0;
    const generated = [fixtureToken(111), fixtureToken(112), fixtureToken(113)];
    try {
      database = openDatabase(databasePath);
      database.migrate();
      const serviceA = new SessionService(
        database,
        { encryptionKey, session: sessionConfig() },
        {
          clock: () => new Date(now),
          createId: () => `session-restart-a-${(identifier += 1)}`,
          createToken: () => generated.shift()!,
        },
      );
      const issued = serviceA.createSession({ attribution: { authMethod: "recovery" } });
      now += 6 * 60 * 1_000;
      const rotated = serviceA.resolveAndRefresh(issued.sessionToken);
      expect(rotated?.rotatedSessionToken).toBe(fixtureToken(113));
      const alias = database.sqlite
        .prepare(
          `select valid_from as validFrom, expires_at as expiresAt
           from session_rotation_aliases
           where token_hash = ?`,
        )
        .get(hashToken(issued.sessionToken)) as { expiresAt: number; validFrom: number };
      expect(alias).toEqual({ expiresAt: now + 10_000, validFrom: now });
      database.close();
      database = undefined;

      database = openDatabase(databasePath);
      now = alias.expiresAt - 1;
      const serviceB = new SessionService(
        database,
        { encryptionKey, session: sessionConfig() },
        {
          clock: () => new Date(now),
          createId: () => `session-restart-b-${(identifier += 1)}`,
          createToken: () => fixtureToken(114),
        },
      );
      expect(serviceB.resolveAndRefresh(issued.sessionToken)).toMatchObject({
        principal: { sessionId: issued.principal.sessionId },
      });
      database.close();
      database = undefined;

      database = openDatabase(databasePath);
      now = alias.expiresAt;
      const serviceC = new SessionService(
        database,
        { encryptionKey, session: sessionConfig() },
        {
          clock: () => new Date(now),
          createId: () => `session-restart-c-${(identifier += 1)}`,
          createToken: () => fixtureToken(115),
        },
      );
      expect(serviceC.resolveAndRefresh(issued.sessionToken)).toBeNull();
      expect(
        database.sqlite
          .prepare("select count(*) as count from session_rotation_aliases where token_hash = ?")
          .get(hashToken(issued.sessionToken)),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare("select purpose from session_secret_reservations where secret_hash = ?")
          .get(hashToken(issued.sessionToken)),
      ).toEqual({ purpose: "bearer" });
      expect(serviceC.resolveAndRefresh(rotated!.rotatedSessionToken!)).toMatchObject({
        principal: { sessionId: issued.principal.sessionId },
      });
    } finally {
      database?.close();
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("serializes simultaneous issuance and prevents cross-process cross-purpose reuse", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "omnifin-session-issuance-"));
    const databasePath = join(temporaryDirectory, "gateway.sqlite");
    const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(gateBuffer);
    const sharedBearer = fixtureToken(121);
    const sharedCsrf = fixtureToken(122);
    const workers: IssuanceWorkerHandle[] = [];
    let inspectionDatabase: DatabaseHandle | undefined;
    try {
      const migrationDatabase = openDatabase(databasePath);
      migrationDatabase.migrate();
      migrationDatabase.close();
      workers.push(
        startIssuanceWorker({
          databasePath,
          gate: gateBuffer,
          tokens: [sharedBearer, sharedCsrf, fixtureToken(123), fixtureToken(124)],
          workerId: "session-worker-a",
        }),
        startIssuanceWorker({
          databasePath,
          gate: gateBuffer,
          tokens: [sharedBearer, sharedCsrf, fixtureToken(125), fixtureToken(126)],
          workerId: "session-worker-b",
        }),
      );
      await Promise.all(workers.map((worker) => worker.ready));
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      const results = await Promise.all(workers.map((worker) => worker.result));

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const issued = results.filter(
        (result): result is Extract<IssuanceWorkerResult, { status: "fulfilled" }> =>
          result.status === "fulfilled",
      );
      expect(issued).toHaveLength(2);
      expect(
        new Set(issued.flatMap((result) => [result.sessionToken, result.csrfToken])).size,
      ).toBe(4);
      expect(
        issued.filter(
          (result) => result.sessionToken === sharedBearer && result.csrfToken === sharedCsrf,
        ),
      ).toHaveLength(1);

      inspectionDatabase = openDatabase(databasePath);
      expect(
        inspectionDatabase.sqlite.prepare("select count(*) as count from sessions").get(),
      ).toEqual({ count: 2 });
      expect(
        inspectionDatabase.sqlite
          .prepare("select count(*) as count from session_secret_reservations")
          .get(),
      ).toEqual({ count: 4 });
      expect(
        inspectionDatabase.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.created'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        inspectionDatabase.sqlite
          .prepare(
            `select purpose
             from session_secret_reservations
             where secret_hash in (?, ?)
             order by purpose`,
          )
          .all(hashToken(sharedBearer), hashToken(sharedCsrf)),
      ).toEqual([{ purpose: "bearer" }, { purpose: "csrf" }]);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      inspectionDatabase?.close();
      await Promise.allSettled(workers.map((worker) => worker.worker.terminate()));
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("uses one operation timestamp for issuance, revocation, and replacement auditing", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      let clockCalls = 0;
      let identifier = 0;
      let token = 0;
      const service = new SessionService(
        database,
        { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig() },
        {
          clock: () => new Date(initialTime.getTime() + clockCalls++ * 1_000),
          createId: () => `session-clock-${(identifier += 1)}`,
          createToken: () => Buffer.alloc(32, (token += 1)).toString("base64url"),
        },
      );
      const previous = issueOidcSession(service);
      const operationTime = new Date(initialTime.getTime() + 1_000);

      const replacement = service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(clockCalls).toBe(2);
      expect(
        database.sqlite
          .prepare(
            `select created_at as createdAt, revoked_at as revokedAt
             from sessions
             where id = ?`,
          )
          .get(previous.principal.sessionId),
      ).toEqual({ createdAt: initialTime.getTime(), revokedAt: operationTime.getTime() });
      expect(
        database.sqlite
          .prepare("select created_at as createdAt from sessions where id = ?")
          .get(replacement.principal.sessionId),
      ).toEqual({ createdAt: operationTime.getTime() });
      expect(
        database.sqlite
          .prepare(
            `select created_at as createdAt
             from audit_events
             where event_type = 'auth.session.replaced'`,
          )
          .get(),
      ).toEqual({ createdAt: operationTime.getTime() });
    } finally {
      database.close();
    }
  });

  it("preserves rotation grace when an enclosing transaction rolls replacement back", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database);
      const previous = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(previous.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");

      expect(() =>
        database.sqlite.transaction(() => {
          harness.service.replaceSession(previous.sessionToken, {
            attribution: {
              authMethod: "oidc",
              externalIdentityId: "identity-1",
              oidcProviderId: "oidc-home",
              serviceIdentityLinkId: "link-1",
              userId: "user-1",
            },
          });
          throw new Error("fixture outer transaction failure");
        })(),
      ).toThrow("fixture outer transaction failure");

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.db.select().from(sessions).get()).toMatchObject({
        id: previous.principal.sessionId,
        revokedAt: null,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 3 });
      expect(
        database.sqlite.prepare("select count(*) as count from session_rotation_aliases").get(),
      ).toEqual({ count: 1 });
      expect(harness.service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
      expect(harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("replaces a session through its rotation-grace token", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database);
      const previous = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(previous.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");

      const replacement = harness.service.replaceSession(previous.sessionToken, {
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "link-1",
          userId: "user-1",
        },
      });

      expect(harness.service.resolveAndRefresh(previous.sessionToken)).toBeNull();
      expect(harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!)).toBeNull();
      expect(harness.service.resolveAndRefresh(replacement.sessionToken)).toMatchObject({
        principal: { sessionId: replacement.principal.sessionId },
      });
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = ?")
          .get(previous.principal.sessionId),
      ).toEqual({ revokedAt: initialTime.getTime() + 6 * 60 * 1_000 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("fails closed on replacement token-generation exhaustion", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      let generated = [fixtureToken(91), fixtureToken(92)];
      let exhaustGeneration = false;
      let replacementGenerationCalls = 0;
      const harness = createHarness(
        database,
        {},
        {
          createToken: () => {
            if (!exhaustGeneration) return generated.shift()!;
            replacementGenerationCalls += 1;
            return "invalid-token-candidate";
          },
        },
      );
      const previous = issueOidcSession(harness.service);
      exhaustGeneration = true;

      expect(() =>
        harness.service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow("A unique secure session token could not be generated.");

      expect(replacementGenerationCalls).toBe(8);
      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      exhaustGeneration = false;
      generated = [fixtureToken(93)];
      expect(harness.service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  for (const collidingSecret of ["bearer", "csrf"] as const) {
    it(`fails closed when every replacement bearer collides with another active ${collidingSecret}`, () => {
      const database = openDatabase(":memory:");
      try {
        database.migrate();
        seedLinkedOidcIdentity(database);
        seedSecondLinkedJellyfinUser(database);
        let generated = [
          fixtureToken(101),
          fixtureToken(102),
          fixtureToken(103),
          fixtureToken(104),
        ];
        let collisionToken: string | undefined;
        let replacementGenerationCalls = 0;
        const harness = createHarness(
          database,
          {},
          {
            createToken: () => {
              if (collisionToken) {
                replacementGenerationCalls += 1;
                return collisionToken;
              }
              return generated.shift()!;
            },
          },
        );
        const previous = issueOidcSession(harness.service);
        const otherUser = harness.service.createSession({
          attribution: {
            authMethod: "jellyfin",
            serviceIdentityLinkId: "link-2",
            userId: "user-2",
          },
        });
        collisionToken =
          collidingSecret === "bearer" ? otherUser.sessionToken : otherUser.csrfToken;

        expect(() =>
          harness.service.replaceSession(previous.sessionToken, {
            attribution: {
              authMethod: "oidc",
              externalIdentityId: "identity-1",
              oidcProviderId: "oidc-home",
              serviceIdentityLinkId: "link-1",
              userId: "user-1",
            },
          }),
        ).toThrow("A unique secure session token could not be generated.");

        expect(replacementGenerationCalls).toBe(8);
        expect(database.db.select().from(sessions).all()).toHaveLength(2);
        expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
          {
            count: 2,
          },
        );
        collisionToken = undefined;
        generated = [fixtureToken(105), fixtureToken(106)];
        expect(harness.service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
          principal: { sessionId: previous.principal.sessionId },
        });
        expect(harness.service.resolveAndRefresh(otherUser.sessionToken)).toMatchObject({
          principal: { sessionId: otherUser.principal.sessionId },
        });
      } finally {
        database.close();
      }
    });
  }

  it("rolls back a replacement row that cannot establish its principal", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);
      database.sqlite.exec(`create trigger invalidate_replacement_principal
        after insert on sessions
        when new.id <> '${previous.principal.sessionId}'
        begin
          update oidc_providers set enabled = 0 where id = 'oidc-home';
        end`);

      expect(() =>
        service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow("Session attribution could not be established.");

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(
        database.sqlite.prepare("select enabled from oidc_providers where id = 'oidc-home'").get(),
      ).toEqual({ enabled: 1 });
      expect(service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("rolls back a replacement when its creation audit cannot be inserted", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);
      database.sqlite.exec(`create trigger fail_replacement_creation_audit
        before insert on audit_events
        when new.event_type = 'auth.session.created'
          and new.actor_session_id <> '${previous.principal.sessionId}'
        begin
          select raise(abort, 'fixture creation audit failure');
        end`);

      expect(() =>
        service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow("fixture creation audit failure");

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("rolls back issuance when a valid current session cannot be revoked", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);
      database.sqlite.exec(`create trigger suppress_replacement_revocation
        before update of revoked_at on sessions
        when old.id = '${previous.principal.sessionId}' and new.revoked_at is not null
        begin
          select raise(ignore);
        end`);

      expect(() =>
        service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow(/could not be replaced/i);

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("rolls back the new session, revocation, and audits when replacement auditing fails", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);
      database.sqlite.exec(`create trigger fail_replacement_audit
        before insert on audit_events
        when new.event_type = 'auth.session.replaced'
        begin
          select raise(abort, 'fixture replacement audit failure');
        end`);

      expect(() =>
        service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow("fixture replacement audit failure");

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.db.select().from(sessions).get()).toMatchObject({
        id: previous.principal.sessionId,
        revokedAt: null,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 2 });
      expect(service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("keeps rotation grace usable when replacement fails after revocation", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const harness = createHarness(database);
      const previous = issueOidcSession(harness.service);
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(previous.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");
      database.sqlite.exec(`create trigger fail_replacement_audit_with_grace
        before insert on audit_events
        when new.event_type = 'auth.session.replaced'
        begin
          select raise(abort, 'fixture grace replacement failure');
        end`);

      expect(() =>
        harness.service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "oidc",
            externalIdentityId: "identity-1",
            oidcProviderId: "oidc-home",
            serviceIdentityLinkId: "link-1",
            userId: "user-1",
          },
        }),
      ).toThrow("fixture grace replacement failure");

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.db.select().from(sessions).get()).toMatchObject({
        id: previous.principal.sessionId,
        revokedAt: null,
      });
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 3 });
      expect(
        database.sqlite.prepare("select count(*) as count from session_rotation_aliases").get(),
      ).toEqual({ count: 1 });
      expect(harness.service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
      expect(harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("leaves the current session usable when replacement attribution is invalid", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedLinkedOidcIdentity(database);
      const { service } = createHarness(database);
      const previous = issueOidcSession(service);

      expect(() =>
        service.replaceSession(previous.sessionToken, {
          attribution: {
            authMethod: "jellyfin",
            serviceIdentityLinkId: "missing-link",
            userId: "user-1",
          },
        }),
      ).toThrow(/foreign key/i);

      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
      expect(service.resolveAndRefresh(previous.sessionToken)).toMatchObject({
        principal: { sessionId: previous.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("audits successful revocation and treats repeated revocation as idempotent", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const { service } = createHarness(database);
      const issued = service.createSession({ attribution: { authMethod: "recovery" } });

      expect(
        service.revokeSession(issued.sessionToken, {
          ipAddress: "192.0.2.12",
          requestId: "request_logout_123",
        }),
      ).toBe(true);
      expect(service.revokeSession(issued.sessionToken)).toBe(false);
      expect(
        database.sqlite
          .prepare(
            `select
              event_type as eventType,
              outcome,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod,
              request_id as requestId,
              metadata_json as metadataJson
             from audit_events`,
          )
          .all(),
      ).toEqual([
        {
          actorAuthMethod: "recovery",
          actorSessionId: issued.principal.sessionId,
          eventType: "auth.session.created",
          metadataJson: '{"authenticationMethod":"recovery"}',
          outcome: "success",
          requestId: null,
        },
        {
          actorAuthMethod: "recovery",
          actorSessionId: issued.principal.sessionId,
          eventType: "auth.session.logout",
          metadataJson: '{"reason":"user_logout"}',
          outcome: "success",
          requestId: "request_logout_123",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("revokes by the stable validated session when a concurrent read rotates the bearer", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const harness = createHarness(database);
      const issued = harness.service.createSession({ attribution: { authMethod: "recovery" } });
      const validated = harness.service.validateSessionCsrf(issued.sessionToken, issued.csrfToken);
      expect(validated).not.toBeNull();
      harness.advance(6 * 60 * 1_000);
      const rotated = harness.service.resolveAndRefresh(issued.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");

      expect(harness.service.revokeValidatedSession(validated!)).toBe(true);
      expect(harness.service.resolveAndRefresh(rotated!.rotatedSessionToken!)).toBeNull();
      expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(
        new Date(initialTime.getTime() + 6 * 60 * 1_000),
      );
    } finally {
      database.close();
    }
  });

  it("rejects invalid clock and duration seams before they can weaken session policy", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      expect(
        () =>
          new SessionService(database, {
            encryptionKey: Buffer.alloc(32, 9),
            session: sessionConfig({ inactivityTtlMs: 0 }),
          }),
      ).toThrow(/positive integer duration/i);

      const service = new SessionService(
        database,
        { encryptionKey: Buffer.alloc(32, 9), session: sessionConfig() },
        { clock: () => new Date(Number.NaN) },
      );
      expect(() => service.createSession({ attribution: { authMethod: "recovery" } })).toThrow(
        /valid clock value/i,
      );
    } finally {
      database.close();
    }
  });
});
