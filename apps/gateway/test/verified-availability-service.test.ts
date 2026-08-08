import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { DiscoveryAvailability } from "@omnifin/contracts/discovery";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { DatabaseHandle } from "../src/db/client.js";
import {
  reconcileVerifiedAvailability,
  unavailableOwnershipEvidence,
  VerifiedAvailabilityService,
  type VerifiedOwnershipEvidence,
} from "../src/media/verified-availability-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-08-08T12:00:00.000Z");

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 91),
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

function principal(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-09-08T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-08T13:00:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Viewer",
        externalUserId: "jellyfin-user-1",
        health: "linked",
        id: "viewer-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
        service: "jellyfin",
        username: "viewer",
      },
    ],
    permissions: ROLE_PERMISSIONS.viewer,
    role: "viewer",
    sessionId: "viewer-session",
    userId: "viewer-user",
  });
}

function currentEvidence(
  state: "not_owned" | "owned",
): Extract<VerifiedOwnershipEvidence, { state: "not_owned" | "owned" }> {
  return {
    connectorRevision: now.getTime(),
    linkId: "viewer-link",
    linkRevision: 4,
    state,
    userId: "viewer-user",
    userRevision: now.getTime(),
  };
}

function serviceHarness(
  options: { mutateRevision?: boolean; owned?: boolean; unavailable?: boolean } = {},
) {
  const appConfig = config();
  const cipher = new EnvelopeCipher(appConfig.encryptionKey);
  let currentLinkRevision = 4;
  const source = {
    baseUrl: "https://jellyfin.example.test/",
    connectorDisplayName: "Jellyfin",
    connectorEnabled: 1,
    connectorId: "jellyfin-main",
    connectorRevision: now.getTime(),
    connectorType: "jellyfin",
    deviceId: "viewer-device",
    encryptedAccessToken: cipher.encrypt(
      "private-access-token",
      "service_identity_access_token:jellyfin:viewer-link",
    ),
    encryptedCredentials: cipher.encrypt(
      JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
      "connector_credentials:jellyfin:jellyfin-main",
    ),
    externalUserId: "jellyfin-user-1",
    insecureHttpApproved: 0,
    linkHealthState: "linked",
    linkId: "viewer-link",
    linkRevision: 4,
    linkService: "jellyfin",
    linkUserId: "viewer-user",
    tlsPolicy: "strict",
    userRevision: now.getTime(),
    userStatus: "active",
  };
  const database = {
    sqlite: {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() =>
          sql.includes("l.service as linkService")
            ? source
            : {
                connectorEnabled: 1,
                connectorId: source.connectorId,
                connectorRevision: source.connectorRevision,
                externalUserId: source.externalUserId,
                linkHealthState: "linked",
                linkRevision: currentLinkRevision,
                userRevision: source.userRevision,
                userStatus: "active",
              },
        ),
      })),
    },
  } as unknown as DatabaseHandle;
  const readExactOwnership = vi.fn(async () => {
    if (options.unavailable) throw new Error("private connector failure");
    if (options.mutateRevision) currentLinkRevision += 1;
    return options.owned ? { itemId: "owned-item", owned: true } : { itemId: null, owned: false };
  });
  const service = new VerifiedAvailabilityService(database, appConfig, {
    createClient: vi.fn(() => ({ readExactOwnership })),
  });
  return { readExactOwnership, service };
}

describe("verified availability", () => {
  it.each([
    ["available", "owned", "available"],
    ["unavailable", "owned", "available"],
    ["available", "not_owned", "unknown"],
    ["partial", "not_owned", "partial"],
    ["requested", "not_owned", "requested"],
    ["processing", "not_owned", "processing"],
    ["requested", "stale", "requested"],
    ["processing", "unavailable", "processing"],
    ["unavailable", "stale", "unknown"],
    ["available", "unavailable", "unknown"],
  ] as const)("reconciles Seerr %s with %s ownership as %s", (seerr, state, expected) => {
    let evidence: VerifiedOwnershipEvidence;
    if (state === "owned" || state === "not_owned") evidence = currentEvidence(state);
    else if (state === "stale") evidence = { ...currentEvidence("owned"), state };
    else evidence = unavailableOwnershipEvidence("viewer-user");
    expect(reconcileVerifiedAvailability(seerr as DiscoveryAvailability, evidence)).toBe(expected);
  });

  it("returns current user/link-scoped exact ownership evidence", async () => {
    const { readExactOwnership, service } = serviceHarness({ owned: true });

    await expect(
      service.verifyOwnership({ kind: "movie", tmdbId: 550 }, principal()),
    ).resolves.toMatchObject({
      connectorRevision: now.getTime(),
      linkId: "viewer-link",
      linkRevision: 4,
      state: "owned",
      userId: "viewer-user",
      userRevision: now.getTime(),
    });
    expect(readExactOwnership).toHaveBeenCalledWith(
      { kind: "movie", tmdbId: 550, userId: "jellyfin-user-1" },
      undefined,
    );
  });

  it("marks evidence stale when the user link revision changes during lookup", async () => {
    const { service } = serviceHarness({ mutateRevision: true });

    await expect(
      service.verifyOwnership({ kind: "series", tmdbId: 1399 }, principal()),
    ).resolves.toMatchObject({ linkRevision: 4, state: "stale", userId: "viewer-user" });
  });

  it("returns unavailable evidence when exact ownership cannot be verified", async () => {
    const { service } = serviceHarness({ unavailable: true });

    await expect(
      service.verifyOwnership({ kind: "movie", tmdbId: 550 }, principal()),
    ).resolves.toEqual(unavailableOwnershipEvidence("viewer-user"));
  });
});
