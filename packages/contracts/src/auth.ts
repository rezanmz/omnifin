import { z } from "zod";

export const AUTH_PROVIDERS_MAX_COUNT = 50;
export const AUTH_USERS_PAGE_MAX_COUNT = 50;
export const AUTH_PROVIDERS_RESPONSE_MAX_BYTES = 1_048_576;
export const OIDC_ISSUER_MAX_LENGTH = 2_048;
export const OIDC_ROLE_MAPPINGS_MAX_COUNT = 512;

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

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

const oidcEndpointOriginSchema = z
  .url()
  .max(4_096)
  .refine((value) => {
    const origin = new URL(value);
    return (
      origin.protocol === "https:" &&
      !origin.username &&
      !origin.password &&
      origin.origin === value &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash
    );
  }, "OIDC endpoint origins must be canonical HTTPS origins");

export const oidcTokenEndpointAuthMethodSchema = z.enum([
  "client_secret_basic",
  "client_secret_post",
  "none",
]);
export type OidcTokenEndpointAuthMethod = z.infer<typeof oidcTokenEndpointAuthMethodSchema>;

export const oidcIdTokenSigningAlgSchema = z.enum([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);
export type OidcIdTokenSigningAlg = z.infer<typeof oidcIdTokenSigningAlgSchema>;

const oidcScopeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/u, "OIDC scopes must use visible token characters");
const oidcScopesSchema = z
  .array(oidcScopeSchema)
  .min(1)
  .max(32)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: "custom", message: "OIDC scopes cannot contain duplicates." });
    }
    if (!scopes.includes("openid")) {
      context.addIssue({ code: "custom", message: "OIDC scopes must include openid." });
    }
    if (scopes.some((scope) => scope.toLowerCase() === "offline_access")) {
      context.addIssue({ code: "custom", message: "OIDC scopes cannot request offline access." });
    }
  });
const oidcClientIdSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim() === value && !/[\u0000-\u001F\u007F-\u009F]/u.test(value))
  .refine((value) => new TextEncoder().encode(value).length <= 1_024);
const oidcClientSecretSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => new TextEncoder().encode(value).length <= 4_096);

