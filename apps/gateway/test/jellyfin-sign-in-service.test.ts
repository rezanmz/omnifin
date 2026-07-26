import type {
  JellyfinAuthenticationResult,
  JellyfinPublicSystemInfo,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { describe, expect, it } from "vitest";

import {
  bootstrapConfiguredJellyfinConnector,
  JellyfinConnectorConfigurationError,
} from "../src/auth/jellyfin/connector-registry.js";
import { JellyfinSignInService } from "../src/auth/jellyfin/sign-in-service.js";
import { SessionService } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { connectorConfigs, serviceIdentityLinks, users } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const EARLIER = new Date("2026-07-26T11:00:00.000Z");
const ENCRYPTION_KEY = Buffer.alloc(32, 73);

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: ENCRYPTION_KEY,
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
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

function database() {
  const handle = openDatabase(":memory:");
  handle.migrate();
  return handle;
}

function seedConnector(handle: DatabaseHandle, overrides: Record<string, unknown> = {}) {
  handle.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: EARLIER,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: EARLIER,
      ...overrides,
    })
    .run();
}

function publicInfo(overrides: Partial<JellyfinPublicSystemInfo> = {}): JellyfinPublicSystemInfo {
  return {
    Id: "server-1",
    ServerName: "Home Jellyfin",
    Version: "10.10.7",
    ...overrides,
  };
}

function authentication(
  overrides: Partial<JellyfinAuthenticationResult> = {},
): JellyfinAuthenticationResult {
  return {
    AccessToken: "private-access-token",
    ServerId: "server-1",
    User: { Id: "jellyfin-user-1", Name: "Riley" },
    ...overrides,
  };
}

function service(
  handle: DatabaseHandle,
  options: {
    afterPublicInfo?: () => void;
    authentication?: JellyfinAuthenticationResult | Error;
    publicInfo?: JellyfinPublicSystemInfo | Error;
  } = {},
) {
  const appConfig = config();
  const sessions = new SessionService(handle, appConfig, { clock: () => new Date(NOW) });
  const signIn = new JellyfinSignInService(handle, appConfig, sessions, {
    clock: () => new Date(NOW),
    createClient: () => ({
      authenticateByName: async () => {
        options.afterPublicInfo?.();
        const result = options.authentication ?? authentication();
        if (result instanceof Error) throw result;
        return result;
      },
      getPublicSystemInfo: async () => {
        const result = options.publicInfo ?? publicInfo();
        if (result instanceof Error) throw result;
        return result;
      },
    }),
    createDeviceId: () => "omnifin-device-1",
  });
  return { sessions, signIn };
}

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    ipAddress: "192.0.2.10",
    password: "private-password",
    requestId: "request-jellyfin-sign-in",
    userAgent: "fixture-browser/1.0",
    username: "riley",
    ...overrides,
  };
}

