import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  LIBRARY_ATTENTION_MAX_ITEMS,
  libraryArtworkApplyRequestJsonSchema,
  libraryArtworkApplyRequestSchema,
  libraryArtworkResultIdSchema,
  libraryArtworkSearchIdSchema,
  libraryArtworkSearchRequestJsonSchema,
  libraryArtworkSearchRequestSchema,
  libraryArtworkSearchResponseJsonSchema,
  libraryArtworkSearchResponseSchema,
  libraryAttentionQuerySchema,
  libraryAttentionResponseJsonSchema,
  libraryAttentionResponseSchema,
  libraryItemRefreshRequestJsonSchema,
  libraryItemRefreshRequestSchema,
  libraryMetadataUpdateRequestJsonSchema,
  libraryMetadataUpdateRequestSchema,
  libraryMutationIdempotencyKeySchema,
  libraryMutationResponseJsonSchema,
  libraryMutationResponseSchema,
  libraryScanRequestJsonSchema,
  libraryScanRequestSchema,
} from "@omnifin/contracts/library";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  LibraryOperationError,
  LibraryOperationService,
  type LibraryOperationContext,
  type LibraryOperationDependencies,
} from "./operation-service.js";

const itemParamsSchema = z.strictObject({ referenceId: mediaReferenceIdSchema });
const artworkParamsSchema = z.strictObject({
  resultId: libraryArtworkResultIdSchema,
  searchId: libraryArtworkSearchIdSchema,
});

const itemParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId"],
  properties: { referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" } },
} as const;

const artworkParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resultId", "searchId"],
  properties: {
    resultId: { type: "string", pattern: "^library_artwork_result_[A-Za-z0-9_-]{22}$" },
    searchId: { type: "string", pattern: "^library_artwork_search_[A-Za-z0-9_-]{22}$" },
  },
} as const;

const attentionQueryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 16, maxLength: 512, pattern: "^[A-Za-z0-9_.-]+$" },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: LIBRARY_ATTENTION_MAX_ITEMS,
      default: 30,
    },
  },
} as const;

function operationContext(request: FastifyRequest, reply: FastifyReply): LibraryOperationContext {
  const validatedPrincipal = request.server.sessionService.resolveValidatedSessionPrincipal(
    request.validatedSession,
  );
  const session = validatedPrincipal
    ? undefined
    : request.server.sessionService.resolveAndRefresh(
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
  return {
    ipAddress: request.ip,
    principal: requirePermission(validatedPrincipal ?? session?.principal, "library.manage"),
    requestId: request.id,
  };
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function operationError(error: LibraryOperationError, reply: FastifyReply) {
  switch (error.reason) {
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "library_cursor_invalid",
        message: "The library continuation cursor is invalid or no longer current.",
        statusCode: 400,
      });
    case "item_not_found":
      return new SafeHttpError({
        cause: error,
        code: "library_item_not_found",
        message: "The selected library item is no longer available.",
        statusCode: 404,
      });
    case "search_expired":
      return new SafeHttpError({
        cause: error,
        code: "library_artwork_search_expired",
        message: "This artwork search expired. Search again before choosing artwork.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different library operation.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "library_operation_outcome_pending",
        message: "The outcome of this library operation is still being determined.",
        statusCode: 409,
      });
    case "outcome_unknown":
    case "reconciliation_required":
      return new SafeHttpError({
        cause: error,
        code: "library_operation_outcome_unknown",
        message: "The library operation outcome could not be confirmed and will not be repeated.",
        statusCode: 409,
      });
    case "identity_required":
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "library_permission_denied",
        message: "An active operator account with a linked Jellyfin identity is required.",
        statusCode: 403,
      });
    case "operation_limit_reached":
      reply.header("retry-after", "60");
      return new SafeHttpError({
        cause: error,
        code: "library_operation_limit_reached",
        message: "Too many library operations are retained for this account.",
        statusCode: 429,
      });
    case "rate_limited":
      reply.header("retry-after", "30");
      return new SafeHttpError({
        cause: error,
        code: "library_rate_limited",
        message: "Jellyfin is cooling down before another library operation.",
        statusCode: 429,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "library_response_invalid",
        message: "Jellyfin returned an unexpected library response.",
        statusCode: 502,
      });
    case "configuration_unavailable":
    case "search_integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "library_configuration_unavailable",
        message: "Library operations are temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "library_temporarily_unavailable",
        message: "Jellyfin library operations are temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.status === 403) {
    return new SafeHttpError({
      cause: error,
      code: "library_permission_denied",
      message: "The linked Jellyfin account cannot perform this library operation.",
      statusCode: 403,
    });
  }
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
    return new SafeHttpError({
      cause: error,
      code: "library_rate_limited",
      message: "Jellyfin is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "library_response_invalid",
      message: "Jellyfin returned an unexpected library response.",
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
      code: "library_configuration_unavailable",
      message: "Library operations are temporarily unavailable due to configuration.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "library_temporarily_unavailable",
    message: "Jellyfin library operations are temporarily unavailable.",
    statusCode: 503,
  });
}