export const roleSchema = z.enum(["viewer", "requester", "operator", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const permissionSchema = z.enum([
  "media.view",
  "media.download",
  "playback.use",
  "playback.history.self.manage",
  "saved.lists.self.manage",
  "favorites.self.manage",
  "request.create",
  "request.review",
  "acquisition.manage",
  "downloads.manage",
  "library.manage",
  "library.delete",
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
  "recovery.administrator.replace",
  "recovery.sessions.revoke",
]);
export type Permission = z.infer<typeof permissionSchema>;

export const PENDING_LINK_PERMISSIONS = [
  "identities.self.manage",
  "sessions.self.revoke",
] as const satisfies readonly Permission[];

/**
 * A recovery-proven first administrator may finish configuring identity and
 * service connections before pairing Jellyfin. Media and upstream mutation
 * permissions remain unavailable until that explicit pairing succeeds.
 */
export const PENDING_BOOTSTRAP_ADMIN_PERMISSIONS = [
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
] as const satisfies readonly Permission[];

export const RECOVERY_PERMISSIONS = [
  "recovery.oidc.manage",
  "recovery.jellyfin.manage",
  "recovery.administrator.replace",
  "recovery.sessions.revoke",
] as const satisfies readonly Permission[];

const NORMAL_ADMIN_PERMISSIONS = permissionSchema.options.filter(
  (permission) => permission !== "recovery.administrator.replace",
) as Exclude<Permission, "recovery.administrator.replace">[];

export const ROLE_PERMISSIONS = {
  viewer: [
    "media.view",
    "playback.use",
    "playback.history.self.manage",
    "saved.lists.self.manage",
    "favorites.self.manage",
    "identities.self.manage",
    "sessions.self.revoke",
  ],
  requester: [
    "media.view",
    "playback.use",
    "playback.history.self.manage",
    "saved.lists.self.manage",
    "favorites.self.manage",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
  ],
  operator: [
    "media.view",
    "playback.use",
    "playback.history.self.manage",
    "saved.lists.self.manage",
    "favorites.self.manage",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
    "request.review",
    "acquisition.manage",
    "downloads.manage",
    "library.manage",
    "issue.manage",
  ],
  admin: NORMAL_ADMIN_PERMISSIONS,
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

const oidcProviderConfigurationShape = {
  allowJitProvisioning: z.boolean(),
  approvedEndpointOrigins: z.array(oidcEndpointOriginSchema).min(1).max(16),
  clientId: oidcClientIdSchema,
  clientSecret: oidcClientSecretSchema.optional(),
  displayName: displayNameSchema,
  enabled: z.boolean(),
  idTokenSigningAlg: oidcIdTokenSigningAlgSchema,
  issuer: oidcIssuerSchema,
  scopes: oidcScopesSchema,
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
  tokenEndpointAuthMethod: oidcTokenEndpointAuthMethodSchema,
} as const;

function validateOidcProviderConfiguration(
  provider: z.infer<z.ZodObject<typeof oidcProviderConfigurationShape>>,
  context: z.RefinementCtx,
) {
  if (provider.tokenEndpointAuthMethod === "none" && provider.clientSecret !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Public OIDC clients cannot retain a client secret.",
      path: ["clientSecret"],
    });
  }
  const issuerOrigin = new URL(provider.issuer).origin;
  if (!provider.approvedEndpointOrigins.includes(issuerOrigin)) {
    context.addIssue({
      code: "custom",
      message: "Approved endpoint origins must include the issuer origin.",
      path: ["approvedEndpointOrigins"],
    });
  }
  if (new Set(provider.approvedEndpointOrigins).size !== provider.approvedEndpointOrigins.length) {
    context.addIssue({
      code: "custom",
      message: "Approved endpoint origins cannot contain duplicates.",
      path: ["approvedEndpointOrigins"],
    });
  }
}

export const oidcProviderCreateRequestSchema = z
  .strictObject(oidcProviderConfigurationShape)
  .superRefine((provider, context) => {
    validateOidcProviderConfiguration(provider, context);
    if (provider.tokenEndpointAuthMethod !== "none" && provider.clientSecret === undefined) {
      context.addIssue({
        code: "custom",
        message: "Confidential OIDC clients require a client secret.",
        path: ["clientSecret"],
      });
    }
  });
export type OidcProviderCreateRequest = z.infer<typeof oidcProviderCreateRequestSchema>;

// A confidential update may omit clientSecret to retain the encrypted value already stored.
export const oidcProviderUpdateRequestSchema = z
  .strictObject(oidcProviderConfigurationShape)
  .superRefine(validateOidcProviderConfiguration);
export type OidcProviderUpdateRequest = z.infer<typeof oidcProviderUpdateRequestSchema>;

export const oidcProviderAdminSchema = z.strictObject({
  allowJitProvisioning: z.boolean(),
  approvedEndpointOrigins: z.array(oidcEndpointOriginSchema).min(1).max(16),
  clientId: oidcClientIdSchema,
  clientSecretConfigured: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  discoveryCheckedAt: z.iso.datetime({ offset: true }).nullable(),
  discoveryState: z.enum(["unchecked", "ready", "failed"]),
  displayName: displayNameSchema,
  enabled: z.boolean(),
  id: identifierSchema,
  idTokenSigningAlg: oidcIdTokenSigningAlgSchema,
  issuer: oidcIssuerSchema,
  scopes: oidcScopesSchema,
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
  tokenEndpointAuthMethod: oidcTokenEndpointAuthMethodSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OidcProviderAdmin = z.infer<typeof oidcProviderAdminSchema>;

export const oidcProviderCapabilitiesSchema = z.strictObject({
  authorizationCodeFlow: z.literal(true),
  idTokenSigningAlg: oidcIdTokenSigningAlgSchema,
  logout: z.strictObject({
    backChannel: z.boolean(),
    backChannelSession: z.boolean(),
    frontChannel: z.boolean(),
    frontChannelSession: z.boolean(),
    rpInitiated: z.boolean(),
  }),
  pkceS256: z.literal(true),
  schemaVersion: z.literal(1),
  tokenEndpointAuthMethod: oidcTokenEndpointAuthMethodSchema,
  userInfo: z.boolean(),
});
export type OidcProviderCapabilities = z.infer<typeof oidcProviderCapabilitiesSchema>;

export const oidcProviderValidationParamsSchema = z.strictObject({
  providerId: identifierSchema,
});
export type OidcProviderValidationParams = z.infer<typeof oidcProviderValidationParamsSchema>;

export const oidcProviderValidationResponseSchema = z.strictObject({
  capabilities: oidcProviderCapabilitiesSchema,
  provider: oidcProviderAdminSchema,
});
export type OidcProviderValidationResponse = z.infer<typeof oidcProviderValidationResponseSchema>;

export const oidcProvidersAdminResponseSchema = z.strictObject({
  providers: z.array(oidcProviderAdminSchema).max(AUTH_PROVIDERS_MAX_COUNT),
});
export type OidcProvidersAdminResponse = z.infer<typeof oidcProvidersAdminResponseSchema>;

const oidcProviderRevokedSessionsSchema = z.int().min(0).max(2_147_483_647);

export const oidcProviderMutationResponseSchema = z.strictObject({
  provider: oidcProviderAdminSchema,
  revokedSessions: oidcProviderRevokedSessionsSchema,
});
export type OidcProviderMutationResponse = z.infer<typeof oidcProviderMutationResponseSchema>;

export const oidcProviderDeleteResponseSchema = z.strictObject({
  deletedProviderId: identifierSchema,
  deletedRoleMappings: z.int().min(0).max(OIDC_ROLE_MAPPINGS_MAX_COUNT),
  revokedSessions: oidcProviderRevokedSessionsSchema,
});
export type OidcProviderDeleteResponse = z.infer<typeof oidcProviderDeleteResponseSchema>;

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

export const identityLinksResponseSchema = z.strictObject({
  links: z.array(serviceIdentityLinkSchema).max(1),
});
export type IdentityLinksResponse = z.infer<typeof identityLinksResponseSchema>;

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
    const allowedPermissions = new Set<Permission>(
      principal.accountState === "recovery"
        ? RECOVERY_PERMISSIONS
        : ROLE_PERMISSIONS[principal.role],
    );
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
      const bootstrapAdminPermissions = new Set<Permission>(PENDING_BOOTSTRAP_ADMIN_PERMISSIONS);
      const hasSelfServicePermissions =
        principal.permissions.length === PENDING_LINK_PERMISSIONS.length &&
        principal.permissions.every((permission) => pendingPermissions.has(permission));
      const hasBootstrapAdminPermissions =
        principal.role === "admin" &&
        principal.authenticationMethod.kind === "oidc" &&
        principal.permissions.length === PENDING_BOOTSTRAP_ADMIN_PERMISSIONS.length &&
        principal.permissions.every((permission) => bootstrapAdminPermissions.has(permission));
      if (!hasSelfServicePermissions && !hasBootstrapAdminPermissions) {
        context.addIssue({
          code: "custom",
          path: ["permissions"],
          message:
            "Pending-link accounts are limited to self-service or recovery-proven administration permissions.",
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

export const userRoleSourceSchema = z.enum([
  "default",
  "oidc_mapping",
  "manual",
  "recovery_bootstrap",
]);
export type UserRoleSource = z.infer<typeof userRoleSourceSchema>;

export const userAccountStatusSchema = z.enum(["active", "pending_link", "disabled"]);
export type UserAccountStatus = z.infer<typeof userAccountStatusSchema>;

const userAuthenticationMethodSchema = z.enum(["jellyfin", "oidc"]);

export const userAccessSummarySchema = z
  .strictObject({
    activeSessions: z.int().min(0).max(2_147_483_647),
    authenticationMethods: z.array(userAuthenticationMethodSchema).max(2),
    createdAt: z.iso.datetime({ offset: true }),
    displayName: displayNameSchema,
    id: identifierSchema,
    jellyfinLinkHealth: z.enum(["linked", "unavailable", "relink_required", "revoked"]).nullable(),
    lastActiveAt: z.iso.datetime({ offset: true }).nullable(),
    role: roleSchema,
    roleSource: userRoleSourceSchema,
    status: userAccountStatusSchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((user, context) => {
    if (new Set(user.authenticationMethods).size !== user.authenticationMethods.length) {
      context.addIssue({
        code: "custom",
        message: "Authentication methods cannot contain duplicates.",
        path: ["authenticationMethods"],
      });
    }
    if ((user.jellyfinLinkHealth === null) === user.authenticationMethods.includes("jellyfin")) {
      context.addIssue({
        code: "custom",
        message: "Jellyfin authentication requires a normalized link health state.",
        path: ["jellyfinLinkHealth"],
      });
    }
    if (Date.parse(user.updatedAt) < Date.parse(user.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "User updates cannot predate account creation.",
        path: ["updatedAt"],
      });
    }
  });
export type UserAccessSummary = z.infer<typeof userAccessSummarySchema>;

export const userAccessListQuerySchema = z.strictObject({
  cursor: identifierSchema.optional(),
});
export type UserAccessListQuery = z.infer<typeof userAccessListQuerySchema>;

export const userAccessListResponseSchema = z.strictObject({
  nextCursor: identifierSchema.nullable(),
  users: z.array(userAccessSummarySchema).max(AUTH_USERS_PAGE_MAX_COUNT),
});
export type UserAccessListResponse = z.infer<typeof userAccessListResponseSchema>;

export const userAccessMutationParamsSchema = z.strictObject({ userId: identifierSchema });
export type UserAccessMutationParams = z.infer<typeof userAccessMutationParamsSchema>;

export const userAccessMutationRequestSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    role: roleSchema.optional(),
  })
  .superRefine((mutation, context) => {
    if (mutation.enabled === undefined && mutation.role === undefined) {
      context.addIssue({
        code: "custom",
        message: "A role or account-state change is required.",
      });
    }
  });
export type UserAccessMutationRequest = z.infer<typeof userAccessMutationRequestSchema>;

export const userAccessMutationResponseSchema = z.strictObject({
  revokedSessions: z.int().min(0).max(2_147_483_647),
  user: userAccessSummarySchema,
});
export type UserAccessMutationResponse = z.infer<typeof userAccessMutationResponseSchema>;

export const ADMINISTRATOR_RECOVERY_CONFIRMATION = "REPLACE ADMINISTRATOR" as const;

export const administratorRecoveryPreviewRequestSchema = z.strictObject({});
export type AdministratorRecoveryPreviewRequest = z.infer<
  typeof administratorRecoveryPreviewRequestSchema
>;

export const administratorRecoveryTargetSchema = z.strictObject({
  administratorId: identifierSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});
export type AdministratorRecoveryTarget = z.infer<typeof administratorRecoveryTargetSchema>;

export const administratorRecoveryConfirmationRequestSchema = z.strictObject({
  administratorId: identifierSchema,
  confirmation: z.literal(ADMINISTRATOR_RECOVERY_CONFIRMATION),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});
export type AdministratorRecoveryConfirmationRequest = z.infer<
  typeof administratorRecoveryConfirmationRequestSchema
>;

const administratorRecoveryAuthenticationMethodSchema = z.enum(["jellyfin", "oidc"]);

export const administratorRecoveryPreviewAdministratorSchema = z
  .strictObject({
    activeSessions: z.int().min(0).max(2_147_483_647),
    authenticationMethods: z.array(administratorRecoveryAuthenticationMethodSchema).max(2),
    displayName: displayNameSchema,
    id: identifierSchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((administrator, context) => {
    if (
      new Set(administrator.authenticationMethods).size !==
      administrator.authenticationMethods.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Administrator authentication methods cannot contain duplicates.",
        path: ["authenticationMethods"],
      });
    }
  });
export type AdministratorRecoveryPreviewAdministrator = z.infer<
  typeof administratorRecoveryPreviewAdministratorSchema
>;

export const administratorRecoveryPreviewResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    administrator: administratorRecoveryPreviewAdministratorSchema,
    status: z.literal("available"),
  }),
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("denied") }),
]);
export type AdministratorRecoveryPreviewResponse = z.infer<
  typeof administratorRecoveryPreviewResponseSchema
