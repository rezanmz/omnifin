import {
  PENDING_BOOTSTRAP_ADMIN_PERMISSIONS,
  PENDING_LINK_PERMISSIONS,
  ROLE_PERMISSIONS,
} from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
import { buildSessionPrincipal, type SessionPrincipalRecord } from "../src/auth/principal.js";

const issuedAt = new Date("2026-07-25T12:00:00.000Z");
const now = new Date("2026-07-25T12:30:00.000Z");
const expiresAt = new Date("2026-07-25T13:00:00.000Z");
const absoluteExpiresAt = new Date("2026-07-26T12:00:00.000Z");

function oidcRecord(): SessionPrincipalRecord {
  return {
    session: {
      absoluteExpiresAt,
      authMethod: "oidc",
      createdAt: issuedAt,
      expiresAt,
      externalIdentityId: "identity-1",
      id: "session-1",
      oidcProviderId: "oidc-home",
      revokedAt: null,
      serviceIdentityLinkId: null,
      userId: "user-1",
    },
    user: {
      displayName: "Riley",
      id: "user-1",
      role: "viewer",
      roleSource: "default",
      status: "active",
    },
    externalIdentity: {
      displayClaimsJson: JSON.stringify({
        displayName: "Riley",
        email: "riley@example.test",
      }),
      id: "identity-1",
      issuer: "https://id.example.test/application/o/omnifin/",
      providerId: "oidc-home",
      subject: "subject-1",
      userId: "user-1",
    },
    oidcProvider: { enabled: true, id: "oidc-home" },
    serviceLink: {
      connectorId: "jellyfin-home",
      createdAt: issuedAt,
      externalDisplayName: "Riley",
      externalUserId: "jellyfin-user-1",
      externalUsername: "riley",
      healthState: "linked",
      id: "link-1",
      lastVerifiedAt: issuedAt,
      userId: "user-1",
    },
    serviceConnector: { enabled: true, id: "jellyfin-home", type: "jellyfin" },
  };
}

