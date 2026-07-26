import { authProvidersResponseSchema } from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  OIDC_PROVIDER_PRESENTATION_PAGE_SIZE,
  OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT,
} from "../src/auth/provider-routes.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { oidcProviders } from "../src/db/schema.js";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const checkedAt = new Date("2026-01-02T00:00:00.000Z");
const runtimeSecuritySeal = Buffer.alloc(32, 71).toString("base64url");

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 4),
    environment: "test",
    host: "127.0.0.1",
    jellyfinInsecureHttpApproved: false,
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
    ...overrides,
  };
}

interface LogoutCapabilities {
  backChannel: boolean;
  backChannelSession: boolean;
  frontChannel: boolean;
  frontChannelSession: boolean;
  rpInitiated: boolean;
}

const noLogout: LogoutCapabilities = {
  backChannel: false,
  backChannelSession: false,
  frontChannel: false,
  frontChannelSession: false,
  rpInitiated: false,
};

function discoverySnapshotObject(
  logout: LogoutCapabilities,
  overrides: Record<string, unknown> = {},
) {
  return {
    capabilities: {
      authorizationCodeFlow: true,
      idTokenSigningAlg: "RS256",
      logout,
      pkceS256: true,
      schemaVersion: 1,
      tokenEndpointAuthMethod: "none",
      userInfo: false,
    },
    runtimeSecuritySeal,
    schemaVersion: 1,
    ...overrides,
  };
}

function discoverySnapshot(logout: LogoutCapabilities, overrides: Record<string, unknown> = {}) {
  return JSON.stringify(discoverySnapshotObject(logout, overrides));
}

type ProviderInsert = typeof oidcProviders.$inferInsert;

function seedProvider(
  database: DatabaseHandle,
  id: string,
  overrides: Partial<ProviderInsert> = {},
) {
  database.db
    .insert(oidcProviders)
    .values({
      clientId: `client-${id}`,
      createdAt,
      displayName: id,
      id,
      issuer: `https://${id}.example.test/`,
      slug: id,
      updatedAt: createdAt,
      ...overrides,
    })
    .run();
}

function seedReadyProvider(
  database: DatabaseHandle,
  input: {
    displayName: string;
    id: string;
    logout: LogoutCapabilities;
  },
) {
  seedProvider(database, input.id, {
    approvedEndpointOriginsJson: JSON.stringify([`https://${input.id}.example.test`]),
    discoveryCapabilitiesJson: discoverySnapshot(input.logout),
    discoveryCheckedAt: checkedAt,
    discoveryState: "ready",
    displayName: input.displayName,
  });
}