describe("JellyfinSignInService", () => {
  it("provisions a viewer, encrypts the token, and issues an attributed session", async () => {
    const handle = database();
    seedConnector(handle);
    const { signIn } = service(handle);
    try {
      const result = await signIn.signInWithPassword(credentials());

      expect(result.status).toBe("signed_in");
      if (result.status !== "signed_in") throw new Error("Expected sign-in success.");
      expect(result.session.principal).toMatchObject({
        accountState: "active",
        authenticationMethod: { kind: "jellyfin" },
        displayName: "Riley",
        role: "viewer",
      });
      expect(result.session.principal.linkedServices).toEqual([
        expect.objectContaining({
          externalUserId: "jellyfin-user-1",
          health: "linked",
          username: "Riley",
        }),
      ]);

      const user = handle.db.select().from(users).get();
      const link = handle.db.select().from(serviceIdentityLinks).get();
      expect(user).toMatchObject({ role: "viewer", roleSource: "default", status: "active" });
      expect(link).toMatchObject({
        connectorId: "jellyfin-home",
        deviceId: "omnifin-device-1",
        externalServerId: "server-1",
        externalUserId: "jellyfin-user-1",
        healthState: "linked",
      });
      expect(link?.encryptedAccessToken).not.toContain("private-access-token");
      expect(
        new EnvelopeCipher(ENCRYPTION_KEY).decrypt(
          link!.encryptedAccessToken!,
          `service_identity_access_token:jellyfin:${link!.id}`,
        ),
      ).toBe("private-access-token");

      const serialized = JSON.stringify({
        principal: result.session.principal,
        csrfToken: result.session.csrfToken,
      });
      expect(serialized).not.toMatch(/private-password|private-access-token/);
      expect(() => JSON.stringify(result)).toThrow(/cannot be serialized/i);
    } finally {
      handle.close();
    }
  });

  it("reuses only the immutable server and user identity and rotates the browser session", async () => {
    const handle = database();
    seedConnector(handle);
    const firstService = service(handle);
    try {
      const first = await firstService.signIn.signInWithPassword(credentials());
      if (first.status !== "signed_in") throw new Error("Expected first sign-in success.");
      const originalLink = handle.db.select().from(serviceIdentityLinks).get()!;
      handle.db.update(users).set({ role: "operator", roleSource: "manual" }).run();

      const secondService = service(handle, {
        authentication: authentication({
          AccessToken: "rotated-private-access-token",
          User: { Id: "jellyfin-user-1", Name: "Riley Renamed" },
        }),
      });
      const second = await secondService.signIn.signInWithPassword(
        credentials({ currentSessionToken: first.session.sessionToken }),
      );

      expect(second.status).toBe("signed_in");
      if (second.status !== "signed_in") throw new Error("Expected second sign-in success.");
      expect(second.session.sessionToken).not.toBe(first.session.sessionToken);
      expect(second.session.principal).toMatchObject({
        role: "operator",
        userId: first.session.principal.userId,
      });
      expect(handle.db.select().from(users).all()).toHaveLength(1);
      expect(handle.db.select().from(serviceIdentityLinks).all()).toHaveLength(1);
      const updatedLink = handle.db.select().from(serviceIdentityLinks).get()!;
      expect(updatedLink).toMatchObject({
        externalDisplayName: "Riley Renamed",
        id: originalLink.id,
        revision: 1,
      });
      expect(firstService.sessions.resolveAndRefresh(first.session.sessionToken)).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("never links a different immutable Jellyfin user just because the username matches", async () => {
    const handle = database();
    seedConnector(handle);
    try {
      const first = await service(handle).signIn.signInWithPassword(credentials());
      expect(first.status).toBe("signed_in");
      const second = await service(handle, {
        authentication: authentication({
          AccessToken: "second-private-access-token",
          User: { Id: "jellyfin-user-2", Name: "Riley" },
        }),
      }).signIn.signInWithPassword(credentials());

      expect(second.status).toBe("signed_in");
      expect(handle.db.select().from(users).all()).toHaveLength(2);
      expect(handle.db.select().from(serviceIdentityLinks).all()).toHaveLength(2);
    } finally {
      handle.close();
    }
  });

  it("denies a disabled linked account without rotating its encrypted token", async () => {
    const handle = database();
    seedConnector(handle);
    try {
      const first = await service(handle).signIn.signInWithPassword(credentials());
      if (first.status !== "signed_in") throw new Error("Expected first sign-in success.");
      handle.db.update(users).set({ status: "disabled" }).run();
      const before = handle.db.select().from(serviceIdentityLinks).get()!;

      const denied = await service(handle, {
        authentication: authentication({ AccessToken: "attacker-controlled-new-token" }),
      }).signIn.signInWithPassword(credentials());

      expect(denied).toMatchObject({ reason: "account_disabled", status: "denied" });
      const after = handle.db.select().from(serviceIdentityLinks).get()!;
      expect(after.encryptedAccessToken).toBe(before.encryptedAccessToken);
      expect(after.revision).toBe(before.revision);
    } finally {
      handle.close();
    }
  });

  it("maps invalid upstream credentials to an opaque denial", async () => {
    const handle = database();
    seedConnector(handle);
    const upstreamFailure = new SafeConnectorError({
      code: "invalid_credentials",
      message: "Jellyfin rejected connector credentials.",
      operation: "password_authentication",
      retryable: false,
      service: "jellyfin",
      status: 401,
    });
    try {
      const result = await service(handle, {
        authentication: upstreamFailure,
      }).signIn.signInWithPassword(credentials());

      expect(result).toMatchObject({ reason: "invalid_credentials", status: "denied" });
      expect(handle.db.select().from(users).all()).toEqual([]);
      expect(() => JSON.stringify(result)).toThrow(/cannot be serialized/i);
      if (result.status !== "denied") throw new Error("Expected credential denial.");
      expect(result.reason).not.toContain("private-password");
    } finally {
      handle.close();
    }
  });

  it("fails closed if the public server identity disagrees with the token issuer", async () => {
    const handle = database();
    seedConnector(handle);
    try {
      await expect(
        service(handle, {
          publicInfo: publicInfo({ Id: "different-server" }),
        }).signIn.signInWithPassword(credentials()),
      ).rejects.toMatchObject({ reason: "server_mismatch" });
      expect(handle.db.select().from(users).all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("fails closed if connector configuration changes during authentication", async () => {
    const handle = database();
    seedConnector(handle);
    try {
      await expect(
        service(handle, {
          afterPublicInfo: () => {
            handle.db
              .update(connectorConfigs)
              .set({ baseUrl: "https://replacement.example.test", updatedAt: NOW })
              .run();
          },
        }).signIn.signInWithPassword(credentials()),
      ).rejects.toMatchObject({ reason: "configuration_invalid" });
      expect(handle.db.select().from(users).all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("requires exactly one enabled Jellyfin connector", async () => {
    const handle = database();
    seedConnector(handle);
    seedConnector(handle, { id: "jellyfin-second" });
    try {
      await expect(service(handle).signIn.signInWithPassword(credentials())).rejects.toMatchObject({
        reason: "configuration_invalid",
      });
    } finally {
      handle.close();
    }
  });
});

describe("bootstrapConfiguredJellyfinConnector", () => {
  it("persists an environment connector with encrypted empty credentials and an audit event", () => {
    const handle = database();
    try {
      const created = bootstrapConfiguredJellyfinConnector(
        handle,
        config({ jellyfinUrl: new URL("https://jellyfin.example.test/base/") }),
        { clock: () => new Date(NOW), createId: () => "audit-bootstrap-1" },
      );

      expect(created).toBe(true);
      const connector = handle.db.select().from(connectorConfigs).get()!;
      expect(connector).toMatchObject({
        baseUrl: "https://jellyfin.example.test/base/",
        enabled: true,
        id: "jellyfin",
        type: "jellyfin",
      });
      expect(
        new EnvelopeCipher(ENCRYPTION_KEY).decrypt(
          connector.encryptedCredentials,
          "connector_credentials:jellyfin:jellyfin",
        ),
      ).toBe("{}");
      expect(
        handle.sqlite
          .prepare("select event_type as eventType from audit_events where id = ?")
          .get("audit-bootstrap-1"),
      ).toEqual({ eventType: "connector.configuration.bootstrapped" });
      expect(
        bootstrapConfiguredJellyfinConnector(
          handle,
          config({ jellyfinUrl: new URL(connector.baseUrl) }),
        ),
      ).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("does not overwrite a connector already managed in the database", () => {
    const handle = database();
    seedConnector(handle);
    try {
      expect(
        bootstrapConfiguredJellyfinConnector(
          handle,
          config({ jellyfinUrl: new URL("https://different.example.test") }),
        ),
      ).toBe(false);
      expect(handle.db.select().from(connectorConfigs).get()?.baseUrl).toBe(
        "https://jellyfin.example.test",
      );
    } finally {
      handle.close();
    }
  });

  it("fails closed when the reserved environment connector identifier is occupied", () => {
    const handle = database();
    handle.db
      .insert(connectorConfigs)
      .values({
        baseUrl: "https://seerr.example.test",
        displayName: "Seerr",
        encryptedCredentials: "v2.fixture",
        id: "jellyfin",
        type: "seerr",
      })
      .run();
    try {
      expect(() =>
        bootstrapConfiguredJellyfinConnector(
          handle,
          config({ jellyfinUrl: new URL("https://jellyfin.example.test") }),
        ),
      ).toThrow(JellyfinConnectorConfigurationError);
    } finally {
      handle.close();
    }
  });
});
