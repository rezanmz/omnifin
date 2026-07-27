import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  indexerApplicationListResponseJsonSchema,
  indexerApplicationListResponseSchema,
  indexerFailureListResponseJsonSchema,
  indexerFailureListResponseSchema,
  indexerIdentifierParameterJsonSchema,
  indexerIdentifierParameterSchema,
  indexerIntelligenceResponseJsonSchema,
  indexerIntelligenceResponseSchema,
  indexerPageQueryJsonSchema,
  indexerPageQuerySchema,
  indexerTestResponseJsonSchema,
  indexerTestResponseSchema,
} from "@omnifin/contracts/indexers";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  IndexerIntelligenceError,
  IndexerIntelligenceService,
  type IndexerIntelligenceDependencies,
} from "./intelligence-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function serviceError(error: IndexerIntelligenceError) {
  switch (error.reason) {
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "indexer_cursor_invalid",
        message: "The indexer page cursor is not valid for this request.",
        statusCode: 400,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "indexer_test_identity_required",
        message: "An active operator account is required to test an indexer.",
        statusCode: 403,
      });
    case "connector_unconfigured":
      return new SafeHttpError({
        cause: error,
        code: "indexer_intelligence_not_configured",
        message: "A validated Prowlarr connection is required for indexer intelligence.",
        statusCode: 503,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "indexer_intelligence_configuration_unavailable",
        message: "Indexer intelligence configuration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", error.retryAfterSeconds);
    }
    return new SafeHttpError({
      cause: error,
      code: "indexer_intelligence_rate_limited",
      message: "Prowlarr is cooling down before another indexer request.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "indexer_intelligence_response_invalid",
      message: "Prowlarr returned an unexpected indexer response.",
      statusCode: 502,
    });
  }
  if (
    error.code === "configuration_invalid" ||
    error.code === "destination_blocked" ||
    error.code === "invalid_credentials"
  ) {
    return new SafeHttpError({
      cause: error,
      code: "indexer_intelligence_configuration_unavailable",
      message: "Indexer intelligence configuration is temporarily unavailable.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "indexer_intelligence_temporarily_unavailable",
    message: "Indexer intelligence is temporarily unavailable.",
    statusCode: 503,
  });
}

function readPrincipal(request: FastifyRequest, reply: FastifyReply) {
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
  return requirePermission(session?.principal, "acquisition.manage");
}

async function withAbort<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

export interface IndexerIntelligenceRoutesOptions {
  dependencies?: IndexerIntelligenceDependencies;
}

export const indexerIntelligenceRoutes: FastifyPluginAsync<
  IndexerIntelligenceRoutesOptions
> = async (app, options) => {
  const intelligence = new IndexerIntelligenceService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/indexers/intelligence",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: indexerPageQueryJsonSchema,
        response: { 200: indexerIntelligenceResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return indexerIntelligenceResponseSchema.parse(
          await withAbort(request, (signal) =>
            intelligence.readIndexers(
              indexerPageQuerySchema.parse(request.query),
              { principal },
              signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof IndexerIntelligenceError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.get(
    "/v1/indexer-applications",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: indexerPageQueryJsonSchema,
        response: { 200: indexerApplicationListResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return indexerApplicationListResponseSchema.parse(
          await withAbort(request, (signal) =>
            intelligence.readApplications(
              indexerPageQuerySchema.parse(request.query),
              { principal },
              signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof IndexerIntelligenceError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.get(
    "/v1/indexer-failures",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: indexerPageQueryJsonSchema,
        response: { 200: indexerFailureListResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return indexerFailureListResponseSchema.parse(
          await withAbort(request, (signal) =>
            intelligence.readFailures(
              indexerPageQuerySchema.parse(request.query),
              { principal },
              signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof IndexerIntelligenceError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/indexers/:indexerId/tests",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: indexerIdentifierParameterJsonSchema,
        response: { 200: indexerTestResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      const parameter = indexerIdentifierParameterSchema.parse(request.params);
      try {
        return indexerTestResponseSchema.parse(
          await withAbort(request, (signal) =>
            intelligence.testIndexer(
              parameter,
              { ipAddress: request.ip, principal, requestId: request.id },
              signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof IndexerIntelligenceError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );
};
