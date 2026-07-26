import {
  oidcProviderCapabilitiesSchema,
  oidcProviderAdminSchema,
  oidcProviderCreateRequestSchema,
  oidcProviderValidationParamsSchema,
  oidcProviderValidationResponseSchema,
  oidcProvidersAdminResponseSchema,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { SafeHttpError } from "../../http-error.js";
import { requirePermission } from "../authorization.js";
import { sessionCookieName, writeSessionCookie } from "../session-cookie.js";
import {
  OidcProviderAdminError,
  OidcProviderAdminService,
  type OidcProviderAdminDependencies,
  type OidcProviderValidationAuditReason,
} from "./provider-admin-service.js";
import {
  OidcProviderRegistry,
  OidcProviderRegistryError,
  type OidcProviderRegistryDependencies,
} from "./provider-registry.js";

const providerResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "allowJitProvisioning",
    "approvedEndpointOrigins",
    "clientId",
    "clientSecretConfigured",
    "createdAt",
    "discoveryCheckedAt",
    "discoveryState",
    "displayName",
    "enabled",
    "id",
    "idTokenSigningAlg",
    "issuer",
    "scopes",
    "slug",
    "tokenEndpointAuthMethod",
    "updatedAt",
  ],
  properties: {
    allowJitProvisioning: { type: "boolean" },
    approvedEndpointOrigins: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string" },
    },
    clientId: { type: "string" },
    clientSecretConfigured: { type: "boolean" },
    createdAt: { type: "string" },
    discoveryCheckedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    discoveryState: { enum: ["unchecked", "ready", "failed"] },
    displayName: { type: "string" },
    enabled: { type: "boolean" },
    id: { type: "string" },
    idTokenSigningAlg: {
      enum: [
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
      ],
    },
    issuer: { type: "string" },
    scopes: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
    slug: { type: "string" },
    tokenEndpointAuthMethod: {
      enum: ["client_secret_basic", "client_secret_post", "none"],
    },
    updatedAt: { type: "string" },
  },
} as const;

const capabilitiesResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "authorizationCodeFlow",
    "idTokenSigningAlg",
    "logout",
    "pkceS256",
    "schemaVersion",
    "tokenEndpointAuthMethod",
    "userInfo",
  ],
  properties: {
    authorizationCodeFlow: { const: true },
    idTokenSigningAlg: {
      enum: [
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
      ],
    },
    logout: {
      type: "object",
      additionalProperties: false,
      required: [
        "backChannel",
        "backChannelSession",
        "frontChannel",
        "frontChannelSession",
        "rpInitiated",
      ],
      properties: {
        backChannel: { type: "boolean" },
        backChannelSession: { type: "boolean" },
        frontChannel: { type: "boolean" },
        frontChannelSession: { type: "boolean" },
        rpInitiated: { type: "boolean" },
      },
    },
    pkceS256: { const: true },
    schemaVersion: { const: 1 },
    tokenEndpointAuthMethod: {
      enum: ["client_secret_basic", "client_secret_post", "none"],
    },
    userInfo: { type: "boolean" },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: OidcProviderAdminError): SafeHttpError {
  if (error.reason === "provider_not_found") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_not_found",
      message: "The identity provider does not exist.",
      statusCode: 404,
    });
  }
  if (error.reason === "provider_conflict") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_conflict",
      message: "An identity provider already uses that slug or issuer.",
      statusCode: 409,
    });
  }
  if (error.reason === "provider_limit_reached") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_limit_reached",
      message: "The identity provider limit has been reached.",
      statusCode: 409,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "oidc_provider_configuration_unavailable",
    message: "Identity provider configuration is temporarily unavailable.",
    statusCode: 503,
  });
}

function validationAuditReason(
  error: OidcProviderRegistryError,
): OidcProviderValidationAuditReason {
  if (error.code === "oidc_provider_logout_token_invalid") {
    return "oidc_provider_discovery_failed";
  }
  return error.code;
}

function validationError(error: OidcProviderRegistryError, reply: FastifyReply): SafeHttpError {
  if (error.retryable) reply.header("retry-after", "30");
  if (error.code === "oidc_provider_not_found") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_not_found",
      message: "The identity provider does not exist.",
      statusCode: 404,
    });
  }
  if (error.code === "oidc_provider_misconfigured") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_validation_rejected",
      message: "The identity provider does not satisfy the required security capabilities.",
      statusCode: 422,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "oidc_provider_validation_unavailable",
    message: "The identity provider could not be validated right now.",
    statusCode: 503,
  });
}

export interface OidcProviderAdminRoutesDependencies extends OidcProviderAdminDependencies {
  providerRegistry?: OidcProviderRegistryDependencies;
}

export interface OidcProviderAdminRoutesOptions {
  dependencies?: OidcProviderAdminRoutesDependencies;
}

export const oidcProviderAdminRoutes: FastifyPluginAsync<OidcProviderAdminRoutesOptions> = async (
  app,
  options,
) => {
  const providers = new OidcProviderAdminService(app.database, app.appConfig, options.dependencies);
  const providerRegistry = new OidcProviderRegistry(
    app.database,
    app.appConfig,
    options.dependencies?.providerRegistry,
  );

  app.get(
    "/v1/admin/auth/oidc/providers",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["providers"],
            properties: {
              providers: {
                type: "array",
                maxItems: 50,
                items: providerResponseJsonSchema,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const session = app.sessionService.resolveAndRefresh(
        request.cookies[sessionCookieName(app.appConfig)],
      );
      if (session?.rotatedSessionToken) {
        writeSessionCookie(
          reply,
          app.appConfig,
          session.rotatedSessionToken,
          session.absoluteExpiresAt,
        );
      }
      requirePermission(session?.principal, "recovery.oidc.manage");
      try {
        return oidcProvidersAdminResponseSchema.parse({ providers: providers.list() });
      } catch (error) {
        if (error instanceof OidcProviderAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/auth/oidc/providers",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: { response: { 201: providerResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.oidc.manage",
      );
      const input = oidcProviderCreateRequestSchema.parse(request.body);
      try {
        const provider = providers.create(input, {
          ipAddress: request.ip,
          principal,
          requestId: request.id,
        });
        reply.status(201);
        return oidcProviderAdminSchema.parse(provider);
      } catch (error) {
        if (error instanceof OidcProviderAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/auth/oidc/providers/:providerId/validate",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["providerId"],
          properties: {
            providerId: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["capabilities", "provider"],
            properties: {
              capabilities: capabilitiesResponseJsonSchema,
              provider: providerResponseJsonSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.oidc.manage",
      );
      const { providerId } = oidcProviderValidationParamsSchema.parse(request.params);
      const context = {
        ipAddress: request.ip,
        principal,
        requestId: request.id,
      };
      try {
        const runtime = await providerRegistry.validate(providerId);
        const provider = providers.get(providerId);
        providers.recordValidation(providerId, context, "success", "ready", false);
        return oidcProviderValidationResponseSchema.parse({
          capabilities: oidcProviderCapabilitiesSchema.parse(runtime.provider.capabilities),
          provider,
        });
      } catch (error) {
        if (error instanceof OidcProviderRegistryError) {
          try {
            providers.recordValidation(
              providerId,
              context,
              "failure",
              validationAuditReason(error),
              error.retryable,
            );
          } catch (auditError) {
            if (auditError instanceof OidcProviderAdminError) {
              throw administrationError(auditError);
            }
            throw auditError;
          }
          throw validationError(error, reply);
        }
        if (error instanceof OidcProviderAdminError) throw administrationError(error);
        throw error;
      }
    },
  );
};
