import {
  oidcProviderAdminSchema,
  oidcProviderCreateRequestSchema,
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
} from "./provider-admin-service.js";

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

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: OidcProviderAdminError): SafeHttpError {
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

export interface OidcProviderAdminRoutesOptions {
  dependencies?: OidcProviderAdminDependencies;
}

export const oidcProviderAdminRoutes: FastifyPluginAsync<OidcProviderAdminRoutesOptions> = async (
  app,
  options,
) => {
  const providers = new OidcProviderAdminService(app.database, app.appConfig, options.dependencies);

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
      const principal = requirePermission(session?.principal, "recovery.oidc.manage");
      if (session?.rotatedSessionToken) {
        writeSessionCookie(
          reply,
          app.appConfig,
          session.rotatedSessionToken,
          session.absoluteExpiresAt,
        );
      }
      void principal;
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
};
