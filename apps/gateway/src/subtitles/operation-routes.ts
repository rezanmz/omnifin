import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  subtitleDownloadIdempotencyKeySchema,
  subtitleDownloadRequestJsonSchema,
  subtitleDownloadRequestSchema,
  subtitleDownloadResponseJsonSchema,
  subtitleDownloadResponseSchema,
  subtitleResultIdSchema,
  subtitleSearchIdSchema,
  subtitleSearchRequestJsonSchema,
  subtitleSearchRequestSchema,
  subtitleSearchResponseJsonSchema,
  subtitleSearchResponseSchema,
} from "@omnifin/contracts/subtitles";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { SafeHttpError } from "../http-error.js";
import {
  SubtitleOperationError,
  SubtitleOperationService,
  type SubtitleOperationDependencies,
} from "./operation-service.js";

const searchParamsSchema = z.strictObject({ referenceId: mediaReferenceIdSchema });
const downloadParamsSchema = z.strictObject({
  resultId: subtitleResultIdSchema,
  searchId: subtitleSearchIdSchema,
});

const searchParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId"],
  properties: { referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" } },
} as const;

const downloadParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resultId", "searchId"],
  properties: {
    resultId: { type: "string", pattern: "^subtitle_result_[A-Za-z0-9_-]{22}$" },
    searchId: { type: "string", pattern: "^subtitle_search_[A-Za-z0-9_-]{22}$" },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function operationError(error: SubtitleOperationError, reply: FastifyReply) {
  switch (error.reason) {
    case "media_not_found":
      return new SafeHttpError({
        cause: error,
        code: "media_reference_not_found",
        message: "The selected media item is no longer available.",
        statusCode: 404,
      });
    case "media_unsupported":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_media_unsupported",
        message: "Manual subtitles are available for movies and episodes with known numbering.",
        statusCode: 409,
      });
    case "target_not_found":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_media_not_indexed",
        message: "Bazarr has not indexed this media item yet.",
        statusCode: 409,
      });
    case "target_ambiguous":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_media_ambiguous",
        message: "Bazarr returned more than one exact library match for this media item.",
        statusCode: 409,
      });
    case "search_expired":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_search_expired",
        message: "This subtitle search expired. Search again before downloading.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different subtitle download.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "subtitle_download_outcome_pending",
        message: "The outcome of this subtitle download is still being determined.",
        statusCode: 409,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_identity_required",
        message: "An active operator account is required to manage subtitles.",
        statusCode: 403,
      });
    case "operation_limit_reached":
      reply.header("retry-after", "60");
      return new SafeHttpError({
        cause: error,
        code: "subtitle_operation_limit_reached",
        message: "Too many subtitle operations are retained for this account.",
        statusCode: 429,
      });
    case "outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_download_outcome_uncertain",
        message:
          "The subtitle download may have been accepted. Verify the installed subtitle before acting again.",
        statusCode: 409,
      });
    case "rate_limited":
      reply.header("retry-after", "30");
      return new SafeHttpError({
        cause: error,
        code: "subtitle_rate_limited",
        message: "The subtitle service is cooling down before another operation.",
        statusCode: 429,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_response_invalid",
        message: "The subtitle service returned an unexpected response.",
        statusCode: 502,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "connector_unconfigured":
    case "configuration_unavailable":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_configuration_unavailable",
        message: "Subtitle operations are temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "subtitle_temporarily_unavailable",
        message: "The subtitle service is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
    return new SafeHttpError({
      cause: error,
      code: "subtitle_rate_limited",
      message: "The subtitle service is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "subtitle_response_invalid",
      message: "The subtitle service returned an unexpected response.",
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
      code: "subtitle_configuration_unavailable",
      message: "Subtitle operations are temporarily unavailable due to configuration.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "subtitle_temporarily_unavailable",
    message: "The subtitle service is temporarily unavailable.",
    statusCode: 503,
  });
}

export interface SubtitleOperationRoutesOptions {
  dependencies?: SubtitleOperationDependencies;
}

export const subtitleOperationRoutes: FastifyPluginAsync<SubtitleOperationRoutesOptions> = async (
  app,
  options,
) => {
  const subtitles = new SubtitleOperationService(app.database, app.appConfig, options.dependencies);

  app.post(
    "/v1/media/:referenceId/subtitles/search",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: subtitleSearchRequestJsonSchema,
        params: searchParamsJsonSchema,
        response: { 201: subtitleSearchResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "library.manage",
      );
      subtitleSearchRequestSchema.parse(request.body);
      const params = searchParamsSchema.parse(request.params);
      try {
        const result = await subtitles.search(
          params.referenceId,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.status(201);
        return subtitleSearchResponseSchema.parse(result);
      } catch (error) {
        if (error instanceof SubtitleOperationError) throw operationError(error, reply);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/subtitle-searches/:searchId/results/:resultId/download",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: subtitleDownloadRequestJsonSchema,
        params: downloadParamsJsonSchema,
        response: {
          200: subtitleDownloadResponseJsonSchema,
          201: subtitleDownloadResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "library.manage",
      );
      subtitleDownloadRequestSchema.parse(request.body);
      const params = downloadParamsSchema.parse(request.params);
      const idempotencyKey = subtitleDownloadIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      try {
        const result = await subtitles.download(
          params.searchId,
          params.resultId,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return subtitleDownloadResponseSchema.parse(result.download);
      } catch (error) {
        if (error instanceof SubtitleOperationError) throw operationError(error, reply);
        throw error;
      }
    },
  );
};
