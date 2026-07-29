import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  discoveryMediaDetailParamsJsonSchema,
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailQueryJsonSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailResponseJsonSchema,
  discoveryMediaDetailResponseSchema,
  discoveryPersonDetailParamsJsonSchema,
  discoveryPersonDetailParamsSchema,
  discoveryPersonDetailQueryJsonSchema,
  discoveryPersonDetailQuerySchema,
  discoveryPersonDetailResponseJsonSchema,
  discoveryPersonDetailResponseSchema,
  discoverySearchQueryJsonSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseJsonSchema,
  discoverySearchResponseSchema,
} from "@omnifin/contracts/discovery";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  DiscoverySearchError,
  DiscoverySearchService,
  type DiscoverySearchDependencies,
} from "./search-service.js";

function searchError(error: DiscoverySearchError) {
  switch (error.reason) {
    case "connector_unconfigured":
      return new SafeHttpError({
        cause: error,
        code: "discovery_not_configured",
        message: "Discovery has not been configured.",
        statusCode: 503,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "discovery_configuration_unavailable",
        message: "Discovery configuration is temporarily unavailable.",
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
      code: "discovery_rate_limited",
      message: "Discovery is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "discovery_response_invalid",
      message: "Discovery returned a response that could not be safely interpreted.",
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
      code: "discovery_configuration_unavailable",
      message: "Discovery configuration is temporarily unavailable.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "discovery_temporarily_unavailable",
    message: "Discovery is temporarily unavailable.",
    statusCode: 503,
  });
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

export interface DiscoverySearchRoutesOptions {
  dependencies?: DiscoverySearchDependencies;
}

export const discoverySearchRoutes: FastifyPluginAsync<DiscoverySearchRoutesOptions> = async (
  app,
  options,
) => {
  const discovery = new DiscoverySearchService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/discovery/search",
    {
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: discoverySearchQueryJsonSchema,
        response: { 200: discoverySearchResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "media.view");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return discoverySearchResponseSchema.parse(
          await discovery.search(
            discoverySearchQuerySchema.parse(request.query),
            { principal },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof DiscoverySearchError) throw searchError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/discovery/details/:kind/:tmdbId",
    {
      config: { rateLimit: { max: 80, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: discoveryMediaDetailParamsJsonSchema,
        querystring: discoveryMediaDetailQueryJsonSchema,
        response: { 200: discoveryMediaDetailResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "media.view");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return discoveryMediaDetailResponseSchema.parse(
          await discovery.detail(
            discoveryMediaDetailParamsSchema.parse(request.params),
            discoveryMediaDetailQuerySchema.parse(request.query),
            { principal },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof DiscoverySearchError) throw searchError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/discovery/people/:tmdbId",
    {
      config: { rateLimit: { max: 80, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: discoveryPersonDetailParamsJsonSchema,
        querystring: discoveryPersonDetailQueryJsonSchema,
        response: { 200: discoveryPersonDetailResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "media.view");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return discoveryPersonDetailResponseSchema.parse(
          await discovery.personDetail(
            discoveryPersonDetailParamsSchema.parse(request.params),
            discoveryPersonDetailQuerySchema.parse(request.query),
            { principal },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof DiscoverySearchError) throw searchError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
