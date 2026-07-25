import { describe, expect, it } from "vitest";

import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  authProviderSchema,
  externalIdentitySchema,
  roleMappingSchema,
  serviceIdentityLinkSchema,
  sessionPrincipalSchema,
  sessionResponseSchema,
} from "../src/auth.js";

const sessionTimes = {
  issuedAt: "2026-07-25T12:00:00.000Z",
  inactivityExpiresAt: "2026-07-26T12:00:00.000Z",
  absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
};

const jellyfinLink = {
  id: "link_1",
  service: "jellyfin" as const,
  externalUserId: "jellyfin-user-1",
  displayName: "Riley",
  username: "riley",
  health: "linked" as const,
  linkedAt: "2026-07-25T12:00:00.000Z",
  lastVerifiedAt: "2026-07-25T12:00:00.000Z",
};

const activePrincipal = {
  sessionId: "session_1",
  accountState: "active" as const,
  userId: "user_1",
  displayName: "Riley",
  role: "viewer" as const,
  permissions: ROLE_PERMISSIONS.viewer,
  authenticationMethod: { kind: "jellyfin" as const },
  externalIdentity: null,
  linkedServices: [jellyfinLink],
  ...sessionTimes,
};

const oidcIdentity = {
  providerId: "authentik",
  issuer: "https://id.example.test/application/o/omnifin/",
  subject: "01J2Y9MX1ZC9Y4K4VZ0B1BG2GN",
  displayClaims: { displayName: "Riley" },
};

const validCsrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("authentication contracts", () => {
  it("exposes only login-safe OIDC provider metadata", () => {
    const provider = authProviderSchema.parse({
      id: "authentik",
      kind: "oidc",
      displayName: "Home identity",
      issuer: "https://id.example.test/application/o/omnifin/",
      state: "available",
      jitProvisioningEnabled: true,
      supportsRpInitiatedLogout: true,
      supportsFrontChannelLogout: true,
      supportsBackChannelLogout: true,
      clientSecret: "must-not-cross-the-contract",
    });

    expect(provider).not.toHaveProperty("clientSecret");

    expect(
      authProviderSchema.parse({
        id: "jellyfin",
        kind: "jellyfin",
        displayName: "Media server",
        state: "available",
        passwordLoginAvailable: true,
        quickConnectAvailable: true,
        pairingRequiredAfterOidc: true,
      }),
    ).toEqual({
      id: "jellyfin",
      kind: "jellyfin",
      displayName: "Media server",
      state: "available",
      passwordLoginAvailable: true,
      quickConnectAvailable: true,
      pairingRequiredAfterOidc: true,
    });
  });

  it("keys an external identity by issuer and immutable subject", () => {
    expect(
      externalIdentitySchema.parse({
        providerId: "authentik",
        issuer: "https://id.example.test/application/o/omnifin/",
        subject: "01J2Y9MX1ZC9Y4K4VZ0B1BG2GN",
        displayClaims: {
          displayName: "Riley",
          email: "riley@example.test",
          emailVerified: true,
        },
      }),
    ).toMatchObject({ subject: "01J2Y9MX1ZC9Y4K4VZ0B1BG2GN" });
  });

  it("uses explicit Jellyfin link health states", () => {
    const link = {
      id: "link_1",
      service: "jellyfin" as const,
      externalUserId: "jellyfin-user-1",
      displayName: "Riley",
      username: "riley",
      linkedAt: "2026-07-25T12:00:00.000Z",
      lastVerifiedAt: "2026-07-25T12:00:00.000Z",
    };

    for (const health of ["linked", "unavailable", "relink_required", "revoked"] as const) {
      expect(serviceIdentityLinkSchema.parse({ ...link, health })).toMatchObject({ health });
    }
    expect(serviceIdentityLinkSchema.safeParse({ ...link, health: "pending" }).success).toBe(false);
  });

  it("rejects a role mapping with no explicit claim values", () => {
    expect(() =>
      roleMappingSchema.parse({
        id: "operators",
        providerId: "authentik",
        claimPath: ["groups"],
        operator: "contains_any",
        values: [],
        role: "operator",
        priority: 100,
        enabled: true,
      }),
    ).toThrow();
  });

  it("requires secure OIDC issuers and safe claim paths", () => {
    expect(() =>
      authProviderSchema.parse({
        id: "insecure",
        kind: "oidc",
        displayName: "Insecure provider",
        issuer: "http://id.example.test/application/o/omnifin/",
        state: "misconfigured",
        jitProvisioningEnabled: false,
        supportsRpInitiatedLogout: false,
        supportsFrontChannelLogout: false,
        supportsBackChannelLogout: false,
      }),
    ).toThrow();

    expect(() =>
      roleMappingSchema.parse({
        id: "unsafe-path",
        providerId: "authentik",
        claimPath: ["__proto__", "groups"],
        operator: "contains_any",
        values: ["operators"],
        role: "operator",
        priority: 100,
        enabled: true,
      }),
    ).toThrow();
  });

  it("keeps role permissions monotonic", () => {
    expect(ROLE_PERMISSIONS.viewer).toEqual(
      expect.arrayContaining(["identities.self.manage", "sessions.self.revoke"]),
    );

    const roleOrder = ["viewer", "requester", "operator", "admin"] as const;
    for (const [index, role] of roleOrder.entries()) {
      for (const higherRole of roleOrder.slice(index + 1)) {
        expect(ROLE_PERMISSIONS[higherRole]).toEqual(
          expect.arrayContaining([...ROLE_PERMISSIONS[role]]),
        );
      }
    }
  });

  it("retains explicit active account and session identities", () => {
    expect(sessionPrincipalSchema.parse(activePrincipal)).toMatchObject({
      sessionId: "session_1",
      accountState: "active",
    });
    expect(
      sessionPrincipalSchema.safeParse({ ...activePrincipal, sessionId: undefined }).success,
    ).toBe(false);
    expect(sessionPrincipalSchema.safeParse({ ...activePrincipal, sessionId: "" }).success).toBe(
      false,
    );
    expect(
      sessionPrincipalSchema.safeParse({ ...activePrincipal, accountState: undefined }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({ ...activePrincipal, accountState: "disabled" }).success,
    ).toBe(false);
  });

  it("requires an active account to retain an established Jellyfin identity link", () => {
    expect(
      sessionPrincipalSchema.safeParse({ ...activePrincipal, linkedServices: [] }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        linkedServices: [{ ...jellyfinLink, health: "revoked" }],
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        linkedServices: [{ ...jellyfinLink, health: "unavailable" }],
      }).success,
    ).toBe(true);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        linkedServices: [{ ...jellyfinLink, health: "relink_required" }],
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        linkedServices: [{ ...jellyfinLink, externalUserId: null }],
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        role: "admin",
        permissions: ROLE_PERMISSIONS.admin,
      }).success,
    ).toBe(true);
  });

  it("binds authentication methods to their external identity attribution", () => {
    const oidcPrincipal = {
      ...activePrincipal,
      authenticationMethod: { kind: "oidc" as const, providerId: "authentik" },
      externalIdentity: oidcIdentity,
    };

    expect(sessionPrincipalSchema.safeParse(oidcPrincipal).success).toBe(true);
    expect(
      sessionPrincipalSchema.safeParse({ ...oidcPrincipal, externalIdentity: null }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...oidcPrincipal,
        externalIdentity: { ...oidcIdentity, providerId: "other-provider" },
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        externalIdentity: oidcIdentity,
      }).success,
    ).toBe(false);
  });

  it("limits pending-link accounts to a normal user's self-service permissions", () => {
    const pendingPrincipal = {
      ...activePrincipal,
      accountState: "pending_link" as const,
      permissions: ["identities.self.manage", "sessions.self.revoke"] as const,
      authenticationMethod: { kind: "oidc" as const, providerId: "authentik" },
      externalIdentity: oidcIdentity,
      linkedServices: [],
    };

    expect(sessionPrincipalSchema.safeParse(pendingPrincipal).success).toBe(true);
    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        permissions: [...pendingPrincipal.permissions, "media.view"],
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        permissions: ["identities.self.manage"],
      }).success,
    ).toBe(false);
    expect(sessionPrincipalSchema.safeParse({ ...pendingPrincipal, userId: null }).success).toBe(
      false,
    );
    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        authenticationMethod: { kind: "recovery" },
      }).success,
    ).toBe(false);
    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        linkedServices: [jellyfinLink],
      }).success,
    ).toBe(false);
  });

  it("isolates recovery sessions from user identities and media capabilities", () => {
    expect(RECOVERY_PERMISSIONS).toEqual([
      "recovery.oidc.manage",
      "recovery.jellyfin.manage",
      "recovery.sessions.revoke",
    ]);

    const recoveryPrincipal = {
      ...activePrincipal,
      accountState: "recovery" as const,
      userId: null,
      displayName: "Recovery administrator",
      role: "admin" as const,
      permissions: [...RECOVERY_PERMISSIONS].reverse(),
      authenticationMethod: { kind: "recovery" as const },
      externalIdentity: null,
      linkedServices: [],
    };

    expect(sessionPrincipalSchema.parse(recoveryPrincipal)).toMatchObject({
      accountState: "recovery",
      userId: null,
      permissions: expect.arrayContaining([...RECOVERY_PERMISSIONS]),
    });

    const invalidOverrides = [
      { permissions: [...RECOVERY_PERMISSIONS, "media.view"] },
      { permissions: RECOVERY_PERMISSIONS.slice(1) },
      { role: "operator" },
      { userId: "user_1" },
      { authenticationMethod: { kind: "jellyfin" } },
      { externalIdentity: oidcIdentity },
      { linkedServices: [jellyfinLink] },
    ];
    for (const override of invalidOverrides) {
      expect(sessionPrincipalSchema.safeParse({ ...recoveryPrincipal, ...override }).success).toBe(
        false,
      );
    }

    expect(sessionPrincipalSchema.safeParse({ ...activePrincipal, userId: null }).success).toBe(
      false,
    );
    expect(
      sessionPrincipalSchema.safeParse({
        ...activePrincipal,
        authenticationMethod: { kind: "recovery" },
      }).success,
    ).toBe(false);
  });

  it("pairs authenticated sessions with a bounded base64url CSRF token", () => {
    expect(
      sessionResponseSchema.safeParse({ principal: activePrincipal, csrfToken: validCsrfToken })
        .success,
    ).toBe(true);
    expect(
      sessionResponseSchema.safeParse({ principal: activePrincipal, csrfToken: "A".repeat(128) })
        .success,
    ).toBe(true);
    expect(sessionResponseSchema.safeParse({ principal: null, csrfToken: null }).success).toBe(
      true,
    );

    expect(
      sessionResponseSchema.safeParse({ principal: activePrincipal, csrfToken: null }).success,
    ).toBe(false);
    expect(
      sessionResponseSchema.safeParse({ principal: null, csrfToken: validCsrfToken }).success,
    ).toBe(false);

    for (const csrfToken of [
      validCsrfToken.slice(1),
      "A".repeat(129),
      `${validCsrfToken.slice(1)}=`,
      `${validCsrfToken.slice(1)} `,
    ]) {
      expect(
        sessionResponseSchema.safeParse({ principal: activePrincipal, csrfToken }).success,
      ).toBe(false);
    }

    expect(sessionResponseSchema.safeParse({ principal: activePrincipal }).success).toBe(false);
    expect(sessionResponseSchema.safeParse({ csrfToken: validCsrfToken }).success).toBe(false);
  });

  it("rejects permissions that exceed the principal role", () => {
    const result = sessionPrincipalSchema.safeParse({
      sessionId: "session_1",
      accountState: "active",
      userId: "user_1",
      displayName: "Riley",
      role: "viewer",
      permissions: ["media.view", "roles.manage"],
      authenticationMethod: { kind: "jellyfin" },
      externalIdentity: null,
      linkedServices: [jellyfinLink],
      issuedAt: "2026-07-25T12:00:00.000Z",
      inactivityExpiresAt: "2026-07-26T12:00:00.000Z",
      absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("requires explicit session expiry boundaries", () => {
    expect(() =>
      sessionPrincipalSchema.parse({
        sessionId: "session_1",
        accountState: "active",
        userId: "user_1",
        displayName: "Riley",
        role: "viewer",
        permissions: ["media.view", "playback.use"],
        authenticationMethod: { kind: "oidc", providerId: "authentik" },
        externalIdentity: oidcIdentity,
        linkedServices: [jellyfinLink],
        issuedAt: "2026-07-25T12:00:00.000Z",
        inactivityExpiresAt: "not-a-date",
        absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects duplicate permissions and invalid expiry ordering", () => {
    const principal = {
      sessionId: "session_1",
      accountState: "active" as const,
      userId: "user_1",
      displayName: "Riley",
      role: "viewer" as const,
      permissions: ["media.view", "media.view"],
      authenticationMethod: { kind: "jellyfin" as const },
      externalIdentity: null,
      linkedServices: [jellyfinLink],
      issuedAt: "2026-07-25T12:00:00.000Z",
      inactivityExpiresAt: "2026-07-25T11:00:00.000Z",
      absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
    };

    const duplicateAndPastExpiry = sessionPrincipalSchema.safeParse(principal);
    expect(duplicateAndPastExpiry.success).toBe(false);
    if (!duplicateAndPastExpiry.success) {
      expect(duplicateAndPastExpiry.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Session permissions cannot contain duplicates.",
          "Session expiry must be later than session issuance.",
        ]),
      );
    }

    const inactivityBeyondAbsolute = sessionPrincipalSchema.safeParse({
      ...principal,
      permissions: ["media.view"],
      inactivityExpiresAt: "2026-08-02T12:00:00.000Z",
    });
    expect(inactivityBeyondAbsolute.success).toBe(false);
    if (!inactivityBeyondAbsolute.success) {
      expect(inactivityBeyondAbsolute.error.issues.map((issue) => issue.message)).toContain(
        "Inactivity expiry cannot exceed absolute expiry.",
      );
    }
  });
});
