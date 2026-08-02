import {
  PENDING_BOOTSTRAP_ADMIN_PERMISSIONS,
  PENDING_LINK_PERMISSIONS,
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type Role,
  type SessionPrincipal,
  sessionPrincipalSchema,
} from "@omnifin/contracts/auth";

type NormalAuthMethod = "jellyfin" | "oidc";
type LinkHealth = "linked" | "relink_required" | "revoked" | "unavailable";

export interface SessionPrincipalRecord {
  session: {
    absoluteExpiresAt: Date;
    authMethod: "jellyfin" | "oidc" | "recovery";
    createdAt: Date;
    expiresAt: Date;
    externalIdentityId: string | null;
    id: string;
    oidcProviderId: string | null;
    revokedAt: Date | null;
    serviceIdentityLinkId: string | null;
    userId: string | null;
  };
  user: {
    displayName: string;
    id: string;
    role: Role;
    roleSource: "default" | "manual" | "oidc_mapping" | "recovery_bootstrap";
    status: "active" | "disabled" | "pending_link";
  } | null;
  externalIdentity: {
    displayClaimsJson: string;
    id: string;
    issuer: string;
    providerId: string;
    subject: string;
    userId: string;
  } | null;
  oidcProvider: {
    enabled: boolean;
    id: string;
  } | null;
  serviceLink: {
    connectorId: string | null;
    createdAt: Date;
    externalDisplayName: string;
    externalUserId: string;
    externalUsername: string;
    healthState: LinkHealth;
    id: string;
    lastVerifiedAt: Date | null;
    userId: string;
  } | null;
  serviceConnector: {
    enabled: boolean;
    id: string;
    type: "jellyfin";
  } | null;
}

function authenticationMethod(record: SessionPrincipalRecord) {
  if (record.session.authMethod === "recovery") return { kind: "recovery" as const };
  if (record.session.authMethod === "jellyfin") return { kind: "jellyfin" as const };
  if (!record.session.oidcProviderId) return undefined;
  return { kind: "oidc" as const, providerId: record.session.oidcProviderId };
}

function externalIdentity(record: SessionPrincipalRecord) {
  const identity = record.externalIdentity;
  if (!identity) return null;
  let displayClaims: unknown;
  try {
    displayClaims = JSON.parse(identity.displayClaimsJson);
  } catch {
    return undefined;
  }
  return {
    displayClaims,
    issuer: identity.issuer,
    providerId: identity.providerId,
    subject: identity.subject,
  };
}

function linkAttributionIsConsistent(record: SessionPrincipalRecord) {
  const link = record.serviceLink;
  const connector = record.serviceConnector;
  if (!link) return connector === null;
  if (link.connectorId === null) return connector === null;
  return connector?.id === link.connectorId && connector.type === "jellyfin";
}

function hasUsableLink(record: SessionPrincipalRecord, userId: string) {
  const health = record.serviceLink?.healthState;
  return (
    record.serviceLink?.userId === userId &&
    record.serviceConnector?.enabled === true &&
    (health === "linked" || health === "unavailable")
  );
}

function normalPrincipal(record: SessionPrincipalRecord): SessionPrincipal | null {
  const user = record.user;
  const method = authenticationMethod(record);
  const identity = externalIdentity(record);
  if (!user || user.status === "disabled" || !method || method.kind === "recovery") return null;
  if (record.session.userId !== user.id) return null;
  if (!linkAttributionIsConsistent(record)) return null;
  if (method.kind === "oidc") {
    if (
      !identity ||
      record.oidcProvider?.enabled !== true ||
      record.oidcProvider.id !== method.providerId ||
      record.session.externalIdentityId !== record.externalIdentity?.id ||
      record.externalIdentity?.userId !== user.id
    ) {
      return null;
    }
  } else {
    if (
      identity !== null ||
      record.oidcProvider !== null ||
      record.session.externalIdentityId !== null
    )
      return null;
    if (record.session.serviceIdentityLinkId !== record.serviceLink?.id) return null;
    if (!hasUsableLink(record, user.id)) return null;
  }

  const active = user.status === "active" && hasUsableLink(record, user.id);
  const serviceLink = active && record.serviceLink ? record.serviceLink : undefined;
  const candidate = {
    absoluteExpiresAt: record.session.absoluteExpiresAt.toISOString(),
    accountState: active ? ("active" as const) : ("pending_link" as const),
    authenticationMethod: method as { kind: NormalAuthMethod; providerId?: string },
    displayName: user.displayName,
    externalIdentity: identity,
    inactivityExpiresAt: record.session.expiresAt.toISOString(),
    issuedAt: record.session.createdAt.toISOString(),
    linkedServices: serviceLink
      ? [
          {
            displayName: serviceLink.externalDisplayName,
            externalUserId: serviceLink.externalUserId,
            health: serviceLink.healthState as "linked" | "unavailable",
            id: serviceLink.id,
            lastVerifiedAt: serviceLink.lastVerifiedAt?.toISOString() ?? null,
            linkedAt: serviceLink.createdAt.toISOString(),
            service: "jellyfin" as const,
            username: serviceLink.externalUsername,
          },
        ]
      : [],
    permissions: active
      ? [...ROLE_PERMISSIONS[user.role]]
      : user.role === "admin" && user.roleSource === "recovery_bootstrap" && method.kind === "oidc"
        ? [...PENDING_BOOTSTRAP_ADMIN_PERMISSIONS]
        : [...PENDING_LINK_PERMISSIONS],
    role: user.role,
    sessionId: record.session.id,
    userId: user.id,
  };
  const parsed = sessionPrincipalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function buildSessionPrincipal(
  record: SessionPrincipalRecord,
  now: Date,
): SessionPrincipal | null {
  const createdAt = record.session.createdAt.getTime();
  const inactivityExpiresAt = record.session.expiresAt.getTime();
  const absoluteExpiresAt = record.session.absoluteExpiresAt.getTime();
  const nowTime = now.getTime();
  if (
    ![createdAt, inactivityExpiresAt, absoluteExpiresAt, nowTime].every(Number.isFinite) ||
    record.session.revokedAt !== null ||
    createdAt >= inactivityExpiresAt ||
    inactivityExpiresAt > absoluteExpiresAt ||
    nowTime < createdAt ||
    nowTime >= inactivityExpiresAt ||
    nowTime >= absoluteExpiresAt
  ) {
    return null;
  }
  if (record.session.authMethod !== "recovery") return normalPrincipal(record);
  if (
    record.session.userId !== null ||
    record.session.oidcProviderId !== null ||
    record.session.externalIdentityId !== null ||
    record.session.serviceIdentityLinkId !== null ||
    record.user !== null ||
    record.externalIdentity !== null ||
    record.oidcProvider !== null ||
    record.serviceLink !== null ||
    record.serviceConnector !== null
  ) {
    return null;
  }

  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: record.session.absoluteExpiresAt.toISOString(),
    accountState: "recovery",
    authenticationMethod: { kind: "recovery" },
    displayName: "Recovery access",
    externalIdentity: null,
    inactivityExpiresAt: record.session.expiresAt.toISOString(),
    issuedAt: record.session.createdAt.toISOString(),
    linkedServices: [],
    permissions: [...RECOVERY_PERMISSIONS],
    role: "admin",
    sessionId: record.session.id,
    userId: null,
  });
}