function handleError(error: unknown, reply: FastifyReply): never {
  if (error instanceof LibraryOperationError) throw operationError(error, reply);
  if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
  throw error;
}

function abortController(request: FastifyRequest) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  return { controller, release: () => request.raw.off("aborted", abort) };
}

export interface LibraryOperationRoutesOptions {
  dependencies?: LibraryOperationDependencies;
}

export const libraryOperationRoutes: FastifyPluginAsync<LibraryOperationRoutesOptions> = async (
  app,
  options,
) => {
  const library = new LibraryOperationService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/library/attention",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        querystring: attentionQueryJsonSchema,
        response: { 200: libraryAttentionResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const query = libraryAttentionQuerySchema.parse(request.query);
      const abort = abortController(request);
      try {
        return libraryAttentionResponseSchema.parse(
          await library.attention(query, operationContext(request, reply), abort.controller.signal),
        );
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.post(
    "/v1/library/scans",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 4, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryScanRequestJsonSchema,
        response: {
          200: libraryMutationResponseJsonSchema,
          201: libraryMutationResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      libraryScanRequestSchema.parse(request.body);
      const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const abort = abortController(request);
      try {
        const result = await library.scan(
          idempotencyKey,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return libraryMutationResponseSchema.parse(result.receipt);
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.post(
    "/v1/library/items/:referenceId/refresh",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryItemRefreshRequestJsonSchema,
        params: itemParamsJsonSchema,
        response: {
          200: libraryMutationResponseJsonSchema,
          201: libraryMutationResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const params = itemParamsSchema.parse(request.params);
      const body = libraryItemRefreshRequestSchema.parse(request.body);
      const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const abort = abortController(request);
      try {
        const result = await library.refresh(
          params.referenceId,
          body,
          idempotencyKey,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return libraryMutationResponseSchema.parse(result.receipt);
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.post(
    "/v1/library/items/:referenceId/metadata",
    {
      bodyLimit: 8_192,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryMetadataUpdateRequestJsonSchema,
        params: itemParamsJsonSchema,
        response: {
          200: libraryMutationResponseJsonSchema,
          201: libraryMutationResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const params = itemParamsSchema.parse(request.params);
      const body = libraryMetadataUpdateRequestSchema.parse(request.body);
      const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const abort = abortController(request);
      try {
        const result = await library.updateMetadata(
          params.referenceId,
          body,
          idempotencyKey,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return libraryMutationResponseSchema.parse(result.receipt);
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.post(
    "/v1/library/items/:referenceId/artwork/search",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 8, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryArtworkSearchRequestJsonSchema,
        params: itemParamsJsonSchema,
        response: { 201: libraryArtworkSearchResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const params = itemParamsSchema.parse(request.params);
      const body = libraryArtworkSearchRequestSchema.parse(request.body);
      const abort = abortController(request);
      try {
        const result = await library.searchArtwork(
          params.referenceId,
          body,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.status(201);
        return libraryArtworkSearchResponseSchema.parse(result);
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.get(
    "/v1/library/artwork-searches/:searchId/results/:resultId/preview",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: { params: artworkParamsJsonSchema },
    },
    async (request, reply) => {
      const params = artworkParamsSchema.parse(request.params);
      const abort = abortController(request);
      try {
        const result = await library.previewArtwork(
          params.searchId,
          params.resultId,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.header("cache-control", "private, max-age=300, must-revalidate");
        reply.header("vary", "Cookie");
        reply.header("etag", result.etag);
        if (request.headers["if-none-match"] === result.etag) return reply.status(304).send();
        return reply.type(result.contentType).send(Buffer.from(result.body));
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );

  app.post(
    "/v1/library/artwork-searches/:searchId/results/:resultId/apply",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 8, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryArtworkApplyRequestJsonSchema,
        params: artworkParamsJsonSchema,
        response: {
          200: libraryMutationResponseJsonSchema,
          201: libraryMutationResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      libraryArtworkApplyRequestSchema.parse(request.body);
      const params = artworkParamsSchema.parse(request.params);
      const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const abort = abortController(request);
      try {
        const result = await library.applyArtwork(
          params.searchId,
          params.resultId,
          idempotencyKey,
          operationContext(request, reply),
          abort.controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return libraryMutationResponseSchema.parse(result.receipt);
      } catch (error) {
        handleError(error, reply);
      } finally {
        abort.release();
      }
    },
  );
};
