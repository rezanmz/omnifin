import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  SavedListService,
  SavedListServiceError,
  type SavedListContext,
} from "../src/saved/list-service.js";

const startedAt = new Date("2026-08-04T08:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 147),
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

function principal(userId = "saved-user"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-09-03T08:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "oidc", providerId: "provider-main" },
    displayName: userId === "saved-user" ? "Saved User" : "Other User",
    externalIdentity: {
      displayClaims: { displayName: "Saved User", preferredUsername: "saved" },
      issuer: "https://id.example/application/o/omnifin/",
      providerId: "provider-main",
      subject: `${userId}-subject`,
    },
    inactivityExpiresAt: "2026-08-04T09:00:00.000Z",
    issuedAt: startedAt.toISOString(),
    linkedServices: [
      {
        displayName: "Saved User",
        externalUserId: `${userId}-jellyfin`,
        health: "linked",
        id: `${userId}-link`,
        lastVerifiedAt: startedAt.toISOString(),
        linkedAt: startedAt.toISOString(),
        service: "jellyfin",
        username: "saved",
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: `${userId}-session`,
    userId,
  });
}

function seedUser(database: DatabaseHandle, userId: string) {
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values (?, ?, 'viewer', 'manual', 'active', ?, ?)`,
    )
    .run(userId, userId, startedAt.getTime(), startedAt.getTime());
}

const databases: DatabaseHandle[] = [];

function harness() {
  const appConfig = config();
  const database = openDatabase(":memory:");
  databases.push(database);
  database.migrate();
  seedUser(database, "saved-user");
  seedUser(database, "other-user");
  let now = startedAt.getTime();
  let listToken = 0;
  let operationToken = 0;
  let auditToken = 0;
  const service = new SavedListService(database, appConfig, {
    clock: () => new Date(now),
    createAuditId: () => `saved-audit-${++auditToken}`,
    createListToken: () => (++listToken).toString(36).padStart(22, "a"),
    createOperationToken: () => (++operationToken).toString(36).padStart(22, "b"),
  });
  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    context(userId = "saved-user"): SavedListContext {
      return {
        ipAddress: "203.0.113.83",
        principal: principal(userId),
        requestId: `request-${userId}`,
      };
    },
    database,
    service,
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SavedListService", () => {
  it("provisions one encrypted Watch Later list per user", () => {
    const { context, database, service } = harness();

    const first = service.list({}, context());
    const second = service.list({}, context());

    expect(first.watchLater).toMatchObject({
      capabilities: { delete: false, rename: false, reorder: true },
      itemCount: 0,
      kind: "watch_later",
      name: "Watch Later",
      revision: 0,
    });
    expect(second.watchLater.id).toBe(first.watchLater.id);
    expect(second.lists).toEqual([]);
    const stored = database.sqlite
      .prepare(
        "select encrypted_name as encryptedName from saved_lists where user_id = ? and kind = 'watch_later'",
      )
      .get("saved-user") as { encryptedName: string };
    expect(stored.encryptedName).not.toContain("Watch Later");
    expect(
      database.sqlite
        .prepare("select count(*) as count from saved_lists where user_id = ?")
        .get("saved-user"),
    ).toEqual({ count: 1 });
  });

  it("creates private encrypted custom lists with replay-safe idempotency", () => {
    const { context, database, service } = harness();
    const input = { description: "Films for a rainy weekend", name: "Rainy night" };

    const created = service.create(input, "create-list-0001", context());
    const replayed = service.create(input, "create-list-0001", context());

    expect(created.replayed).toBe(false);
    expect(replayed).toEqual({ ...created, replayed: true });
    expect(created.body.list).toMatchObject({
      capabilities: { delete: true, rename: true, reorder: true },
      description: input.description,
      kind: "custom",
      name: input.name,
      revision: 0,
    });
    expect(created.etag).toMatch(/^"saved_[A-Za-z0-9_-]{22}"$/u);
    const stored = database.sqlite
      .prepare(
        `select encrypted_name as encryptedName, encrypted_description as encryptedDescription
         from saved_lists where id = ?`,
      )
      .get(created.body.list.id) as { encryptedDescription: string; encryptedName: string };
    expect(stored.encryptedName).not.toContain(input.name);
    expect(stored.encryptedDescription).not.toContain(input.description);
    expect(
      database.sqlite.prepare("select count(*) as count from saved_list_operations").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      service.create({ ...input, name: "A different list" }, "create-list-0001", context()),
    ).toThrowError(expect.objectContaining({ reason: "idempotency_conflict" }));
  });

  it("paginates custom lists without crossing the user boundary", () => {
    const { context, service } = harness();
    const first = service.create(
      { description: null, name: "First" },
      "create-list-first",
      context(),
    );
    const second = service.create(
      { description: null, name: "Second" },
      "create-list-second",
      context(),
    );
    service.create(
      { description: null, name: "Private other" },
      "create-list-other",
      context("other-user"),
    );

    const pageOne = service.list({ limit: 1 }, context());
    const pageTwo = service.list({ cursor: pageOne.nextCursor, limit: 1 }, context());

    expect(pageOne.lists).toHaveLength(1);
    expect(pageTwo.lists).toHaveLength(1);
    expect(new Set([...pageOne.lists, ...pageTwo.lists].map(({ id }) => id))).toEqual(
      new Set([first.body.list.id, second.body.list.id]),
    );
    expect(pageTwo.nextCursor).toBeNull();
    expect(() =>
      service.list({ cursor: pageOne.nextCursor, limit: 1 }, context("other-user")),
    ).toThrowError(expect.objectContaining({ reason: "cursor_invalid" }));
    expect(() => service.read(first.body.list.id, context("other-user"))).toThrowError(
      expect.objectContaining({ reason: "list_not_found" }),
    );
  });

  it("requires the exact strong ETag for custom-list edits", () => {
    const { context, service } = harness();
    const created = service.create(
      { description: null, name: "Original" },
      "create-list-edit",
      context(),
    );

    expect(() =>
      service.update(created.body.list.id, { name: "Stale edit" }, '"saved_stale"', context()),
    ).toThrowError(
      expect.objectContaining({ currentEtag: created.etag, reason: "revision_stale" }),
    );
    const updated = service.update(
      created.body.list.id,
      { description: "Updated description", name: "Updated" },
      created.etag,
      context(),
    );
    expect(updated.body.list).toMatchObject({
      description: "Updated description",
      name: "Updated",
      revision: 1,
    });
    expect(updated.etag).not.toBe(created.etag);
    const watchLater = service.list({}, context()).watchLater;
    expect(() =>
      service.update(
        watchLater.id,
        { name: "Do not rename" },
        service.read(watchLater.id, context()).etag,
        context(),
      ),
    ).toThrowError(expect.objectContaining({ reason: "list_immutable" }));
  });

  it("soft-deletes and restores a custom list only inside its undo window", () => {
    const { advance, context, service } = harness();
    const created = service.create(
      { description: null, name: "Temporary" },
      "create-list-delete",
      context(),
    );
    const deleted = service.delete(created.body.list.id, created.etag, context());

    expect(deleted.body).toMatchObject({ listId: created.body.list.id, revision: 1 });
    expect(() => service.read(created.body.list.id, context())).toThrowError(
      expect.objectContaining({ reason: "list_not_found" }),
    );
    const restored = service.restore(
      created.body.list.id,
      {},
      "restore-list-0001",
      deleted.etag,
      context(),
    );
    expect(restored.body.list).toMatchObject({ name: "Temporary", revision: 2 });
    expect(
      service.restore(created.body.list.id, {}, "restore-list-0001", deleted.etag, context()),
    ).toEqual({ ...restored, replayed: true });

    const deletedAgain = service.delete(restored.body.list.id, restored.etag, context());
    advance(30_001);
    expect(() =>
      service.restore(
        restored.body.list.id,
        {},
        "restore-list-expired",
        deletedAgain.etag,
        context(),
      ),
    ).toThrowError(expect.objectContaining({ reason: "undo_expired" }));
  });

  it("rejects principals without an active private-list permission", () => {
    const { context, service } = harness();
    const recovery = {
      ...context().principal,
      authenticationMethod: { kind: "recovery" as const },
      permissions: ["recovery.sessions.revoke" as const],
      role: "admin" as const,
      userId: null,
    };

    expect(() => service.list({}, { principal: recovery })).toThrowError();
    expect(() =>
      service.list({}, { principal: { ...context().principal, accountState: "pending_link" } }),
    ).toThrowError(SavedListServiceError);
  });

  it("enforces the custom-list quota without consuming a failed idempotency key", () => {
    const { context, database, service } = harness();
    for (let index = 0; index < 50; index += 1) {
      service.create(
        { description: null, name: `Private list ${index + 1}` },
        `saved-quota-key-${String(index).padStart(4, "0")}`,
        context(),
      );
    }

    expect(() =>
      service.create(
        { description: null, name: "One too many" },
        "saved-quota-overflow",
        context(),
      ),
    ).toThrowError(expect.objectContaining({ reason: "list_quota_reached" }));
    expect(
      database.sqlite
        .prepare("select count(*) as count from saved_list_operations where state = 'pending'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed for invalid clocks, identifiers, and exhausted revisions", () => {
    const { context, database, service } = harness();
    const created = service.create(
      { description: null, name: "Revision boundary" },
      "saved-revision-boundary",
      context(),
    );
    database.sqlite
      .prepare("update saved_lists set revision = 2147483647 where id = ?")
      .run(created.body.list.id);
    const boundary = service.read(created.body.list.id, context());
    expect(() =>
      service.update(created.body.list.id, { name: "Overflow" }, boundary.etag, context()),
    ).toThrowError(expect.objectContaining({ reason: "integrity_failure" }));
    expect(() => service.read("saved_list_invalid", context())).toThrowError(
      expect.objectContaining({ reason: "list_not_found" }),
    );

    const invalidIdentifier = new SavedListService(database, config(), {
      clock: () => startedAt,
      createListToken: () => "invalid",
    });
    database.sqlite.prepare("delete from saved_lists").run();
    expect(() => invalidIdentifier.list({}, context())).toThrowError(
      expect.objectContaining({ reason: "integrity_failure" }),
    );

    const invalidClock = new SavedListService(database, config(), {
      clock: () => new Date(Number.NaN),
    });
    expect(() => invalidClock.list({}, context())).toThrowError(
      expect.objectContaining({ reason: "integrity_failure" }),
    );
  });
});
