import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(128);
const displayNameSchema = z.string().trim().min(1).max(160);
const oidcIssuerSchema = z.url().refine((value) => {
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
  "roles.manage",
  "audit.view",
  "sessions.revoke",
]);
export type Permission = z.infer<typeof permissionSchema>;

export const ROLE_PERMISSIONS = {
  viewer: ["media.view", "playback.use"],
  requester: ["media.view", "playback.use", "request.create"],
  operator: [
    "media.view",
    "playback.use",
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
  health: z.enum(["linked", "pending", "unavailable", "relink_required", "revoked"]),
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

export const sessionPrincipalSchema = z
  .object({
    userId: identifierSchema,
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
  providers: z.array(authProviderSchema).max(50),
});
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;

export const sessionResponseSchema = z.object({
  principal: sessionPrincipalSchema.nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
