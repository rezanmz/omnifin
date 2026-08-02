import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";

import { AuditTrailService, type AuditTrailError } from "../src/audit/audit-trail-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const now = new Date("2026-08-02T12:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 104),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
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

function principal(
  role: "admin" | "viewer" = "admin",
  authenticationMethod: "jellyfin" | "recovery" = "jellyfin",
): SessionPrincipal {
  const recovery = authenticationMethod === "recovery";
  return {
    absoluteExpiresAt: "2026-08-03T12:00:00.000Z",
    accountState: recovery ? "recovery" : "active",
    authenticationMethod: { kind: authenticationMethod },
    displayName: recovery ? "Recovery access" : role === "admin" ? "Administrator" : "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-02T13:00:00.000Z",
    issuedAt: "2026-08-02T11:00:00.000Z",
    linkedServices: [],
    permissions: recovery ? [...RECOVERY_PERMISSIONS] : [...ROLE_PERMISSIONS[role]],
    role: recovery ? "admin" : role,
    sessionId: recovery ? "recovery-session" : `${role}-session`,
    userId: recovery ? null : `${role}-user`,
  };
}

function insertUser(database: DatabaseHandle, id: string, displayName: string) {
  database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName,
      id,
      role: "admin",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
}

function insertAudit(
  database: DatabaseHandle,
  input: {
    actorAuthMethod?: "jellyfin" | "oidc" | "recovery";
    actorUserId?: string;
    createdAt?: number;
    eventType: string;
    id: string;
    outcome?: "success" | "denied" | "failure";
  },
) {
  database.sqlite
    .prepare(
      `insert into audit_events (
        id, actor_user_id, actor_session_id, actor_auth_method, event_type, outcome,
        target_type, target_id, request_id, metadata_json, ip_hash, created_at
      ) values (?, ?, ?, ?, ?, ?, 'private_target', 'upstream-private-id',
                'request-private-id', ?, 'private-ip-hash', ?)`,
    )
    .run(
      input.id,
      input.actorUserId ?? null,
      input.actorAuthMethod ? `${input.id}-private-session` : null,
      input.actorAuthMethod ?? null,
      input.eventType,
      input.outcome ?? "success",
      JSON.stringify({ connectorUrl: "https://private.example", mediaPath: "/srv/media" }),
      input.createdAt ?? now.getTime(),
    );
}

function harness() {
  const config = testConfig();
  const database = openDatabase(config.databaseUrl);
  database.migrate();
  insertUser(database, "admin-user", "Administrator");
  const service = new AuditTrailService(database, config, { clock: () => new Date(now) });
  return { database, service };
}

describe("audit trail service", () => {
  it("presents normalized actors and excludes every private audit field", () => {
    const { database, service } = harness();
    try {
      insertAudit(database, {
        actorAuthMethod: "oidc",
        actorUserId: "admin-user",
        eventType: "auth.user.access_updated",
        id: "audit-raw-user-event",
      });
      insertAudit(database, {
        actorAuthMethod: "recovery",
        eventType: "auth.admin.bootstrap_attempt",
        id: "audit-raw-recovery-event",
      });
      insertAudit(database, {
        actorAuthMethod: "jellyfin",
        eventType: "library.scan.requested",
        id: "audit-raw-removed-event",
      });
      insertAudit(database, {
        eventType: "connector.configuration.bootstrapped",
        id: "audit-raw-system-event",
      });

      const page = service.list({}, principal());

      expect(page.events).toHaveLength(4);
      expect(
        page.events.find((event) => event.eventType === "auth.user.access_updated"),
      ).toMatchObject({
        actor: { authenticationMethod: "oidc", displayName: "Administrator", kind: "user" },
        category: "access",
      });
      expect(
        page.events.find((event) => event.eventType === "auth.admin.bootstrap_attempt"),
      ).toMatchObject({
        actor: {
          authenticationMethod: "recovery",
          displayName: "Recovery access",
          kind: "recovery",
        },
      });
      expect(
        page.events.find((event) => event.eventType === "library.scan.requested"),
      ).toMatchObject({
        actor: {
          authenticationMethod: "jellyfin",
          displayName: "Former account",
          kind: "removed_user",
        },
        category: "library",
      });
      expect(page.events.find((event) => event.eventType.startsWith("connector."))).toMatchObject({
        actor: { authenticationMethod: null, displayName: "Omnifin", kind: "system" },
        category: "configuration",
      });
      const serialized = JSON.stringify(page);
      for (const privateValue of [
        "audit-raw-",
        "private_target",
        "upstream-private-id",
        "request-private-id",
        "private-ip-hash",
        "private.example",
        "/srv/media",
        "private-session",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    } finally {
      database.close();
    }
  });

  it("uses encrypted snapshot-stable pagination bound to the active filters", () => {
    const { database, service } = harness();
    try {
      for (let index = 0; index < 31; index += 1) {
        insertAudit(database, {
          createdAt: now.getTime() - index,
          eventType: index % 2 === 0 ? "auth.session.logout" : "connector.probed",
          id: `audit-page-${String(index).padStart(2, "0")}`,
          outcome: index % 3 === 0 ? "failure" : "success",
        });
      }
      const first = service.list({ limit: 10 }, principal());
      expect(first.events).toHaveLength(10);
      expect(first.nextCursor).toMatch(/^audit_cursor_v2\./u);
      expect(
        Buffer.from(first.nextCursor!.split(".")[2]!, "base64url").toString("utf8"),
      ).not.toContain("audit-page");

      insertAudit(database, {
        createdAt: now.getTime() + 10_000,
        eventType: "auth.session.created",
        id: "audit-arrived-after-snapshot",
      });
      const second = service.list({ cursor: first.nextCursor!, limit: 10 }, principal());
      expect(second.events).toHaveLength(10);
      expect(second.generatedAt).toBe(first.generatedAt);
      expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(20);
      expect(JSON.stringify(second)).not.toContain("arrived-after-snapshot");
      expect(() =>
        service.list({ cursor: first.nextCursor!, limit: 10, outcome: "failure" }, principal()),
      ).toThrow(expect.objectContaining<Partial<AuditTrailError>>({ reason: "cursor_invalid" }));
    } finally {
      database.close();
    }
  });

  it("enforces category and outcome filters before pagination", () => {
    const { database, service } = harness();
    try {
      insertAudit(database, {
        eventType: "auth.session.csrf_denied",
        id: "audit-auth-denied",
        outcome: "denied",
      });
      insertAudit(database, {
        eventType: "download.queue.removal.completed",
        id: "audit-download-success",
      });
      expect(
        service.list({ category: "authentication", outcome: "denied" }, principal()).events,
      ).toHaveLength(1);
      expect(service.list({ category: "downloads" }, principal()).events[0]).toMatchObject({
        category: "downloads",
        outcome: "success",
      });
    } finally {
      database.close();
    }
  });

  it("denies ordinary and recovery principals in the service layer", () => {
    const { database, service } = harness();
    try {
      for (const denied of [principal("viewer"), principal("admin", "recovery")]) {
        expect(() => service.list({}, denied)).toThrow(
          expect.objectContaining<Partial<AuditTrailError>>({ reason: "permission_denied" }),
        );
      }
    } finally {
      database.close();
    }
  });
});
