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
} from "./continue-watching-service.js";

const artworkParamsSchema = z.strictObject({
  kind: z.enum(["backdrop", "poster"]),
  referenceId: mediaReferenceIdSchema,
});

const artworkParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "referenceId"],
  properties: {
    kind: { enum: ["backdrop", "poster"] },
    referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
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
