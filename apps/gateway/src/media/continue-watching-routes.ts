import {
  continueWatchingResponseJsonSchema,
  continueWatchingResponseSchema,
  mediaReferenceIdSchema,
} from "@omnifin/contracts/dashboard";
import {
  libraryBrowseQueryJsonSchema,
  libraryBrowseQuerySchema,
  libraryBrowseResponseJsonSchema,
  libraryBrowseResponseSchema,
  libraryExtrasQueryJsonSchema,
  libraryExtrasQuerySchema,
  libraryExtrasResponseJsonSchema,
  libraryExtrasResponseSchema,
  libraryMutationIdempotencyKeySchema,
  libraryPlaybackStateMutationRequestJsonSchema,
  libraryPlaybackStateMutationRequestSchema,
  libraryPlaybackStateMutationResponseJsonSchema,
  libraryPlaybackStateMutationResponseSchema,
  libraryRemovalPreviewJsonSchema,
  libraryRemovalPreviewSchema,
  librarySeasonEpisodesQueryJsonSchema,
  librarySeasonEpisodesQuerySchema,
  librarySeasonEpisodesResponseJsonSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseJsonSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryQueryJsonSchema,
  viewingHistoryQuerySchema,
  viewingHistoryResponseJsonSchema,
  viewingHistoryResponseSchema,
} from "@omnifin/contracts/library";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  ContinueWatchingError,
  ContinueWatchingService,
  type ContinueWatchingDependencies,
  MediaArtworkError,
  MediaLibraryError,
  MediaPlaybackStateError,
  LibraryRemovalPreviewError,
  ViewingHistoryError,
} from "./continue-watching-service.js";

const artworkParamsSchema = z.strictObject({
  kind: z.enum(["backdrop", "poster"]),
  referenceId: mediaReferenceIdSchema,
});

const personArtworkParamsSchema = z.strictObject({
  referenceId: mediaReferenceIdSchema,
  token: z
    .string()
    .min(64)
    .max(768)
    .regex(/^[A-Za-z0-9_.-]+$/u),
});

const libraryTitleParamsSchema = z.strictObject({
  referenceId: mediaReferenceIdSchema,
});

const librarySeasonParamsSchema = z.strictObject({
  referenceId: mediaReferenceIdSchema,
  seasonNumber: z.coerce.number().int().nonnegative().max(100_000),
});

const libraryTitleParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId"],
  properties: { referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" } },
} as const;

const librarySeasonParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId", "seasonNumber"],
  properties: {
    referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
    seasonNumber: { type: "integer", minimum: 0, maximum: 100_000 },
  },
} as const;

const artworkParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "referenceId"],
  properties: {
    kind: { enum: ["backdrop", "poster"] },
    referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
  },
} as const;

const personArtworkParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId", "token"],
  properties: {
    referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
    token: { type: "string", minLength: 64, maxLength: 768, pattern: "^[A-Za-z0-9_.-]+$" },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function playbackStateError(error: MediaPlaybackStateError, reply: FastifyReply) {
  switch (error.reason) {
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for another playback-state change.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "media_playback_state_outcome_pending",
        message: "The outcome of this playback-state change is still being determined.",
        statusCode: 409,
      });
    case "not_found":
      return new SafeHttpError({
        cause: error,
        code: "media_library_title_not_found",
        message: "The library item is no longer available to this Jellyfin account.",
        statusCode: 404,
      });
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "media_playback_state_permission_denied",
        message: "This account cannot change the selected Jellyfin playback state.",
        statusCode: 403,
      });
    case "operation_limit_reached":
      reply.header("retry-after", "60");
      return new SafeHttpError({
        cause: error,
        code: "media_playback_state_limit_reached",
        message: "Too many playback-state operations are retained for this account.",
        statusCode: 429,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "media_playback_state_response_invalid",
        message: "Jellyfin returned an unexpected playback-state response.",
        statusCode: 502,
      });
    case "storage_failure":
    case "unavailable":
      return new SafeHttpError({
        cause: error,
        code: "media_playback_state_unavailable",
        message: "The Jellyfin playback state is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

export interface ContinueWatchingRoutesOptions {
  dependencies?: ContinueWatchingDependencies;
}

export const continueWatchingRoutes: FastifyPluginAsync<ContinueWatchingRoutesOptions> = async (
  app,
  options,
) => {
  const service = new ContinueWatchingService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/media/continue-watching",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: continueWatchingResponseJsonSchema } },
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
        return continueWatchingResponseSchema.parse(
          await service.read({ principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof ContinueWatchingError) {
          throw new SafeHttpError({
            cause: error,
            code: "continue_watching_unavailable",
            message: "Continue Watching is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/library",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: libraryBrowseQueryJsonSchema,
        response: { 200: libraryBrowseResponseJsonSchema },
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
      const query = libraryBrowseQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return libraryBrowseResponseSchema.parse(
          await service.browse(query, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof MediaLibraryError && error.reason === "cursor_invalid") {
          throw new SafeHttpError({
            cause: error,
            code: "media_library_cursor_invalid",
            message: "The library continuation cursor is invalid or no longer current.",
            statusCode: 400,
          });
        }
        if (error instanceof ContinueWatchingError || error instanceof MediaLibraryError) {
          throw new SafeHttpError({
            cause: error,
            code: "media_library_unavailable",
            message: "The Jellyfin library is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/history",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: viewingHistoryQueryJsonSchema,
        response: { 200: viewingHistoryResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "playback.history.self.manage");
      const query = viewingHistoryQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return viewingHistoryResponseSchema.parse(
          await service.readViewingHistory(query, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof ViewingHistoryError && error.reason === "cursor_invalid") {
          throw new SafeHttpError({
            cause: error,
            code: "viewing_history_cursor_invalid",
            message: "The viewing-history cursor is invalid or no longer current.",
            statusCode: 400,
          });
        }
        if (error instanceof ContinueWatchingError || error instanceof ViewingHistoryError) {
          throw new SafeHttpError({
            cause: error,
            code: "viewing_history_unavailable",
            message: "Viewing history is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/library/:referenceId/removal-preview",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: libraryTitleParamsJsonSchema,
        response: { 200: libraryRemovalPreviewJsonSchema },
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
      const principal = requirePermission(session?.principal, "library.delete");
      const { referenceId } = libraryTitleParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return libraryRemovalPreviewSchema.parse(
          await service.previewLibraryRemoval(
            referenceId,
            { ipAddress: request.ip, principal, requestId: request.id },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof LibraryRemovalPreviewError) {
          const notFound = error.reason === "not_found";
          const permissionDenied = error.reason === "paired_user_cannot_delete";
          throw new SafeHttpError({
            cause: error,
            code: notFound
              ? "library_removal_title_not_found"
              : permissionDenied
                ? "library_removal_not_permitted"
                : "library_removal_preview_unavailable",
            message: notFound
              ? "The library title is no longer available."
              : permissionDenied
                ? "The paired Jellyfin user cannot remove this title."
                : "The library removal preview is temporarily unavailable.",
            statusCode: notFound ? 404 : permissionDenied ? 403 : 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/library/:referenceId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: libraryTitleParamsJsonSchema,
        response: { 200: libraryTitleDetailResponseJsonSchema },
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
      const { referenceId } = libraryTitleParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return libraryTitleDetailResponseSchema.parse(
          await service.readLibraryTitle(referenceId, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof MediaLibraryError) {
          throw new SafeHttpError({
            cause: error,
            code:
              error.reason === "not_found"
                ? "media_library_title_not_found"
                : "media_library_unavailable",
            message:
              error.reason === "not_found"
                ? "The library title is no longer available."
                : "The Jellyfin library is temporarily unavailable.",
            statusCode: error.reason === "not_found" ? 404 : 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/library/:referenceId/extras",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: libraryTitleParamsJsonSchema,
        querystring: libraryExtrasQueryJsonSchema,
        response: { 200: libraryExtrasResponseJsonSchema },
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
      const { referenceId } = libraryTitleParamsSchema.parse(request.params);
      const query = libraryExtrasQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return libraryExtrasResponseSchema.parse(
          await service.readLibraryExtras(referenceId, query, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof MediaLibraryError) {
          const cursorInvalid = error.reason === "cursor_invalid";
          const notFound = error.reason === "not_found";
          throw new SafeHttpError({
            cause: error,
            code: cursorInvalid
              ? "media_library_cursor_invalid"
              : notFound
                ? "media_library_title_not_found"
                : "media_library_unavailable",
            message: cursorInvalid
              ? "The extras continuation cursor is invalid or no longer current."
              : notFound
                ? "The library title is no longer available."
                : "The Jellyfin library is temporarily unavailable.",
            statusCode: cursorInvalid ? 400 : notFound ? 404 : 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/library/:referenceId/seasons/:seasonNumber/episodes",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        params: librarySeasonParamsJsonSchema,
        querystring: librarySeasonEpisodesQueryJsonSchema,
        response: { 200: librarySeasonEpisodesResponseJsonSchema },
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
      const { referenceId, seasonNumber } = librarySeasonParamsSchema.parse(request.params);
      const query = librarySeasonEpisodesQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return librarySeasonEpisodesResponseSchema.parse(
          await service.readLibrarySeasonEpisodes(
            referenceId,
            seasonNumber,
            query,
            { principal },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof MediaLibraryError) {
          const cursorInvalid = error.reason === "cursor_invalid";
          const notFound = error.reason === "not_found";
          throw new SafeHttpError({
            cause: error,
            code: cursorInvalid
              ? "media_library_cursor_invalid"
              : notFound
                ? "media_library_title_not_found"
                : "media_library_unavailable",
            message: cursorInvalid
              ? "The season continuation cursor is invalid or no longer current."
              : notFound
                ? "The library series is no longer available."
                : "The Jellyfin library is temporarily unavailable.",
            statusCode: cursorInvalid ? 400 : notFound ? 404 : 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.post(
    "/v1/media/library/:referenceId/playback-state",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryPlaybackStateMutationRequestJsonSchema,
        params: libraryTitleParamsJsonSchema,
        response: { 200: libraryPlaybackStateMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "playback.history.self.manage",
      );
      const { referenceId } = libraryTitleParamsSchema.parse(request.params);
      const body = libraryPlaybackStateMutationRequestSchema.parse(request.body);
      const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = await service.updatePlaybackState(
          referenceId,
          body,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        return libraryPlaybackStateMutationResponseSchema.parse(result.response);
      } catch (error) {
        if (error instanceof MediaPlaybackStateError) throw playbackStateError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/:referenceId/images/people/:token",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { params: personArtworkParamsJsonSchema },
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
      const params = personArtworkParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const artwork = await service.readPersonArtwork(
          { principal },
          params.referenceId,
          params.token,
          controller.signal,
        );
        reply.header("cache-control", "private, max-age=3600, stale-while-revalidate=86400");
        reply.header("content-disposition", "inline");
        reply.header("etag", artwork.etag);
        reply.header("vary", "Cookie, Accept");
        if (request.headers["if-none-match"] === artwork.etag) {
          return reply.status(304).send();
        }
        return reply.type(artwork.contentType).send(Buffer.from(artwork.body));
      } catch (error) {
        if (error instanceof MediaArtworkError) {
          throw new SafeHttpError({
            cause: error,
            code:
              error.reason === "not_found"
                ? "media_person_artwork_not_found"
                : "media_person_artwork_unavailable",
            message:
              error.reason === "not_found"
                ? "The requested person artwork is not available."
                : "Person artwork is temporarily unavailable.",
            statusCode: error.reason === "not_found" ? 404 : 503,
          });
        }
        if (error instanceof ContinueWatchingError) {
          throw new SafeHttpError({
            cause: error,
            code: "media_person_artwork_unavailable",
            message: "Person artwork is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/media/:referenceId/images/:kind",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { params: artworkParamsJsonSchema },
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
      const params = artworkParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const artwork = await service.readArtwork(
          { principal },
          params.referenceId,
          params.kind,
          controller.signal,
        );
        reply.header("cache-control", "private, max-age=3600, stale-while-revalidate=86400");
        reply.header("content-disposition", "inline");
        reply.header("etag", artwork.etag);
        reply.header("vary", "Cookie, Accept");
        if (request.headers["if-none-match"] === artwork.etag) {
          return reply.status(304).send();
        }
        return reply.type(artwork.contentType).send(Buffer.from(artwork.body));
      } catch (error) {
        if (error instanceof MediaArtworkError) {
          throw new SafeHttpError({
            cause: error,
            code:
              error.reason === "not_found"
                ? "media_artwork_not_found"
                : "media_artwork_unavailable",
            message:
              error.reason === "not_found"
                ? "The requested media artwork is not available."
                : "Media artwork is temporarily unavailable.",
            statusCode: error.reason === "not_found" ? 404 : 503,
          });
        }
        if (error instanceof ContinueWatchingError) {
          throw new SafeHttpError({
            cause: error,
            code: "media_artwork_unavailable",
            message: "Media artwork is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
