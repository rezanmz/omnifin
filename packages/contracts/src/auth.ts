import { z } from "zod";

export const AUTH_PROVIDERS_MAX_COUNT = 50;
export const AUTH_PROVIDERS_RESPONSE_MAX_BYTES = 1_048_576;
export const OIDC_ISSUER_MAX_LENGTH = 2_048;

const identifierSchema = z.string().trim().min(1).max(128);
const displayNameSchema = z.string().trim().min(1).max(160);
const oidcIssuerSchema = z
  .url()
  .max(OIDC_ISSUER_MAX_LENGTH)
  .refine((value) => {
    const issuer = new URL(value);
    return (
      issuer.protocol === "https:" &&
      !issuer.username &&
      !issuer.password &&
      !issuer.search &&
      !issuer.hash
    );
  }, "OIDC issuers must be HTTPS URLs without credentials, query parameters, or fragments");

export const roleSchema = z.enum(["viewer", "requester", "operator", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const permissionSchema = z.enum([
  "media.view",
  "playback.use",
  "request.create",
  "request.review",
  "acquisition.manage",
  "downloads.manage",
  "library.manage",
  "issue.manage",
  "connectors.manage",
  "identities.manage",
  "identities.self.manage",
  "roles.manage",
  "audit.view",
  "sessions.revoke",
  "sessions.self.revoke",
  "recovery.oidc.manage",
  "recovery.jellyfin.manage",
  "recovery.sessions.revoke",
]);
export type Permission = z.infer<typeof permissionSchema>;

export const PENDING_LINK_PERMISSIONS = [
  "identities.self.manage",
  "sessions.self.revoke",
] as const satisfies readonly Permission[];

export const RECOVERY_PERMISSIONS = [
  "recovery.oidc.manage",
  "recovery.jellyfin.manage",
  "recovery.sessions.revoke",
] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS = {
  viewer: ["media.view", "playback.use", "identities.self.manage", "sessions.self.revoke"],
  requester: [
    "media.view",
    "playback.use",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
  ],
  operator: [
    "media.view",
    "playback.use",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
    "request.review",
    "acquisition.manage",
    "downloads.manage",
    "library.manage",
    "issue.manage",
  ],
  admin: permissionSchema.options,
} as const satisfies Record<Role, readonly Permission[]>;

const oidcAuthProviderSchema = z.object({
  id: identifierSchema,
  kind: z.literal("oidc"),
  displayName: displayNameSchema,
  issuer: oidcIssuerSchema,
  state: z.enum(["available", "unavailable", "misconfigured"]),
  jitProvisioningEnabled: z.boolean(),
  supportsRpInitiatedLogout: z.boolean(),
  supportsFrontChannelLogout: z.boolean(),
  supportsBackChannelLogout: z.boolean(),
});

const jellyfinAuthProviderSchema = z.object({
  id: identifierSchema,
  kind: z.literal("jellyfin"),
  displayName: displayNameSchema,
  state: z.enum(["available", "unavailable", "misconfigured"]),
  passwordLoginAvailable: z.boolean(),
  quickConnectAvailable: z.boolean(),
  pairingRequiredAfterOidc: z.literal(true),
});

export const authProviderSchema = z.discriminatedUnion("kind", [
  oidcAuthProviderSchema,
  jellyfinAuthProviderSchema,
]);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export const externalIdentitySchema = z.object({
  providerId: identifierSchema,
  issuer: oidcIssuerSchema,
  subject: z.string().min(1).max(512),
  displayClaims: z.object({
    displayName: z.string().trim().min(1).max(160).optional(),
    preferredUsername: z.string().trim().min(1).max(160).optional(),
    email: z.email().optional(),
    emailVerified: z.boolean().optional(),
  }),
});
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;

export const serviceIdentityLinkSchema = z.object({
  id: identifierSchema,
  service: z.literal("jellyfin"),
  externalUserId: z.string().min(1).max(256).nullable(),
  displayName: displayNameSchema.nullable(),
  username: z.string().trim().min(1).max(160).nullable(),
  health: z.enum(["linked", "unavailable", "relink_required", "revoked"]),
  linkedAt: z.iso.datetime({ offset: true }).nullable(),
  lastVerifiedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ServiceIdentityLink = z.infer<typeof serviceIdentityLinkSchema>;

export const authenticationMethodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oidc"), providerId: identifierSchema }),
  z.object({ kind: z.literal("jellyfin") }),
  z.object({ kind: z.literal("recovery") }),
]);
export type AuthenticationMethod = z.infer<typeof authenticationMethodSchema>;

export const accountStateSchema = z.enum(["active", "pending_link", "recovery"]);
export type AccountState = z.infer<typeof accountStateSchema>;

export const sessionPrincipalSchema = z
  .object({
    sessionId: identifierSchema,
    accountState: accountStateSchema,
    userId: identifierSchema.nullable(),
    displayName: displayNameSchema,
    role: roleSchema,
    permissions: z.array(permissionSchema).max(permissionSchema.options.length),
    authenticationMethod: authenticationMethodSchema,
    externalIdentity: externalIdentitySchema.nullable(),
    linkedServices: z.array(serviceIdentityLinkSchema).max(16),
    issuedAt: z.iso.datetime({ offset: true }),
    inactivityExpiresAt: z.iso.datetime({ offset: true }),
    absoluteExpiresAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((principal, context) => {
    if (new Set(principal.permissions).size !== principal.permissions.length) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "Session permissions cannot contain duplicates.",
      });
    }
    const allowedPermissions = new Set<Permission>(ROLE_PERMISSIONS[principal.role]);
    for (const permission of principal.permissions) {
      if (!allowedPermissions.has(permission)) {
        context.addIssue({
          code: "custom",
          path: ["permissions"],
          message: `Permission ${permission} is not valid for role ${principal.role}.`,
        });
      }
    }

    if (principal.authenticationMethod.kind === "oidc") {
      if (principal.externalIdentity === null) {
        context.addIssue({
          code: "custom",
          path: ["externalIdentity"],
          message: "OIDC sessions require an external identity.",
        });
      } else if (
        principal.externalIdentity.providerId !== principal.authenticationMethod.providerId
      ) {
        context.addIssue({
          code: "custom",
          path: ["externalIdentity", "providerId"],
          message: "The external identity must match the OIDC authentication provider.",
        });
      }
    }
    if (principal.authenticationMethod.kind === "jellyfin" && principal.externalIdentity !== null) {
      context.addIssue({
        code: "custom",
        path: ["externalIdentity"],
        message: "Jellyfin sessions cannot have an OIDC external identity.",
      });
    }

    if (
      principal.accountState === "active" &&
      !principal.linkedServices.some(
        (link) =>
          link.externalUserId !== null &&
          (link.health === "linked" || link.health === "unavailable"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["linkedServices"],
        message: "Active accounts require an established Jellyfin identity link.",
      });
    }

    if (principal.accountState === "pending_link") {
      const pendingPermissions = new Set<Permission>(PENDING_LINK_PERMISSIONS);
      if (
        principal.permissions.length !== PENDING_LINK_PERMISSIONS.length ||
        principal.permissions.some((permission) => !pendingPermissions.has(permission))
      ) {
        context.addIssue({
          code: "custom",
          path: ["permissions"],
          message: "Pending-link accounts are limited to self-service permissions.",
        });
      }
      if (principal.authenticationMethod.kind === "recovery") {
        context.addIssue({
          code: "custom",
          path: ["authenticationMethod"],
          message: "Pending-link accounts cannot use recovery authentication.",
        });
      }
      if (principal.linkedServices.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["linkedServices"],
          message: "Pending-link accounts cannot already have a linked service.",
        });
      }
    }

    const isRecoveryAccount = principal.accountState === "recovery";
    const usesRecoveryAuthentication = principal.authenticationMethod.kind === "recovery";
    if (isRecoveryAccount) {
      const recoveryPermissions = new Set<Permission>(RECOVERY_PERMISSIONS);
      if (principal.userId !== null) {
        context.addIssue({
          code: "custom",
          path: ["userId"],
          message: "Recovery accounts cannot be associated with a user identity.",
        });
      }
      if (!usesRecoveryAuthentication) {
        context.addIssue({
          code: "custom",
          path: ["authenticationMethod"],
          message: "Recovery accounts require recovery authentication.",
        });
      }
      if (principal.role !== "admin") {
        context.addIssue({
          code: "custom",
          path: ["role"],
          message: "Recovery accounts require the admin role.",
        });
      }
      if (
        principal.permissions.length !== RECOVERY_PERMISSIONS.length ||
        principal.permissions.some((permission) => !recoveryPermissions.has(permission))
      ) {
        context.addIssue({
          code: "custom",
          path: ["permissions"],
          message: "Recovery accounts are limited to recovery permissions.",
        });
      }
      if (principal.externalIdentity !== null) {
        context.addIssue({
          code: "custom",
          path: ["externalIdentity"],
          message: "Recovery accounts cannot have an external identity.",
        });
      }
      if (principal.linkedServices.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["linkedServices"],
          message: "Recovery accounts cannot have linked services.",
        });
      }
    } else {
      if (principal.userId === null) {
        context.addIssue({
          code: "custom",
          path: ["userId"],
          message: "User sessions require a user identity.",
        });
      }
      if (usesRecoveryAuthentication) {
        context.addIssue({
          code: "custom",
          path: ["authenticationMethod"],
          message: "Recovery authentication is limited to recovery accounts.",
        });
      }
    }

    const issuedAt = Date.parse(principal.issuedAt);
    const inactivityExpiresAt = Date.parse(principal.inactivityExpiresAt);
    const absoluteExpiresAt = Date.parse(principal.absoluteExpiresAt);
    if (inactivityExpiresAt <= issuedAt || absoluteExpiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["inactivityExpiresAt"],
        message: "Session expiry must be later than session issuance.",
      });
    }
    if (inactivityExpiresAt > absoluteExpiresAt) {
      context.addIssue({
        code: "custom",
        path: ["inactivityExpiresAt"],
        message: "Inactivity expiry cannot exceed absolute expiry.",
      });
    }
  });
