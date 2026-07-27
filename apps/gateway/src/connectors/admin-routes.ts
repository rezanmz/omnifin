import {
  connectorAdminParamsJsonSchema,
  connectorAdminParamsSchema,
  connectorCreateRequestSchema,
  connectorDeleteQueryJsonSchema,
  connectorDeleteQuerySchema,
  connectorDeleteResponseJsonSchema,
  connectorDeleteResponseSchema,
  connectorListQueryJsonSchema,
  connectorListQuerySchema,
  connectorListResponseJsonSchema,
  connectorListResponseSchema,
  connectorMutationResponseJsonSchema,
  connectorMutationResponseSchema,
  connectorUpdateRequestSchema,
} from "@omnifin/contracts/connectors";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  ConnectorAdminError,
  ConnectorAdminService,
  type ConnectorAdminDependencies,
} from "./admin-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: ConnectorAdminError): SafeHttpError {
  switch (error.reason) {
    case "connector_not_found":
      return new SafeHttpError({
        cause: error,
        code: "connector_not_found",
        message: "The connector does not exist.",
        statusCode: 404,
      });
    case "configuration_conflict":
      return new SafeHttpError({
        cause: error,
        code: "connector_configuration_conflict",
        message: "A connector already uses that identifier.",
        statusCode: 409,
      });
    case "connector_limit_reached":
      return new SafeHttpError({
        cause: error,
        code: "connector_limit_reached",
        message: "The connector limit has been reached.",
        statusCode: 409,
      });
    case "connector_in_use":
      return new SafeHttpError({
        cause: error,
        code: "connector_in_use",
        message: "The connector is linked to existing identities.",
        statusCode: 409,
      });
    case "connector_must_be_disabled":
      return new SafeHttpError({
        cause: error,
        code: "connector_must_be_disabled",
        message: "Disable the connector before deleting it.",
        statusCode: 409,
      });
    case "connector_not_validated":
      return new SafeHttpError({
        cause: error,
        code: "connector_not_validated",
        message: "Validate the connector successfully before enabling it.",
        statusCode: 409,
      });
    case "revision_conflict":
      return new SafeHttpError({
        cause: error,
        code: "connector_revision_conflict",
        message: "The connector changed since it was loaded.",
        statusCode: 409,
      });
    case "configuration_invalid":
      return new SafeHttpError({
        cause: error,
        code: "connector_configuration_invalid",
        message: "The connector configuration is not valid.",
        statusCode: 422,
      });
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "connector_configuration_unavailable",
        message: "Connector configuration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function mutationPrincipal(request: FastifyRequest) {
  return requirePermission(
    request.server.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
    "connectors.manage",
  );
}

function context(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    principal: mutationPrincipal(request),
    requestId: request.id,
  };
}

export interface ConnectorAdminRoutesOptions {
  dependencies?: ConnectorAdminDependencies;
}

export const connectorAdminRoutes: FastifyPluginAsync<ConnectorAdminRoutesOptions> = async (
  app,
  options,
) => {
  const connectors = new ConnectorAdminService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/admin/connectors",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: connectorListQueryJsonSchema,
        response: { 200: connectorListResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "connectors.manage");
      try {
        return connectorListResponseSchema.parse(
          connectors.list(connectorListQuerySchema.parse(request.query), {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          }),
        );
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.get(
    "/v1/admin/connectors/:connectorId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: connectorAdminParamsJsonSchema,
        response: { 200: connectorMutationResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "connectors.manage");
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      try {
        return connectorMutationResponseSchema.parse({
          connector: connectors.get(connectorId, {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          }),
        });
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/connectors",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        response: { 201: connectorMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const input = connectorCreateRequestSchema.parse(request.body);
      try {
        const connector = connectors.create(input, context(request));
        reply.header("location", `/v1/admin/connectors/${encodeURIComponent(connector.id)}`);
        reply.status(201);
        return connectorMutationResponseSchema.parse({ connector });
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.patch(
    "/v1/admin/connectors/:connectorId",
    {
      bodyLimit: 16 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: connectorAdminParamsJsonSchema,
        response: { 200: connectorMutationResponseJsonSchema },
      },
    },
    async (request) => {
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      const input = connectorUpdateRequestSchema.parse(request.body);
      try {
        return connectorMutationResponseSchema.parse({
          connector: connectors.update(connectorId, input, context(request)),
        });
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/connectors/:connectorId/probe",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: connectorAdminParamsJsonSchema,
        response: { 200: connectorMutationResponseJsonSchema },
      },
    },
    async (request) => {
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      try {
        return connectorMutationResponseSchema.parse({
          connector: await connectors.probe(connectorId, context(request)),
        });
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/connectors/:connectorId",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: connectorAdminParamsJsonSchema,
        querystring: connectorDeleteQueryJsonSchema,
        response: { 200: connectorDeleteResponseJsonSchema },
      },
    },
    async (request) => {
      const { connectorId } = connectorAdminParamsSchema.parse(request.params);
      const { revision } = connectorDeleteQuerySchema.parse(request.query);
      try {
        return connectorDeleteResponseSchema.parse(
          connectors.delete(connectorId, revision, context(request)),
        );
      } catch (error) {
        if (error instanceof ConnectorAdminError) throw administrationError(error);
        throw error;
      }
    },
  );
};