>;

export const administratorRecoveryJellyfinPasswordRequestSchema = z.strictObject({
  administratorId: identifierSchema,
  confirmation: z.literal(ADMINISTRATOR_RECOVERY_CONFIRMATION),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  password: z.string().min(1).max(1_024),
  username: z.string().trim().min(1).max(160),
});
export type AdministratorRecoveryJellyfinPasswordRequest = z.infer<
  typeof administratorRecoveryJellyfinPasswordRequestSchema
>;

const administratorRecoveryRevokedSessionsSchema = z.strictObject({
  recovery: z.int().min(0).max(2_147_483_647),
  replacement: z.int().min(0).max(2_147_483_647),
  target: z.int().min(0).max(2_147_483_647),
});

const administratorRecoveryCsrfTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "CSRF tokens must use unpadded base64url characters");

export const administratorRecoveryReplacementResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    csrfToken: administratorRecoveryCsrfTokenSchema,
    revokedSessions: administratorRecoveryRevokedSessionsSchema,
    status: z.literal("replaced"),
  }),
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("denied") }),
]);
export type AdministratorRecoveryReplacementResponse = z.infer<
  typeof administratorRecoveryReplacementResponseSchema
>;

export const administratorRecoveryQuickConnectPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    expiresAt: z.iso.datetime({ offset: true }),
    pollAfterMs: z.int().min(1_000).max(30_000),
    status: z.literal("pending"),
  }),
  z.strictObject({ status: z.literal("expired") }),
  ...administratorRecoveryReplacementResponseSchema.options,
]);
export type AdministratorRecoveryQuickConnectPollResponse = z.infer<
  typeof administratorRecoveryQuickConnectPollResponseSchema