describe("buildSessionPrincipal", () => {
  it("grants role permissions only to active users with an established Jellyfin link", () => {
    expect(buildSessionPrincipal(oidcRecord(), now)).toMatchObject({
      accountState: "active",
      permissions: ROLE_PERMISSIONS.viewer,
      linkedServices: [{ health: "linked", id: "link-1" }],
    });

    const unavailable = oidcRecord();
    if (unavailable.serviceLink) unavailable.serviceLink.healthState = "unavailable";
    expect(buildSessionPrincipal(unavailable, now)).toMatchObject({ accountState: "active" });
  });

  it("lets only a recovery-proven pending OIDC admin configure the installation", () => {
    const record = oidcRecord();
    record.user = {
      ...record.user!,
      role: "admin",
      roleSource: "recovery_bootstrap",
      status: "pending_link",
    };
    record.serviceLink = null;
    record.serviceConnector = null;

    expect(buildSessionPrincipal(record, now)).toMatchObject({
      accountState: "pending_link",
      permissions: PENDING_BOOTSTRAP_ADMIN_PERMISSIONS,
      role: "admin",
    });
    expect(buildSessionPrincipal(record, now)?.permissions).not.toContain("media.view");
    expect(buildSessionPrincipal(record, now)?.permissions).not.toContain("playback.use");

    record.user.roleSource = "oidc_mapping";
    expect(buildSessionPrincipal(record, now)).toMatchObject({
      accountState: "pending_link",
      permissions: PENDING_LINK_PERMISSIONS,
    });
  });

  it("downgrades missing, revoked, or relink-required service identities to pairing-only access", () => {
    for (const health of ["relink_required", "revoked"] as const) {
      const record = oidcRecord();
      if (record.serviceLink) record.serviceLink.healthState = health;
      expect(buildSessionPrincipal(record, now)).toMatchObject({
        accountState: "pending_link",
        linkedServices: [],
        permissions: PENDING_LINK_PERMISSIONS,
      });
    }

    const missing = oidcRecord();
    missing.serviceLink = null;
    missing.serviceConnector = null;
    expect(buildSessionPrincipal(missing, now)).toMatchObject({ accountState: "pending_link" });
  });

  it("fails closed for disabled users and inconsistent OIDC attribution", () => {
    const disabled = oidcRecord();
    if (disabled.user) disabled.user.status = "disabled";
    expect(buildSessionPrincipal(disabled, now)).toBeNull();

    for (const mutate of [
      (record: SessionPrincipalRecord) => {
        record.session.oidcProviderId = "oidc-other";
      },
      (record: SessionPrincipalRecord) => {
        record.session.externalIdentityId = "identity-other";
      },
      (record: SessionPrincipalRecord) => {
        if (record.externalIdentity) record.externalIdentity.displayClaimsJson = "not-json";
      },
      (record: SessionPrincipalRecord) => {
        if (record.externalIdentity) record.externalIdentity.userId = "user-other";
      },
    ]) {
      const record = oidcRecord();
      mutate(record);
      expect(buildSessionPrincipal(record, now)).toBeNull();
    }

    const disabledProvider = oidcRecord();
    if (disabledProvider.oidcProvider) disabledProvider.oidcProvider.enabled = false;
    expect(buildSessionPrincipal(disabledProvider, now)).toBeNull();
  });

  it("does not activate access through a disabled or mismatched Jellyfin connector", () => {
    const disabledConnector = oidcRecord();
    if (disabledConnector.serviceConnector) disabledConnector.serviceConnector.enabled = false;
    expect(buildSessionPrincipal(disabledConnector, now)).toMatchObject({
      accountState: "pending_link",
      permissions: PENDING_LINK_PERMISSIONS,
    });

    const mismatchedConnector = oidcRecord();
    if (mismatchedConnector.serviceConnector) {
      mismatchedConnector.serviceConnector.id = "jellyfin-other";
    }
    expect(buildSessionPrincipal(mismatchedConnector, now)).toBeNull();
  });

  it("rejects revoked, expired, future-issued, and malformed session lifetimes", () => {
    const cases = [
      (record: SessionPrincipalRecord) => {
        record.session.revokedAt = now;
      },
      (record: SessionPrincipalRecord) => {
        record.session.expiresAt = now;
      },
      (record: SessionPrincipalRecord) => {
        record.session.absoluteExpiresAt = now;
      },
      (record: SessionPrincipalRecord) => {
        record.session.createdAt = new Date(now.getTime() + 1);
      },
      (record: SessionPrincipalRecord) => {
        record.session.expiresAt = new Date(Number.NaN);
      },
    ];

    for (const mutate of cases) {
      const record = oidcRecord();
      mutate(record);
      expect(buildSessionPrincipal(record, now)).toBeNull();
    }
  });

  it("constructs a restricted identity-free recovery principal", () => {
    const record = oidcRecord();
    record.session = {
      ...record.session,
      authMethod: "recovery",
      externalIdentityId: null,
      oidcProviderId: null,
      serviceIdentityLinkId: null,
      userId: null,
    };
    record.user = null;
    record.externalIdentity = null;
    record.oidcProvider = null;
    record.serviceLink = null;
    record.serviceConnector = null;

    expect(buildSessionPrincipal(record, now)).toMatchObject({
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
      linkedServices: [],
      role: "admin",
      userId: null,
    });

    expect(
      buildSessionPrincipal(
        {
          ...record,
          user: {
            displayName: "Unexpected user",
            id: "user-1",
            role: "admin",
            roleSource: "manual",
            status: "active",
          },
        },
        now,
      ),
    ).toBeNull();
  });

  it("accepts direct Jellyfin attribution only without an OIDC identity", () => {
    const record = oidcRecord();
    record.session.authMethod = "jellyfin";
    record.session.oidcProviderId = null;
    record.session.externalIdentityId = null;
    record.session.serviceIdentityLinkId = "link-1";
    record.externalIdentity = null;
    record.oidcProvider = null;
    expect(buildSessionPrincipal(record, now)).toMatchObject({
      authenticationMethod: { kind: "jellyfin" },
    });

    if (record.serviceConnector) record.serviceConnector.enabled = false;
    expect(buildSessionPrincipal(record, now)).toBeNull();

    const confused = oidcRecord();
    confused.session.authMethod = "jellyfin";
    confused.session.oidcProviderId = null;
    expect(buildSessionPrincipal(confused, now)).toBeNull();
  });
});
