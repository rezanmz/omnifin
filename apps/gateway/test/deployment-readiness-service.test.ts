import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type Role,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { deploymentReadinessResponseSchema } from "@omnifin/contracts/deployment";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/client.js";
import type { AppConfig } from "../src/config.js";
import {
  DeploymentReadinessService,
  type DeploymentReadinessError,
} from "../src/setup/deployment-readiness-service.js";
import { SafeHttpError } from "../src/http-error.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function principal(role: Role = "admin") {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-31T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Stack administrator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-01T13:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Stack administrator",
        externalUserId: "private-jellyfin-user",
        health: "linked",
        id: "private-jellyfin-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "administrator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-deployment-session`,
    userId: `${role}-deployment-user`,
  });
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: "/data/omnifin.db",
    encryptionKey: Buffer.alloc(32, 101),
    environment: "production",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    recoverySecretDigest: Buffer.alloc(32, 102),
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 1,
    ...overrides,
  };
}

function harness(appConfig: AppConfig = config(), clock: () => Date = () => now) {
  const database = openDatabase(":memory:");
  database.migrate();
  return {
    database,
    service: new DeploymentReadinessService(database, appConfig, { clock }),
  };
}

describe("DeploymentReadinessService", () => {
  it("returns only normalized status for a hardened production deployment", () => {
    const fixture = harness();
    try {
      const result = fixture.service.read({ principal: principal() });

      expect(deploymentReadinessResponseSchema.parse(result)).toEqual(result);
      expect(result).toEqual({
        checks: [
          { id: "runtime", state: "ready" },
          { id: "transport", state: "ready" },
          { id: "recovery", state: "ready" },
          { id: "storage", state: "ready" },
        ],
        generatedAt: now.toISOString(),
        readyCount: 4,
        state: "ready",
        total: 4,
      });
      expect(JSON.stringify(result)).not.toMatch(/omnifin\.example|\/data|secret|production/u);
    } finally {
      fixture.database.close();
    }
  });

  it("reports a detail-free attention posture for a disposable loopback preview", () => {
    const previewConfig = config({
      baseUrl: new URL("http://127.0.0.1:3000"),
      databaseUrl: ":memory:",
      environment: "development",
      insecureLoopbackPreview: true,
      secureCookies: false,
    });
    delete previewConfig.recoverySecretDigest;
    const fixture = harness(previewConfig);
    try {
      expect(fixture.service.read({ principal: principal() })).toMatchObject({
        checks: [
          { id: "runtime", state: "attention" },
          { id: "transport", state: "attention" },
          { id: "recovery", state: "attention" },
          { id: "storage", state: "attention" },
        ],
        readyCount: 0,
        state: "attention",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("requires full administrator authority before inspecting deployment state", () => {
    const fixture = harness();
    try {
      expect(() =>
        fixture.service.read({ principal: principal("operator") as SessionPrincipal }),
      ).toThrowError(SafeHttpError);
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed on invalid clocks and unavailable storage", () => {
    const invalidClock = harness(config(), () => new Date(Number.NaN));
    try {
      expect(() => invalidClock.service.read({ principal: principal() })).toThrowError(
        expect.objectContaining<Partial<DeploymentReadinessError>>({
          reason: "integrity_failure",
        }),
      );
    } finally {
      invalidClock.database.close();
    }

    const unavailable = harness();
    unavailable.database.close();
    expect(() => unavailable.service.read({ principal: principal() })).toThrowError(
      expect.objectContaining<Partial<DeploymentReadinessError>>({ reason: "storage_failure" }),
    );
  });
});