describe("GET /v1/auth/providers", () => {
  it.each([
    {
      expected: {
        supportsBackChannelLogout: false,
        supportsFrontChannelLogout: false,
        supportsRpInitiatedLogout: false,
      },
      logout: {
        backChannel: false,
        backChannelSession: false,
        frontChannel: false,
        frontChannelSession: false,
        rpInitiated: false,
      },
      name: "no logout support",
    },
    {
      expected: {
        supportsBackChannelLogout: true,
        supportsFrontChannelLogout: true,
        supportsRpInitiatedLogout: true,
      },
      logout: {
        backChannel: true,
        backChannelSession: false,
        frontChannel: true,
        frontChannelSession: false,
        rpInitiated: true,
      },
      name: "provider and RP logout support",
    },
    {
      expected: {
        supportsBackChannelLogout: true,
        supportsFrontChannelLogout: true,
        supportsRpInitiatedLogout: false,
      },
      logout: {
        backChannel: true,
        backChannelSession: true,
        frontChannel: true,
        frontChannelSession: true,
        rpInitiated: false,
      },
      name: "session-aware logout support",
    },
  ])("presents a ready provider with exact $name flags", async ({ expected, logout }) => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedReadyProvider(database, {
        displayName: "Home identity",
        id: "oidc-home",
        logout,
      });

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json())).toEqual({
        providers: [
          {
            displayName: "Home identity",
            id: "oidc-home",
            issuer: "https://oidc-home.example.test/",
            jitProvisioningEnabled: true,
            kind: "oidc",
            state: "unavailable",
            ...expected,
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      expectedState: "unavailable",
      name: "unchecked",
      overrides: {
        allowJitProvisioning: false,
        discoveryCapabilitiesJson: "{}",
        discoveryCheckedAt: null,
        discoveryState: "unchecked" as const,
      },
    },
    {
      expectedState: "unavailable",
      name: "failed",
      overrides: {
        discoveryCapabilitiesJson: "{}",
        discoveryCheckedAt: checkedAt,
        discoveryState: "failed" as const,
      },
    },
  ])("maps an enabled $name provider without rediscovery", async ({ expectedState, overrides }) => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedProvider(database, "oidc-state", {
        displayName: "State identity",
        ...overrides,
      });

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json()).providers).toEqual([
        expect.objectContaining({
          displayName: "State identity",
          id: "oidc-state",
          state: expectedState,
          supportsBackChannelLogout: false,
          supportsFrontChannelLogout: false,
          supportsRpInitiatedLogout: false,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("does not advertise OIDC as actionable before the sign-in route exists", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedReadyProvider(database, {
        displayName: "Home identity",
        id: "oidc-home",
        logout: { ...noLogout, rpInitiated: true },
      });

      const providers = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const start = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/oidc-home/start",
      });

      expect(authProvidersResponseSchema.parse(providers.json()).providers).toEqual([
        expect.objectContaining({
          id: "oidc-home",
          state: "unavailable",
          supportsRpInitiatedLogout: true,
        }),
      ]);
      expect(start.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: "invalid JSON",
      snapshot: () => "{not-json",
    },
    {
      name: "an extra top-level key",
      snapshot: () =>
        JSON.stringify({ ...discoverySnapshotObject(noLogout), unexpectedSecret: "do-not-leak" }),
    },
    {
      name: "an extra capability key",
      snapshot: () => {
        const snapshot = discoverySnapshotObject(noLogout);
        return JSON.stringify({
          ...snapshot,
          capabilities: { ...snapshot.capabilities, unexpected: true },
        });
      },
    },
    {
      name: "an extra logout key",
      snapshot: () => {
        const snapshot = discoverySnapshotObject(noLogout);
        return JSON.stringify({
          ...snapshot,
          capabilities: {
            ...snapshot.capabilities,
            logout: { ...snapshot.capabilities.logout, unexpected: true },
          },
        });
      },
    },
    {
      name: "front-channel session support without front-channel logout",
      snapshot: () => discoverySnapshot({ ...noLogout, frontChannelSession: true }),
    },
    {
      name: "back-channel session support without back-channel logout",
      snapshot: () => discoverySnapshot({ ...noLogout, backChannelSession: true }),
    },
    {
      name: "a non-canonical runtime seal",
      snapshot: () => discoverySnapshot(noLogout, { runtimeSecuritySeal: "not-a-seal" }),
    },
    {
      name: "a capability that disagrees with persisted configuration",
      snapshot: () => {
        const snapshot = discoverySnapshotObject(noLogout);
        return JSON.stringify({
          ...snapshot,
          capabilities: {
            ...snapshot.capabilities,
            tokenEndpointAuthMethod: "client_secret_basic",
          },
        });
      },
    },
  ])("fails closed for a ready snapshot with $name", async ({ snapshot }) => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedReadyProvider(database, {
        displayName: "A valid identity",
        id: "oidc-valid",
        logout: noLogout,
      });
      seedReadyProvider(database, {
        displayName: "B malformed identity",
        id: "oidc-malformed",
        logout: noLogout,
      });
      database.sqlite.pragma("ignore_check_constraints = ON");
      database.sqlite
        .prepare(
          `update oidc_providers
           set discovery_capabilities_json = ?
           where id = 'oidc-malformed'`,
        )
        .run(snapshot());
      database.sqlite.pragma("ignore_check_constraints = OFF");

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const providers = authProvidersResponseSchema.parse(response.json()).providers;

      expect(response.statusCode).toBe(200);
      expect(providers).toHaveLength(2);
      expect(providers[0]).toMatchObject({ id: "oidc-valid", state: "unavailable" });
      expect(providers[1]).toEqual({
        displayName: "B malformed identity",
        id: "oidc-malformed",
        issuer: "https://oidc-malformed.example.test/",
        jitProvisioningEnabled: true,
        kind: "oidc",
        state: "misconfigured",
        supportsBackChannelLogout: false,
        supportsFrontChannelLogout: false,
        supportsRpInitiatedLogout: false,
      });
      expect(response.body).not.toContain("do-not-leak");
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      checkedAt: null,
      name: "ready state without a discovery timestamp",
      snapshot: discoverySnapshot(noLogout),
      state: "ready",
    },
    {
      checkedAt: createdAt.getTime() - 1,
      name: "ready state checked before provider creation",
      snapshot: discoverySnapshot(noLogout),
      state: "ready",
    },
    {
      checkedAt: checkedAt.getTime(),
      name: "unchecked state with stale discovered capabilities",
      snapshot: discoverySnapshot(noLogout),
      state: "unchecked",
    },
    {
      checkedAt: null,
      name: "an unknown persisted discovery state",
      snapshot: "{}",
      state: "corrupt",
    },
  ])("marks $name as misconfigured", async ({ checkedAt: rawCheckedAt, snapshot, state }) => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedProvider(database, "oidc-inconsistent", { displayName: "Inconsistent identity" });
      database.sqlite.pragma("ignore_check_constraints = ON");
      database.sqlite
        .prepare(
          `update oidc_providers
           set discovery_capabilities_json = ?,
               discovery_checked_at = ?,
               discovery_state = ?
           where id = 'oidc-inconsistent'`,
        )
        .run(snapshot, rawCheckedAt, state);
      database.sqlite.pragma("ignore_check_constraints = OFF");

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json()).providers).toEqual([
        expect.objectContaining({ id: "oidc-inconsistent", state: "misconfigured" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("omits a malformed public identity without hiding valid providers", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedProvider(database, "oidc-valid", { displayName: "A valid identity" });
      seedProvider(database, "invalid id", {
        displayName: "B invalid identity",
        issuer: "https://invalid-id.example.test/",
      });
      seedProvider(database, " oidc-spaced ", {
        displayName: "C normalized identity",
        issuer: "https://oidc-spaced.example.test/",
      });

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json()).providers).toEqual([
        expect.objectContaining({ id: "oidc-valid", state: "unavailable" }),
      ]);
      expect(response.body).not.toContain("B invalid identity");
      expect(response.body).not.toContain("C normalized identity");
    } finally {
      await app.close();
    }
  });

  it("fills all fifty public slots when an earlier candidate is malformed", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      seedProvider(database, "invalid early id", {
        displayName: "000 malformed",
        issuer: "https://malformed-early.example.test/",
      });
      for (let index = 0; index < 50; index += 1) {
        seedProvider(database, `oidc-valid-${String(index).padStart(2, "0")}`, {
          displayName: `Provider ${String(index).padStart(2, "0")}`,
        });
      }

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const providers = authProvidersResponseSchema.parse(response.json()).providers;

      expect(response.statusCode).toBe(200);
      expect(providers).toHaveLength(50);
      expect(providers.map((provider) => provider.displayName)).toEqual(
        Array.from({ length: 50 }, (_, index) => `Provider ${String(index).padStart(2, "0")}`),
      );
      expect(response.body).not.toContain("000 malformed");
    } finally {
      await app.close();
    }
  });

  it("stops paging after the explicit malformed-candidate scan limit", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    let prepare: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (let index = 0; index < OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT; index += 1) {
        seedProvider(database, `invalid id ${index}`, {
          displayName: `Malformed ${String(index).padStart(3, "0")}`,
          issuer: `https://malformed-${index}.example.test/`,
        });
      }
      seedProvider(database, "oidc-beyond-scan-limit", { displayName: "ZZZ valid provider" });
      prepare = vi.spyOn(database.sqlite, "prepare");

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const providerQueries = prepare.mock.calls.filter((call: unknown[]) => {
        const statement = call[0];
        return typeof statement === "string" && statement.includes('from "oidc_providers"');
      });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json()).providers).toEqual([]);
      expect(providerQueries).toHaveLength(
        OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT / OIDC_PROVIDER_PRESENTATION_PAGE_SIZE,
      );
    } finally {
      prepare?.mockRestore();
      await app.close();
    }
  });

  it("sorts deterministically, omits disabled providers, and caps the response at fifty", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig({ jellyfinUrl: new URL("https://jellyfin.example") }),
      database,
    });
    try {
      for (let index = 0; index < 55; index += 1) {
        seedProvider(database, `oidc-${String(index).padStart(2, "0")}`, {
          displayName: `Provider ${String(54 - index).padStart(3, "0")}`,
        });
      }
      seedProvider(database, "oidc-disabled", {
        displayName: "A disabled provider",
        enabled: false,
      });

      const first = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const second = await app.inject({ method: "GET", url: "/v1/auth/providers" });
      const firstProviders = authProvidersResponseSchema.parse(first.json()).providers;

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(firstProviders).toHaveLength(50);
      expect(firstProviders.map((provider) => provider.displayName)).toEqual([
        ...Array.from({ length: 49 }, (_, index) => `Provider ${String(index).padStart(3, "0")}`),
        "Jellyfin",
      ]);
      expect(first.body).not.toContain("oidc-disabled");
    } finally {
      await app.close();
    }
  });

  it("does not perform network discovery and marks the response as non-cacheable", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      seedProvider(database, "oidc-unchecked", { displayName: "Unchecked identity" });

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await app.close();
    }
  });

  it("never serializes provider configuration, discovery seals, or private claims", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    const markers = {
      approvedEndpoint: "private-upstream.example.test",
      claim: "private-group-claim-marker",
      clientId: "private-client-id-marker",
      clientSecret: "private-client-secret-marker",
      scope: "private-scope-marker",
    };
    try {
      const snapshot = discoverySnapshotObject(noLogout);
      seedProvider(database, "oidc-private", {
        approvedEndpointOriginsJson: JSON.stringify([`https://${markers.approvedEndpoint}`]),
        claimConfigJson: JSON.stringify({ groups: markers.claim }),
        clientId: markers.clientId,
        discoveryCapabilitiesJson: JSON.stringify({
          ...snapshot,
          capabilities: {
            ...snapshot.capabilities,
            tokenEndpointAuthMethod: "client_secret_basic",
          },
        }),
        discoveryCheckedAt: checkedAt,
        discoveryState: "ready",
        encryptedClientSecret: markers.clientSecret,
        scopes: `openid ${markers.scope}`,
        tokenEndpointAuthMethod: "client_secret_basic",
      });

      const response = await app.inject({ method: "GET", url: "/v1/auth/providers" });

      expect(response.statusCode).toBe(200);
      expect(authProvidersResponseSchema.parse(response.json()).providers).toEqual([
        expect.objectContaining({ id: "oidc-private", state: "unavailable" }),
      ]);
      for (const marker of [...Object.values(markers), runtimeSecuritySeal]) {
        expect(response.body).not.toContain(marker);
      }
      expect(response.body).not.toMatch(/runtimeSecuritySeal|clientId|clientSecret|claims|scopes/i);
    } finally {
      await app.close();
    }
  });
});
