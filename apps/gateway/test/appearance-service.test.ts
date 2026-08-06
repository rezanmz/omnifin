import {
  PENDING_LINK_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
import { AppearanceError, AppearanceService } from "../src/auth/appearance-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";

const baseTime = Date.parse("2026-07-26T10:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 12),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 60 * 60 * 1_000,
      inactivityTtlMs: 10 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function principal(userId: string): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-07-26T12:00:00.000Z",
    accountState: "pending_link",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Riley",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-26T11:00:00.000Z",
    issuedAt: "2026-07-26T10:00:00.000Z",
    linkedServices: [],
    permissions: PENDING_LINK_PERMISSIONS,
    role: "viewer",
    sessionId: "session-viewer",
    userId,
  });
}

function insertUser(database: DatabaseHandle) {
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values ('viewer-1', 'Riley', 'viewer', 'manual', 'active', ?, ?)`,
    )
    .run(baseTime, baseTime);
}

function createHarness() {
  const config = testConfig();
  const database = openDatabase(config.databaseUrl);
  database.migrate();
  insertUser(database);
  const service = new AppearanceService(database);
  return { database, service };
}

describe("appearance service", () => {
  it("reads and updates the stored theme preference", () => {
    const { service } = createHarness();
    expect(service.read({ principal: principal("viewer-1") })).toEqual({
      theme: "system",
    });
    expect(service.update({ principal: principal("viewer-1") }, { theme: "dark" })).toEqual({
      theme: "dark",
    });
    expect(service.read({ principal: principal("viewer-1") })).toEqual({ theme: "dark" });
  });

  it("reports a missing account when the user row is gone", () => {
    const { database, service } = createHarness();
    database.sqlite.prepare("delete from users where id = 'viewer-1'").run();
    expect(() => service.read({ principal: principal("viewer-1") })).toThrow(
      expect.objectContaining<Partial<AppearanceError>>({ reason: "not_found" }),
    );
    expect(() => service.update({ principal: principal("viewer-1") }, { theme: "dark" })).toThrow(
      expect.objectContaining<Partial<AppearanceError>>({ reason: "not_found" }),
    );
  });

  it("carries the unavailable reason and an underlying cause", () => {
    const cause = new Error("stored value rejected");
    const error = new AppearanceError("unavailable", { cause });
    expect(error).toMatchObject({ code: "appearance_unavailable", reason: "unavailable" });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("The appearance preference is temporarily unavailable.");

    const missing = new AppearanceError("not_found");
    expect(missing).toMatchObject({ code: "appearance_unavailable", reason: "not_found" });
    expect(missing.cause).toBeUndefined();
    expect(missing.message).toBe("This account is no longer available.");
  });
});