export type SessionPrincipal = z.infer<typeof sessionPrincipalSchema>;

const claimScalarSchema = z.union([z.string().min(1).max(512), z.number().finite(), z.boolean()]);
const blockedClaimPathSegments = new Set(["__proto__", "constructor", "prototype"]);
const claimPathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((segment) => !blockedClaimPathSegments.has(segment), "Unsafe claim path segment");

export const roleMappingSchema = z.object({
  id: identifierSchema,
  providerId: identifierSchema,
  claimPath: z.array(claimPathSegmentSchema).min(1).max(12),
  operator: z.enum(["equals", "contains_any", "contains_all"]),
  values: z.array(claimScalarSchema).min(1).max(64),
  role: roleSchema,
  priority: z.int().min(0).max(10_000),
  enabled: z.boolean(),
});
export type RoleMapping = z.infer<typeof roleMappingSchema>;

export const authProvidersResponseSchema = z.object({
  providers: z.array(authProviderSchema).max(AUTH_PROVIDERS_MAX_COUNT),
});
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;

export const csrfTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "CSRF tokens must use unpadded base64url characters");

export const sessionResponseSchema = z.union([
  z.object({
    principal: sessionPrincipalSchema,
    csrfToken: csrfTokenSchema,
  }),
  z.object({
    principal: z.null(),
    csrfToken: z.null(),
  }),
]);
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
