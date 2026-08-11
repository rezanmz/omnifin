import {
  connectorAdminParamsSchema,
  jellyfinProvisioningConfigSchema,
  jellyfinProvisioningReplaceRequestSchema,
  jellyfinProvisioningTemplatesResponseSchema,
} from "@omnifin/contracts/connectors";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  JellyfinProvisioningError,
  JellyfinProvisioningService,
  type JellyfinProvisioningContext,
  type JellyfinProvisioningDependencies,
} from "./jellyfin-provisioning-service.js";

const paramsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["connectorId"],
  properties: {
    connectorId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
  },
} as const;

const configJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connectorId",
    "credentialConfigured",
    "credentialKind",
    "enabled",
    "revision",
    "template",
    "validatedAt",
    "validationState",
  ],
  properties: {
    connectorId: paramsJsonSchema.properties.connectorId,
    credentialConfigured: { type: "boolean" },
    credentialKind: { anyOf: [{ enum: ["access_token", "api_key"] }, { type: "null" }] },
    enabled: { type: "boolean" },
    revision: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    template: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["displayName", "id"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 160 },
            id: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      ],
    },
    validatedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    validationState: { enum: ["unvalidated", "valid", "invalid"] },
  },
} as const;

const templatesJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["templates"],
  properties: {
    templates: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["displayName", "id"],
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 160 },
          id: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function requireAdministrator(principal: SessionPrincipal | null | undefined) {
  if (principal?.authenticationMethod.kind === "recovery") {
    return requirePermission(principal, "recovery.jellyfin.manage");
  }
  return requirePermission(principal, "connectors.manage");
}

function context(
  request: FastifyRequest,
  principal: SessionPrincipal,
): JellyfinProvisioningContext {
  return { ipAddress: request.ip, principal, requestId: request.id };
}

function sessionPrincipal(request: FastifyRequest, reply: FastifyReply) {
  const session = request.server.sessionService.resolveAndRefresh(
    request.cookies[sessionCookieName(request.server.appConfig)],
  );
  if (session?.rotatedSessionToken) {
    writeSessionCookie(
      reply,
      request.server.appConfig,
      session.rotatedSessionToken,
      session.absoluteExpiresAt,
    );
  }
  return requireAdministrator(session?.principal);
}

function asHttpError(error: JellyfinProvisioningError) {
  const statusCode =
    error.reason === "connector_not_found"
      ? 404
      : ["connector_disabled", "binding_invalid", "connector_not_verified"].includes(error.reason)
        ? 409
        : error.reason === "revision_conflict"
          ? 409
          : error.reason === "permission_denied"
            ? 403
            : [
                  "configuration_invalid",
                  "connector_not_jellyfin",
                  "template_invalid",
                  "unsupported_version",
                ].includes(error.reason)
              ? 422
              : ["upstream_validation_failed", "credential_not_configured"].includes(error.reason)
                ? 409
                : 503;
  const code =
    error.reason === "connector_not_found"
      ? "connector_not_found"
      : error.reason === "connector_disabled"
        ? "jellyfin_provisioning_connector_disabled"
        : error.reason === "connector_not_verified"
          ? "jellyfin_provisioning_connector_not_verified"
          : error.reason === "binding_invalid"
            ? "jellyfin_provisioning_binding_invalid"
            : error.reason === "revision_conflict"
              ? "connector_jellyfin_provisioning_revision_conflict"
              : error.reason === "configuration_invalid"
                ? "jellyfin_provisioning_configuration_invalid"
                : error.reason === "connector_not_jellyfin"
                  ? "jellyfin_provisioning_connector_invalid"
                  : error.reason === "template_invalid"
                    ? "jellyfin_provisioning_template_invalid"
                    : error.reason === "unsupported_version"
                      ? "jellyfin_provisioning_unsupported_version"
                      : error.reason === "credential_not_configured"
                        ? "jellyfin_provisioning_credential_not_configured"
                        : error.reason === "upstream_validation_failed"
                          ? "jellyfin_provisioning_credential_invalid"
                          : "jellyfin_provisioning_unavailable";
  const message =
    error.reason === "connector_disabled"
      ? "The Jellyfin connector is disabled."
      : error.reason === "connector_not_verified"
        ? "Probe the Jellyfin connector successfully before listing templates."
        : error.reason === "binding_invalid"
          ? "The provisioning configuration is no longer bound to the current connector target."
          : error.reason === "revision_conflict"
            ? "The provisioning configuration changed since it was loaded."
            : error.reason === "configuration_invalid"
              ? "The provisioning configuration is malformed or incomplete."
              : error.reason === "connector_not_jellyfin"
                ? "The selected connector is not Jellyfin."
                : error.reason === "template_invalid"
                  ? "The selected Jellyfin template user is not usable."
                  : error.reason === "unsupported_version"
                    ? "This Jellyfin server version is not supported for provisioning."
                    : error.reason === "upstream_validation_failed"
                      ? "The Jellyfin administrator credential could not be validated."
                      : "Jellyfin provisioning configuration is temporarily unavailable.";
  return new SafeHttpError({ cause: error, code, message, statusCode });
}

export interface JellyfinProvisioningRoutesOptions {
  dependencies?: JellyfinProvisioningDependencies;
}

export const jellyfinProvisioningRoutes: FastifyPluginAsync<
  JellyfinProvisioningRoutesOptions
> = async (app, options) => {
  const provisioning = new JellyfinProvisioningService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/admin/connectors/:connectorId/jellyfin-provisioning",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { params: paramsJsonSchema, response: { 200: configJsonSchema } },
    },
    async (request, reply) => {
      const principal = sessionPrincipal(request, reply);
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      try {
        return jellyfinProvisioningConfigSchema.parse(
          provisioning.get(connectorId, context(request, principal)),
        );
      } catch (error) {
        if (error instanceof JellyfinProvisioningError) throw asHttpError(error);
        throw error;
      }
    },
  );

  app.get(
    "/v1/admin/connectors/:connectorId/jellyfin-provisioning/templates",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { params: paramsJsonSchema, response: { 200: templatesJsonSchema } },
    },
    async (request, reply) => {
      const principal = sessionPrincipal(request, reply);
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      try {
        return jellyfinProvisioningTemplatesResponseSchema.parse({
          templates: await provisioning.listTemplates(connectorId, context(request, principal)),
        });
      } catch (error) {
        if (error instanceof JellyfinProvisioningError) throw asHttpError(error);
        throw error;
      }
    },
  );

  app.put(
    "/v1/admin/connectors/:connectorId/jellyfin-provisioning",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: paramsJsonSchema,
        response: { 200: configJsonSchema },
      },
    },
    async (request) => {
      const principal = requireAdministrator(
        request.server.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      const input = jellyfinProvisioningReplaceRequestSchema.parse(request.body);
      try {
        return jellyfinProvisioningConfigSchema.parse(
          await provisioning.replace(connectorId, input, context(request, principal)),
        );
      } catch (error) {
        if (error instanceof JellyfinProvisioningError) throw asHttpError(error);
        throw error;
      }
    },
  );
};
