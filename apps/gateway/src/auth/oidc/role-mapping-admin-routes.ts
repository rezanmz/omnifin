import {
  OIDC_ROLE_MAPPINGS_MAX_COUNT,
  oidcRoleMappingAdminParamsSchema,
  oidcRoleMappingCreateRequestSchema,
  oidcRoleMappingDeleteResponseSchema,
  oidcRoleMappingMutationResponseSchema,
  oidcRoleMappingUpdateRequestSchema,
  oidcRoleMappingsAdminParamsSchema,
  oidcRoleMappingsAdminResponseSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { SafeHttpError } from "../../http-error.js";
import { requirePermission } from "../authorization.js";
import { sessionCookieName, writeSessionCookie } from "../session-cookie.js";
import {
  OidcRoleMappingAdminError,
  OidcRoleMappingAdminService,
  type OidcRoleMappingAdminDependencies,
} from "./role-mapping-admin-service.js";

const identifierJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
} as const;

const roleMappingConfigurationJsonSchema = {
  claimPath: {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: { type: "string", minLength: 1, maxLength: 128 },
  },
  enabled: { type: "boolean" },
  operator: { enum: ["equals", "contains_any", "contains_all"] },
  priority: { type: "integer", minimum: 0, maximum: 10_000 },
  role: { enum: ["viewer", "requester", "operator", "admin"] },
  values: {
    type: "array",
    minItems: 1,
    maxItems: 64,
    items: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 512 },
        { type: "number" },
        { type: "boolean" },
      ],
    },
  },
} as const;

const roleMappingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claimPath", "enabled", "id", "operator", "priority", "providerId", "role", "values"],
  properties: {
    ...roleMappingConfigurationJsonSchema,
    id: identifierJsonSchema,
    providerId: identifierJsonSchema,
  },
} as const;

const mutationResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mapping", "revokedSessions"],
  properties: {
    mapping: roleMappingJsonSchema,
    revokedSessions: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: OidcRoleMappingAdminError): SafeHttpError {
  if (error.reason === "provider_not_found") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_provider_not_found",
      message: "The identity provider does not exist.",
      statusCode: 404,
    });
  }
  if (error.reason === "mapping_not_found") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_role_mapping_not_found",
      message: "The role mapping does not exist.",
      statusCode: 404,
    });
  }
  if (error.reason === "mapping_conflict") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_role_mapping_conflict",
      message: "An equivalent role mapping already exists.",
      statusCode: 409,
    });
  }
  if (error.reason === "mapping_limit_reached") {
    return new SafeHttpError({
      cause: error,
      code: "oidc_role_mapping_limit_reached",
      message: "The role mapping limit has been reached.",
      statusCode: 409,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "oidc_role_mapping_configuration_unavailable",
    message: "Role mapping configuration is temporarily unavailable.",
    statusCode: 503,
  });
}

function context(request: FastifyRequest, principal: SessionPrincipal) {
  return {
    ipAddress: request.ip,
    principal,
    requestId: request.id,
  };
}

function requireRoleMappingAdministrator(principal: SessionPrincipal | null | undefined) {
  return principal?.authenticationMethod.kind === "recovery"
    ? requirePermission(principal, "recovery.oidc.manage")
    : requirePermission(principal, "roles.manage");
}

export interface OidcRoleMappingAdminRoutesOptions {
  dependencies?: OidcRoleMappingAdminDependencies;
}

export const oidcRoleMappingAdminRoutes: FastifyPluginAsync<
  OidcRoleMappingAdminRoutesOptions
> = async (app, options) => {
  const mappings = new OidcRoleMappingAdminService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/admin/auth/oidc/providers/:providerId/role-mappings",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["providerId"],
          properties: { providerId: identifierJsonSchema },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["mappings"],
            properties: {
              mappings: {
                type: "array",
                maxItems: OIDC_ROLE_MAPPINGS_MAX_COUNT,
                items: roleMappingJsonSchema,
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
      requireRoleMappingAdministrator(session?.principal);
      const { providerId } = oidcRoleMappingsAdminParamsSchema.parse(request.params);
      try {
        return oidcRoleMappingsAdminResponseSchema.parse({ mappings: mappings.list(providerId) });
      } catch (error) {
        if (error instanceof OidcRoleMappingAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/auth/oidc/providers/:providerId/role-mappings",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["providerId"],
          properties: { providerId: identifierJsonSchema },
        },
        response: { 201: mutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requireRoleMappingAdministrator(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      const { providerId } = oidcRoleMappingsAdminParamsSchema.parse(request.params);
      const input = oidcRoleMappingCreateRequestSchema.parse(request.body);
      try {
        const result = mappings.create(providerId, input, context(request, principal));
        reply.status(201);
        return oidcRoleMappingMutationResponseSchema.parse(result);
      } catch (error) {
        if (error instanceof OidcRoleMappingAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.put(
    "/v1/admin/auth/oidc/providers/:providerId/role-mappings/:mappingId",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["mappingId", "providerId"],
          properties: {
            mappingId: identifierJsonSchema,
            providerId: identifierJsonSchema,
          },
        },
        response: { 200: mutationResponseJsonSchema },
      },
    },
    async (request) => {
      const principal = requireRoleMappingAdministrator(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      const { mappingId, providerId } = oidcRoleMappingAdminParamsSchema.parse(request.params);
      const input = oidcRoleMappingUpdateRequestSchema.parse(request.body);
      try {
        return oidcRoleMappingMutationResponseSchema.parse(
          mappings.update(providerId, mappingId, input, context(request, principal)),
        );
      } catch (error) {
        if (error instanceof OidcRoleMappingAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/auth/oidc/providers/:providerId/role-mappings/:mappingId",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["mappingId", "providerId"],
          properties: {
            mappingId: identifierJsonSchema,
            providerId: identifierJsonSchema,
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["deletedMappingId", "revokedSessions"],
            properties: {
              deletedMappingId: identifierJsonSchema,
              revokedSessions: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
            },
          },
        },
      },
    },
    async (request) => {
      const principal = requireRoleMappingAdministrator(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      const { mappingId, providerId } = oidcRoleMappingAdminParamsSchema.parse(request.params);
      try {
        return oidcRoleMappingDeleteResponseSchema.parse(
          mappings.delete(providerId, mappingId, context(request, principal)),
        );
      } catch (error) {
        if (error instanceof OidcRoleMappingAdminError) throw administrationError(error);
        throw error;
      }
    },
  );
};
