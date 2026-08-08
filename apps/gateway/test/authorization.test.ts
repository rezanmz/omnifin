import {
  PENDING_LINK_PERMISSIONS,
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionSchema,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
import {
  hasPermission,
  requirePermission,
  requireSelfSessionRevocation,
} from "../src/auth/authorization.js";
import type { SafeHttpError } from "../src/http-error.js";

const times = {
  absoluteExpiresAt: "2026-08-01T12:00:00.000Z",
  inactivityExpiresAt: "2026-07-26T12:00:00.000Z",
  issuedAt: "2026-07-25T12:00:00.000Z",
};

function activeAdmin(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    ...times,
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Administrator",
    externalIdentity: null,
    linkedServices: [
      {
        displayName: "Administrator",
        externalUserId: "jellyfin-admin",
        health: "linked",
        id: "link-admin",
        lastVerifiedAt: times.issuedAt,
        linkedAt: times.issuedAt,
        service: "jellyfin",
        username: "admin",
      },
    ],
    permissions: ROLE_PERMISSIONS.admin,
    role: "admin",
    sessionId: "session-admin",
    userId: "user-admin",
  });
}

function pendingAdmin(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    ...activeAdmin(),
    accountState: "pending_link",
    authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
    externalIdentity: {
      displayClaims: { displayName: "Administrator" },
      issuer: "https://id.example.test/application/o/omnifin/",
      providerId: "oidc-home",
      subject: "subject-admin",
    },
    linkedServices: [],
    permissions: PENDING_LINK_PERMISSIONS,
  });
}

function recoveryPrincipal(): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    ...activeAdmin(),
    accountState: "recovery",
    authenticationMethod: { kind: "recovery" },
    displayName: "Recovery access",
    linkedServices: [],
    permissions: RECOVERY_PERMISSIONS,
    userId: null,
  });
}

describe("permission authorization", () => {
  it("uses effective permissions instead of the displayed assigned role", () => {
    const pending = pendingAdmin();
    const recovery = recoveryPrincipal();

    expect(pending.role).toBe("admin");
    expect(hasPermission(pending, "identities.self.manage")).toBe(true);
    expect(hasPermission(pending, "connectors.manage")).toBe(false);
    expect(() => requirePermission(pending, "connectors.manage")).toThrow(
      expect.objectContaining<Partial<SafeHttpError>>({
        code: "permission_denied",
        statusCode: 403,
      }),
    );

    expect(recovery.role).toBe("admin");
    for (const permission of RECOVERY_PERMISSIONS) {
      expect(requirePermission(recovery, permission)).toBe(recovery);
    }
    for (const permission of [
      "connectors.manage",
      "identities.manage",
      "media.view",
      "roles.manage",
      "sessions.revoke",
    ] as const) {
      expect(hasPermission(recovery, permission)).toBe(false);
    }
  });

  it("allows an active admin only through the same permission boundary", () => {
    const principal = activeAdmin();
    for (const permission of permissionSchema.options) {
      if (permission === "recovery.administrator.replace") {
        expect(() => requirePermission(principal, permission)).toThrow(
          expect.objectContaining<Partial<SafeHttpError>>({
            code: "permission_denied",
            statusCode: 403,
          }),
        );
      } else {
        expect(requirePermission(principal, permission)).toBe(principal);
      }
    }
    expect(ROLE_PERMISSIONS.admin).not.toContain("recovery.administrator.replace");
    expect(RECOVERY_PERMISSIONS).toContain("recovery.administrator.replace");
  });

  it("distinguishes an absent session from a denied capability", () => {
    expect(() => requirePermission(null, "media.view")).toThrow(
      expect.objectContaining<Partial<SafeHttpError>>({
        code: "authentication_required",
        statusCode: 401,
      }),
    );
  });

  it("uses the dedicated recovery capability for recovery-session revocation", () => {
    const active = activeAdmin();
    const recovery = recoveryPrincipal();

    expect(requireSelfSessionRevocation(active)).toBe(active);
    expect(requireSelfSessionRevocation(recovery)).toBe(recovery);
    expect(() =>
      requireSelfSessionRevocation({
        ...recovery,
        permissions: ["sessions.self.revoke"],
      }),
    ).toThrow(
      expect.objectContaining<Partial<SafeHttpError>>({
        code: "permission_denied",
        statusCode: 403,
      }),
    );
  });
});