>;

export const oidcAdministratorReplacementStartResponseSchema = z.strictObject({
  authorizationUrl: z.url().max(16_384),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type OidcAdministratorReplacementStartResponse = z.infer<
  typeof oidcAdministratorReplacementStartResponseSchema
>;

// Descriptive aliases retained for callers that name the ceremony rather than the recovery actor.
export const administratorReplacementTargetSchema = administratorRecoveryTargetSchema;
export const administratorReplacementConfirmationRequestSchema =
  administratorRecoveryConfirmationRequestSchema;
export const administratorReplacementPreviewResponseSchema =
  administratorRecoveryPreviewResponseSchema;
export const administratorReplacementResponseSchema =
  administratorRecoveryReplacementResponseSchema;

const claimScalarSchema = z.union([z.string().min(1).max(512), z.number().finite(), z.boolean()]);
const blockedClaimPathSegments = new Set(["__proto__", "constructor", "prototype"]);
const claimPathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((segment) => !blockedClaimPathSegments.has(segment), "Unsafe claim path segment");

const roleMappingConfigurationShape = {
  claimPath: z.array(claimPathSegmentSchema).min(1).max(12),
  enabled: z.boolean(),
  operator: z.enum(["equals", "contains_any", "contains_all"]),
  priority: z.int().min(0).max(10_000),
  role: roleSchema,
  values: z.array(claimScalarSchema).min(1).max(64),
} as const;

export const roleMappingSchema = z.strictObject({
  ...roleMappingConfigurationShape,
  id: identifierSchema,
  providerId: identifierSchema,
});
export type RoleMapping = z.infer<typeof roleMappingSchema>;

export const oidcRoleMappingCreateRequestSchema = z
  .strictObject(roleMappingConfigurationShape)
  .superRefine((mapping, context) => {
    const keys = mapping.values.map((value) => `${typeof value}:${JSON.stringify(value)}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Role mapping values cannot contain duplicates.",
        path: ["values"],
      });
    }
  });
export type OidcRoleMappingCreateRequest = z.infer<typeof oidcRoleMappingCreateRequestSchema>;

export const oidcRoleMappingUpdateRequestSchema = oidcRoleMappingCreateRequestSchema;
export type OidcRoleMappingUpdateRequest = z.infer<typeof oidcRoleMappingUpdateRequestSchema>;

export const oidcRoleMappingsAdminParamsSchema = z.strictObject({
  providerId: identifierSchema,
});
export type OidcRoleMappingsAdminParams = z.infer<typeof oidcRoleMappingsAdminParamsSchema>;

export const oidcRoleMappingAdminParamsSchema = z.strictObject({
  mappingId: identifierSchema,
  providerId: identifierSchema,
});
export type OidcRoleMappingAdminParams = z.infer<typeof oidcRoleMappingAdminParamsSchema>;

export const oidcRoleMappingsAdminResponseSchema = z.strictObject({
  mappings: z.array(roleMappingSchema).max(OIDC_ROLE_MAPPINGS_MAX_COUNT),
});
export type OidcRoleMappingsAdminResponse = z.infer<typeof oidcRoleMappingsAdminResponseSchema>;

const revokedSessionsSchema = z.int().min(0).max(2_147_483_647);

export const oidcRoleMappingMutationResponseSchema = z.strictObject({
  mapping: roleMappingSchema,
  revokedSessions: revokedSessionsSchema,
});
export type OidcRoleMappingMutationResponse = z.infer<typeof oidcRoleMappingMutationResponseSchema>;

export const oidcRoleMappingDeleteResponseSchema = z.strictObject({
  deletedMappingId: identifierSchema,
  revokedSessions: revokedSessionsSchema,
});
export type OidcRoleMappingDeleteResponse = z.infer<typeof oidcRoleMappingDeleteResponseSchema>;

export const authProvidersResponseSchema = z.object({
  providers: z.array(authProviderSchema).max(AUTH_PROVIDERS_MAX_COUNT),
});
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;

export const csrfTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "CSRF tokens must use unpadded base64url characters");

export const jellyfinPasswordAuthenticationRequestSchema = z.strictObject({
  password: z.string().min(1).max(1_024),
  username: z.string().trim().min(1).max(160),
});
export type JellyfinPasswordAuthenticationRequest = z.infer<
  typeof jellyfinPasswordAuthenticationRequestSchema
>;

export const jellyfinPasswordPairingRequestSchema = jellyfinPasswordAuthenticationRequestSchema;
export type JellyfinPasswordPairingRequest = z.infer<typeof jellyfinPasswordPairingRequestSchema>;

export const authenticatedSessionResponseSchema = z.object({
  principal: sessionPrincipalSchema,
  csrfToken: csrfTokenSchema,
  theme: themePreferenceSchema.optional(),
});
export type AuthenticatedSessionResponse = z.infer<typeof authenticatedSessionResponseSchema>;

export const jellyfinIdentityPairingResponseSchema = authenticatedSessionResponseSchema;
export type JellyfinIdentityPairingResponse = z.infer<typeof jellyfinIdentityPairingResponseSchema>;

export const identityLinkRevocationResponseSchema = z
  .strictObject({
    link: serviceIdentityLinkSchema,
    principal: sessionPrincipalSchema.nullable(),
  })
  .superRefine((response, context) => {
    if (response.link.health !== "revoked") {
      context.addIssue({
        code: "custom",
        message: "A revocation response requires a revoked service link.",
        path: ["link", "health"],
      });
    }
    if (
      response.principal !== null &&
      (response.principal.accountState !== "pending_link" ||
        response.principal.authenticationMethod.kind !== "oidc")
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a reduced OIDC session may remain after link revocation.",
        path: ["principal"],
      });
    }
  });
export type IdentityLinkRevocationResponse = z.infer<typeof identityLinkRevocationResponseSchema>;

export const jellyfinQuickConnectInitiationRequestSchema = z.strictObject({});
export type JellyfinQuickConnectInitiationRequest = z.infer<
  typeof jellyfinQuickConnectInitiationRequestSchema
>;

export const jellyfinQuickConnectInitiationResponseSchema = z.strictObject({
  transactionId: identifierSchema,
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/),
  expiresAt: z.iso.datetime({ offset: true }),
  pollAfterMs: z.int().min(1_000).max(30_000),
});
export type JellyfinQuickConnectInitiationResponse = z.infer<
  typeof jellyfinQuickConnectInitiationResponseSchema
>;

export const jellyfinQuickConnectPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    expiresAt: z.iso.datetime({ offset: true }),
    pollAfterMs: z.int().min(1_000).max(30_000),
  }),
  authenticatedSessionResponseSchema.extend({ status: z.literal("signed_in") }).strict(),
  z.strictObject({
    status: z.literal("expired"),
  }),
]);
export type JellyfinQuickConnectPollResponse = z.infer<
  typeof jellyfinQuickConnectPollResponseSchema
>;

const pairedOidcPrincipalSchema = sessionPrincipalSchema.refine(
  (principal) =>
    principal.accountState === "active" && principal.authenticationMethod.kind === "oidc",
  "Quick Connect pairing requires an active OIDC-attributed principal",
);

export const jellyfinQuickConnectPairingPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    expiresAt: z.iso.datetime({ offset: true }),
    pollAfterMs: z.int().min(1_000).max(30_000),
  }),
  z.strictObject({
    status: z.literal("paired"),
    principal: pairedOidcPrincipalSchema,
    csrfToken: csrfTokenSchema,
  }),
  z.strictObject({
    status: z.literal("expired"),
  }),
]);
export type JellyfinQuickConnectPairingPollResponse = z.infer<
  typeof jellyfinQuickConnectPairingPollResponseSchema
>;

const bootstrappedJellyfinAdminPrincipalSchema = sessionPrincipalSchema.refine(
  (principal) =>
    principal.accountState === "active" &&
    principal.authenticationMethod.kind === "jellyfin" &&
    principal.role === "admin",
  "Administrator bootstrap requires an active Jellyfin-attributed admin principal",
);

export const jellyfinQuickConnectBootstrapPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    expiresAt: z.iso.datetime({ offset: true }),
    pollAfterMs: z.int().min(1_000).max(30_000),
  }),
  z.strictObject({
    status: z.literal("bootstrapped"),
    principal: bootstrappedJellyfinAdminPrincipalSchema,
    csrfToken: csrfTokenSchema,
  }),
  z.strictObject({
    status: z.literal("expired"),
  }),
]);
export type JellyfinQuickConnectBootstrapPollResponse = z.infer<
  typeof jellyfinQuickConnectBootstrapPollResponseSchema
>;

export const oidcAdministratorBootstrapStartResponseSchema = z.strictObject({
  authorizationUrl: z.url().max(16_384),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type OidcAdministratorBootstrapStartResponse = z.infer<
  typeof oidcAdministratorBootstrapStartResponseSchema
>;

export const sessionResponseSchema = z.union([
  authenticatedSessionResponseSchema,
  z.object({
    principal: z.null(),
    csrfToken: z.null(),
  }),
]);
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const appearanceUpdateRequestSchema = z.strictObject({
  theme: themePreferenceSchema,
});
export type AppearanceUpdateRequest = z.infer<typeof appearanceUpdateRequestSchema>;

export const appearanceUpdateResponseSchema = z.strictObject({
  theme: themePreferenceSchema,
});
export type AppearanceUpdateResponse = z.infer<typeof appearanceUpdateResponseSchema>;

export const appearanceUpdateResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["theme"],
  properties: { theme: { type: "string", enum: ["system", "light", "dark"] } },
} as const;
