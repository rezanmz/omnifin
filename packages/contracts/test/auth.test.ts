import { describe, expect, it } from "vitest";

import {
  ROLE_PERMISSIONS,
  authProviderSchema,
  externalIdentitySchema,
  roleMappingSchema,
  sessionPrincipalSchema,
} from "../src/auth.js";

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
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(ROLE_PERMISSIONS.requester).toContain(permission);
      expect(ROLE_PERMISSIONS.operator).toContain(permission);
      expect(ROLE_PERMISSIONS.admin).toContain(permission);
    }
  });

  it("rejects permissions that exceed the principal role", () => {
    const result = sessionPrincipalSchema.safeParse({
      userId: "user_1",
      displayName: "Riley",
      role: "viewer",
      permissions: ["media.view", "roles.manage"],
      authenticationMethod: { kind: "jellyfin" },
      externalIdentity: null,
      linkedServices: [],
      issuedAt: "2026-07-25T12:00:00.000Z",
      inactivityExpiresAt: "2026-07-26T12:00:00.000Z",
      absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("requires explicit session expiry boundaries and linked services", () => {
    expect(() =>
      sessionPrincipalSchema.parse({
        userId: "user_1",
        displayName: "Riley",
        role: "viewer",
        permissions: ["media.view", "playback.use"],
        authenticationMethod: { kind: "oidc", providerId: "authentik" },
        externalIdentity: null,
        linkedServices: [],
        issuedAt: "2026-07-25T12:00:00.000Z",
        inactivityExpiresAt: "not-a-date",
        absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects duplicate permissions and invalid expiry ordering", () => {
    const principal = {
      userId: "user_1",
      displayName: "Riley",
      role: "viewer" as const,
      permissions: ["media.view", "media.view"],
      authenticationMethod: { kind: "jellyfin" as const },
      externalIdentity: null,
      linkedServices: [],
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
