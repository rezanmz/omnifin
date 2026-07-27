import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  acquisitionProvenanceResponseJsonSchema,
  acquisitionProvenanceResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchInputJsonSchema,
  acquisitionSearchInputSchema,
  acquisitionSearchResponseJsonSchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputJsonSchema,
  acquisitionTargetInputSchema,
} from "@omnifin/contracts/acquisition";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  AcquisitionProvenanceError,
  AcquisitionProvenanceService,
  type AcquisitionProvenanceDependencies,
} from "./provenance-service.js";

function configurationError(error: AcquisitionProvenanceError) {
  switch (error.reason) {
    case "connector_unconfigured":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_not_configured",
        message: "Acquisition history has not been configured for this service.",
        statusCode: 503,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_configuration_unavailable",
        message: "Acquisition history configuration is temporarily unavailable.",
        statusCode: 503,
      });
    case "configuration_unavailable":
    case "idempotency_conflict":
    case "idempotency_in_progress":
    case "identity_required":
    case "response_invalid":
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_configuration_unavailable",
        message: "Acquisition history configuration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function searchError(error: AcquisitionProvenanceError, reply: FastifyReply) {
  switch (error.reason) {
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different acquisition search.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_outcome_pending",
        message: "The outcome of this acquisition search is still being determined.",
        statusCode: 409,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_identity_required",
        message: "An active operator account is required to start an acquisition search.",
        statusCode: 403,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_response_invalid",
        message: "The acquisition service returned an unexpected command response.",
        statusCode: 502,
      });
    case "connector_unconfigured":
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "configuration_unavailable":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_configuration_unavailable",
        message: "Acquisition search is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_temporarily_unavailable",
        message: "The acquisition search could not be safely queued.",
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
      code: "acquisition_rate_limited",
      message: "Acquisition history is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "acquisition_response_invalid",
      message: "The acquisition service returned an unexpected response.",
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
      code: "acquisition_configuration_unavailable",
      message: "Acquisition history configuration is temporarily unavailable.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "acquisition_temporarily_unavailable",
    message: "Acquisition history is temporarily unavailable.",
    statusCode: 503,
  });
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

export interface AcquisitionProvenanceRoutesOptions {
  dependencies?: AcquisitionProvenanceDependencies;
}

export const acquisitionProvenanceRoutes: FastifyPluginAsync<
  AcquisitionProvenanceRoutesOptions
> = async (app, options) => {
  const provenance = new AcquisitionProvenanceService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/acquisitions/provenance",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: acquisitionTargetInputJsonSchema,
        response: { 200: acquisitionProvenanceResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "acquisition.manage");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return acquisitionProvenanceResponseSchema.parse(
          await provenance.read(
            acquisitionTargetInputSchema.parse(request.query),
            { principal },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw configurationError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.post(
    "/v1/acquisitions/searches",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: acquisitionSearchInputJsonSchema,
        response: {
          200: acquisitionSearchResponseJsonSchema,
          201: acquisitionSearchResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      const input = acquisitionSearchInputSchema.parse(request.body);
      const idempotencyKey = acquisitionSearchIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = await provenance.queueSearch(
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return acquisitionSearchResponseSchema.parse(result.search);
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw searchError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
