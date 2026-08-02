import { describe, expect, it } from "vitest";

import {
  AUTH_USERS_PAGE_MAX_COUNT,
  OIDC_ISSUER_MAX_LENGTH,
  PENDING_BOOTSTRAP_ADMIN_PERMISSIONS,
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  authenticatedSessionResponseSchema,
  authProviderSchema,
  externalIdentitySchema,
  jellyfinIdentityPairingResponseSchema,
  identityLinkRevocationResponseSchema,
  identityLinksResponseSchema,
  oidcProviderAdminSchema,
  oidcProviderCreateRequestSchema,
  oidcProviderDeleteResponseSchema,
  oidcProviderMutationResponseSchema,
  oidcProviderUpdateRequestSchema,
  oidcProviderValidationParamsSchema,
  oidcProviderValidationResponseSchema,
  oidcProvidersAdminResponseSchema,
  oidcRoleMappingCreateRequestSchema,
  oidcRoleMappingDeleteResponseSchema,
  oidcRoleMappingMutationResponseSchema,
  oidcRoleMappingUpdateRequestSchema,
  oidcRoleMappingsAdminResponseSchema,
  jellyfinPasswordAuthenticationRequestSchema,
  jellyfinPasswordPairingRequestSchema,
  jellyfinQuickConnectInitiationRequestSchema,
  jellyfinQuickConnectInitiationResponseSchema,
  jellyfinQuickConnectBootstrapPollResponseSchema,
  jellyfinQuickConnectPairingPollResponseSchema,
  jellyfinQuickConnectPollResponseSchema,
  roleMappingSchema,
  serviceIdentityLinkSchema,
  sessionPrincipalSchema,
  sessionResponseSchema,
  userAccessListResponseSchema,
  userAccessMutationRequestSchema,
  userAccessMutationResponseSchema,
  userAccessSummarySchema,
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

const activeOidcPrincipal = {
  ...activePrincipal,
  authenticationMethod: { kind: "oidc" as const, providerId: "authentik" },
  externalIdentity: {
    displayClaims: { displayName: "Riley" },
    issuer: "https://id.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "immutable-subject",
  },
};

describe("Jellyfin authentication contracts", () => {
  it("preserves password bytes while normalizing the username", () => {
    expect(
      jellyfinPasswordAuthenticationRequestSchema.parse({
        password: "  password bytes stay exact  ",
        username: "  riley  ",
      }),
    ).toEqual({
      password: "  password bytes stay exact  ",
      username: "riley",
    });
  });

  it("rejects oversized credentials and unexpected fields", () => {
    expect(
      jellyfinPasswordAuthenticationRequestSchema.safeParse({
        password: "x".repeat(1_025),
        username: "riley",
      }).success,
    ).toBe(false);
    expect(
      jellyfinPasswordAuthenticationRequestSchema.safeParse({
        password: "password",
        username: "riley",
        upstreamUrl: "https://attacker.example",
      }).success,
    ).toBe(false);
  });

  it("requires a fully attributed authenticated session response", () => {
    expect(
      authenticatedSessionResponseSchema.parse({
        csrfToken: "c".repeat(43),
        principal: activePrincipal,
      }),
    ).toMatchObject({ principal: { accountState: "active" } });
    expect(
      authenticatedSessionResponseSchema.safeParse({ csrfToken: null, principal: null }).success,
    ).toBe(false);
  });

  it("keeps pairing credentials strict and returns only the upgraded session", () => {
    expect(
      jellyfinPasswordPairingRequestSchema.parse({
        password: "private-password",
        username: "riley",
      }),
    ).toEqual({ password: "private-password", username: "riley" });
    expect(
      jellyfinPasswordPairingRequestSchema.safeParse({
        password: "private-password",
        sessionId: "attacker-selected-session",
        username: "riley",
      }).success,
    ).toBe(false);
    expect(
      jellyfinIdentityPairingResponseSchema.parse({
        csrfToken: "c".repeat(43),
        principal: activePrincipal,
      }),
    ).not.toHaveProperty("accessToken");
  });

  it("keeps Quick Connect transactions opaque and rejects extended requests", () => {
    expect(jellyfinQuickConnectInitiationRequestSchema.parse({})).toEqual({});
    expect(
      jellyfinQuickConnectInitiationRequestSchema.safeParse({
        connectorUrl: "https://attacker.example",
      }).success,
    ).toBe(false);
    expect(
      jellyfinQuickConnectInitiationResponseSchema.parse({
        code: "AB-1234",
        expiresAt: "2026-07-25T12:10:00.000Z",
        pollAfterMs: 2_000,
        transactionId: "quick-connect-1",
      }),
    ).not.toHaveProperty("secret");
  });

  it("normalizes pending, expired, and authenticated Quick Connect poll states", () => {
    expect(
      jellyfinQuickConnectPollResponseSchema.parse({
        expiresAt: "2026-07-25T12:10:00.000Z",
        pollAfterMs: 2_000,
        status: "pending",
      }),
    ).toMatchObject({ status: "pending" });
    expect(jellyfinQuickConnectPollResponseSchema.parse({ status: "expired" })).toEqual({
      status: "expired",
    });
    expect(
      jellyfinQuickConnectPollResponseSchema.parse({
        csrfToken: "c".repeat(43),
        principal: activePrincipal,
        status: "signed_in",
      }),
    ).toMatchObject({ status: "signed_in" });
    expect(
      jellyfinQuickConnectPollResponseSchema.safeParse({
        expiresAt: "2026-07-25T12:10:00.000Z",
        pollAfterMs: 2_000,
        secret: "must-not-cross-the-contract",
        status: "pending",
      }).success,
    ).toBe(false);
  });

  it("distinguishes a paired OIDC session from direct Quick Connect sign-in", () => {
    expect(
      jellyfinQuickConnectPairingPollResponseSchema.parse({
        csrfToken: "c".repeat(43),
        principal: activeOidcPrincipal,
        status: "paired",
      }),
    ).toMatchObject({ status: "paired" });
    expect(
      jellyfinQuickConnectPairingPollResponseSchema.safeParse({
        csrfToken: "c".repeat(43),
        principal: activePrincipal,
        status: "paired",
      }).success,
    ).toBe(false);
  });

  it("accepts only an active Jellyfin administrator after bootstrap", () => {
    const administrator = {
      ...activePrincipal,
      permissions: ROLE_PERMISSIONS.admin,
      role: "admin" as const,
    };
    expect(
      jellyfinQuickConnectBootstrapPollResponseSchema.parse({
        csrfToken: "c".repeat(43),
        principal: administrator,
        status: "bootstrapped",
      }),
    ).toMatchObject({ status: "bootstrapped" });
    expect(
      jellyfinQuickConnectBootstrapPollResponseSchema.safeParse({
        csrfToken: "c".repeat(43),
        principal: activePrincipal,
        status: "bootstrapped",
      }).success,
    ).toBe(false);
    expect(
      jellyfinQuickConnectBootstrapPollResponseSchema.safeParse({
        csrfToken: "c".repeat(43),
        principal: {
          ...administrator,
          authenticationMethod: { kind: "oidc", providerId: "authentik" },
          externalIdentity: oidcIdentity,
        },
        status: "bootstrapped",
      }).success,
    ).toBe(false);
  });
});

describe("user access administration contracts", () => {
  const user = {
    activeSessions: 2,
    authenticationMethods: ["jellyfin"] as const,
    createdAt: "2026-07-25T12:00:00.000Z",
    displayName: "Riley",
    id: "user_1",
    jellyfinLinkHealth: "linked" as const,
    lastActiveAt: "2026-07-29T12:00:00.000Z",
    role: "requester" as const,
    roleSource: "manual" as const,
    status: "active" as const,
    updatedAt: "2026-07-28T12:00:00.000Z",
  };

  it("accepts a bounded browser-safe user page and mutation response", () => {
    expect(userAccessSummarySchema.parse(user)).toEqual(user);
    expect(userAccessListResponseSchema.parse({ nextCursor: "user_2", users: [user] })).toEqual({
      nextCursor: "user_2",
      users: [user],
    });
    expect(userAccessMutationResponseSchema.parse({ revokedSessions: 2, user })).toEqual({
      revokedSessions: 2,
      user,
    });
    expect(AUTH_USERS_PAGE_MAX_COUNT).toBe(50);
  });

  it("requires a role or status change and an optimistic revision", () => {
    expect(
      userAccessMutationRequestSchema.parse({
        expectedUpdatedAt: user.updatedAt,
        role: "operator",
      }),
    ).toEqual({ expectedUpdatedAt: user.updatedAt, role: "operator" });
    expect(
      userAccessMutationRequestSchema.safeParse({ expectedUpdatedAt: user.updatedAt }).success,
    ).toBe(false);
    expect(
      userAccessMutationRequestSchema.parse({
        enabled: false,
        expectedUpdatedAt: user.updatedAt,
      }),
    ).toEqual({ enabled: false, expectedUpdatedAt: user.updatedAt });
  });

  it("rejects inconsistent authentication summaries and unbounded pages", () => {
    expect(
      userAccessSummarySchema.safeParse({
        ...user,
        authenticationMethods: ["jellyfin", "jellyfin"],
      }).success,
    ).toBe(false);
    expect(userAccessSummarySchema.safeParse({ ...user, jellyfinLinkHealth: null }).success).toBe(
      false,
    );
    expect(
      userAccessSummarySchema.safeParse({
        ...user,
        authenticationMethods: ["oidc"],
      }).success,
    ).toBe(false);
    expect(
      userAccessListResponseSchema.safeParse({
        nextCursor: null,
        users: Array.from({ length: AUTH_USERS_PAGE_MAX_COUNT + 1 }, () => user),
      }).success,
    ).toBe(false);
  });
});

const oidcIdentity = {
  providerId: "authentik",
  issuer: "https://id.example.test/application/o/omnifin/",
  subject: "01J2Y9MX1ZC9Y4K4VZ0B1BG2GN",
  displayClaims: { displayName: "Riley" },
};

const validCsrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("authentication contracts", () => {
  it("keeps OIDC provider administration strict and secret-free", () => {
    const request = oidcProviderCreateRequestSchema.parse({
      allowJitProvisioning: true,
      approvedEndpointOrigins: ["https://id.example.test"],
      clientId: "omnifin",
      clientSecret: "private-client-secret",
      displayName: "Home identity",
      enabled: true,
      idTokenSigningAlg: "RS256",
      issuer: "https://id.example.test/application/o/omnifin/",
      scopes: ["openid", "profile", "email", "groups"],
      slug: "home-identity",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect(request.clientSecret).toBe("private-client-secret");

    const provider = {
      allowJitProvisioning: true,
      approvedEndpointOrigins: ["https://id.example.test"],
      clientId: "omnifin",
      clientSecretConfigured: true,
      createdAt: "2026-07-26T12:00:00.000Z",
      discoveryCheckedAt: null,
      discoveryState: "unchecked" as const,
      displayName: "Home identity",
      enabled: true,
      id: "oidc-home-identity",
      idTokenSigningAlg: "RS256" as const,
      issuer: "https://id.example.test/application/o/omnifin/",
      scopes: ["openid", "profile", "email", "groups"],
      slug: "home-identity",
      tokenEndpointAuthMethod: "client_secret_basic" as const,
      updatedAt: "2026-07-26T12:00:00.000Z",
    };
    expect(oidcProvidersAdminResponseSchema.parse({ providers: [provider] })).toEqual({
      providers: [provider],
    });
    expect(
      oidcProviderAdminSchema.safeParse({ ...provider, clientSecret: "must-not-cross" }).success,
    ).toBe(false);
    expect(oidcProviderValidationParamsSchema.parse({ providerId: provider.id })).toEqual({
      providerId: provider.id,
    });
    const validation = {
      capabilities: {
        authorizationCodeFlow: true,
        idTokenSigningAlg: "RS256" as const,
        logout: {
          backChannel: true,
          backChannelSession: true,
          frontChannel: true,
          frontChannelSession: true,
          rpInitiated: true,
        },
        pkceS256: true,
        schemaVersion: 1 as const,
        tokenEndpointAuthMethod: "client_secret_basic" as const,
        userInfo: true,
      },
      provider: {
        ...provider,
        discoveryCheckedAt: "2026-07-26T12:01:00.000Z",
        discoveryState: "ready" as const,
      },
    };
    expect(oidcProviderValidationResponseSchema.parse(validation)).toEqual(validation);
    expect(
      oidcProviderValidationResponseSchema.safeParse({
        ...validation,
        capabilities: {
          ...validation.capabilities,
          authorizationEndpoint: "https://id.example.test/private-authorize",
          runtimeSecuritySeal: "must-not-cross",
        },
      }).success,
    ).toBe(false);
    expect(oidcProviderMutationResponseSchema.parse({ provider, revokedSessions: 2 })).toEqual({
      provider,
      revokedSessions: 2,
    });
    expect(
      oidcProviderDeleteResponseSchema.parse({
        deletedProviderId: provider.id,
        deletedRoleMappings: 3,
        revokedSessions: 0,
      }),
    ).toEqual({
      deletedProviderId: provider.id,
      deletedRoleMappings: 3,
      revokedSessions: 0,
    });
  });

  it("rejects unsafe or internally inconsistent OIDC provider configuration", () => {
    const base = {
      allowJitProvisioning: true,
      approvedEndpointOrigins: ["https://id.example.test"],
      clientId: "omnifin",
      displayName: "Home identity",
      enabled: true,
      idTokenSigningAlg: "RS256",
      issuer: "https://id.example.test/application/o/omnifin/",
      scopes: ["openid", "profile", "email"],
      slug: "home-identity",
      tokenEndpointAuthMethod: "none",
    };
    expect(oidcProviderCreateRequestSchema.safeParse(base).success).toBe(true);
    expect(
      oidcProviderCreateRequestSchema.safeParse({ ...base, clientSecret: "unexpected" }).success,
    ).toBe(false);
    expect(
      oidcProviderCreateRequestSchema.safeParse({
        ...base,
        tokenEndpointAuthMethod: "client_secret_post",
      }).success,
    ).toBe(false);
    expect(
      oidcProviderCreateRequestSchema.safeParse({
        ...base,
        scopes: ["openid", "offline_access"],
      }).success,
    ).toBe(false);
    expect(
      oidcProviderCreateRequestSchema.safeParse({
        ...base,
        approvedEndpointOrigins: ["https://elsewhere.example.test"],
      }).success,
    ).toBe(false);
    expect(
      oidcProviderCreateRequestSchema.safeParse({ ...base, slug: "Home Identity" }).success,
    ).toBe(false);
    expect(
      oidcProviderUpdateRequestSchema.safeParse({
        ...base,
        tokenEndpointAuthMethod: "client_secret_basic",
      }).success,
    ).toBe(true);
    expect(
      oidcProviderUpdateRequestSchema.safeParse({
        ...base,
        clientSecret: "must-not-be-retained",
      }).success,
    ).toBe(false);
    expect(
      oidcProviderUpdateRequestSchema.safeParse({
        ...base,
        providerId: "attacker-selected-provider",
      }).success,
    ).toBe(false);
  });

  it("keeps OIDC role-mapping administration bounded and exact", () => {
    const create = oidcRoleMappingCreateRequestSchema.parse({
      claimPath: ["groups"],
      enabled: true,
      operator: "contains_any",
      priority: 500,
      role: "operator",
      values: ["media-operators", 7, true],
    });
    const mapping = {
      ...create,
      id: "mapping-1",
      providerId: "oidc-home",
    };
    expect(oidcRoleMappingsAdminResponseSchema.parse({ mappings: [mapping] })).toEqual({
      mappings: [mapping],
    });
    expect(oidcRoleMappingMutationResponseSchema.parse({ mapping, revokedSessions: 3 })).toEqual({
      mapping,
      revokedSessions: 3,
    });
    expect(
      oidcRoleMappingDeleteResponseSchema.parse({
        deletedMappingId: mapping.id,
        revokedSessions: 2,
      }),
    ).toEqual({ deletedMappingId: mapping.id, revokedSessions: 2 });
    expect(
      oidcRoleMappingCreateRequestSchema.safeParse({
        ...create,
        values: ["duplicate", "duplicate"],
      }).success,
    ).toBe(false);
    expect(
      oidcRoleMappingCreateRequestSchema.safeParse({ ...create, providerId: "forged" }).success,
    ).toBe(false);
    expect(oidcRoleMappingUpdateRequestSchema.parse(create)).toEqual(create);
    expect(
      oidcRoleMappingUpdateRequestSchema.safeParse({ ...create, id: mapping.id }).success,
    ).toBe(false);
    expect(
      oidcRoleMappingUpdateRequestSchema.safeParse({ ...create, providerId: mapping.providerId })
        .success,
    ).toBe(false);
  });

  it("keeps self-service link status and revocation responses normalized", () => {
    const revokedLink = {
      displayName: "Riley",
      externalUserId: "jellyfin-user-1",
      health: "revoked" as const,
      id: "jellyfin-link-1",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin" as const,
      username: "riley",
    };

    expect(identityLinksResponseSchema.parse({ links: [revokedLink] })).toEqual({
      links: [revokedLink],
    });
    expect(
      identityLinkRevocationResponseSchema.parse({ link: revokedLink, principal: null }),
    ).toEqual({ link: revokedLink, principal: null });
    expect(() =>
      identityLinksResponseSchema.parse({
        links: [revokedLink, { ...revokedLink, id: "another-link" }],
      }),
    ).toThrow();
    expect(() =>
      identityLinkRevocationResponseSchema.parse({
        link: { ...revokedLink, health: "linked" },
        principal: activeOidcPrincipal,
      }),
    ).toThrow();
  });

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

  it("uses one exact issuer-length boundary across provider and identity contracts", () => {
    const prefix = "https://id.example.test/";
    const issuer = `${prefix}${"a".repeat(OIDC_ISSUER_MAX_LENGTH - prefix.length)}`;
    const provider = {
      id: "maximum-issuer",
      kind: "oidc" as const,
      displayName: "Maximum issuer",
      issuer,
      state: "available" as const,
      jitProvisioningEnabled: true,
      supportsRpInitiatedLogout: false,
      supportsFrontChannelLogout: false,
      supportsBackChannelLogout: false,
    };

    expect(issuer).toHaveLength(OIDC_ISSUER_MAX_LENGTH);
    expect(authProviderSchema.safeParse(provider).success).toBe(true);
    expect(
      externalIdentitySchema.safeParse({
        ...oidcIdentity,
        issuer,
      }).success,
    ).toBe(true);
    expect(authProviderSchema.safeParse({ ...provider, issuer: `${issuer}a` }).success).toBe(false);
    expect(
      externalIdentitySchema.safeParse({ ...oidcIdentity, issuer: `${issuer}a` }).success,
    ).toBe(false);
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

    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        permissions: [...PENDING_BOOTSTRAP_ADMIN_PERMISSIONS],
        role: "admin",
      }).success,
    ).toBe(true);
    expect(
      sessionPrincipalSchema.safeParse({
        ...pendingPrincipal,
        permissions: [...PENDING_BOOTSTRAP_ADMIN_PERMISSIONS],
        role: "operator",
      }).success,
    ).toBe(false);
    expect(PENDING_BOOTSTRAP_ADMIN_PERMISSIONS).not.toContain("media.view");
    expect(PENDING_BOOTSTRAP_ADMIN_PERMISSIONS).not.toContain("playback.use");
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
