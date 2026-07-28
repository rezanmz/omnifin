import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  playbackNegotiationRequestSchema,
  playbackNegotiationResponseJsonSchema,
  playbackNegotiationResponseSchema,
  playbackProgressRequestSchema,
  playbackProgressResponseJsonSchema,
  playbackProgressResponseSchema,
  playbackSessionIdSchema,
} from "@omnifin/contracts/playback";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  PlaybackSessionError,
  PlaybackSessionService,
  type PlaybackSessionDependencies,
} from "./playback-session-service.js";

const negotiationParamsSchema = z.strictObject({ referenceId: mediaReferenceIdSchema });
const progressParamsSchema = z.strictObject({ sessionId: playbackSessionIdSchema });
const assetParamsSchema = progressParamsSchema.extend({
  assetToken: z
    .string()
    .min(64)
    .max(8_192)
    .regex(/^asset_v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
});

const negotiationParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId"],
  properties: { referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" } },
} as const;

const progressParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: { sessionId: { type: "string", pattern: "^playback_[A-Za-z0-9_-]{22}$" } },
} as const;

const assetParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetToken", "sessionId"],
  properties: {
    assetToken: {
      type: "string",
      minLength: 64,
      maxLength: 8_192,
      pattern: "^asset_v2\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
    sessionId: { type: "string", pattern: "^playback_[A-Za-z0-9_-]{22}$" },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function playbackError(error: PlaybackSessionError) {
  if (error.reason === "not_found") {
    return new SafeHttpError({
      cause: error,
      code: "playback_session_not_found",
      message: "The playback session is no longer available.",
      statusCode: 404,
    });
  }
  if (error.reason === "transition_invalid") {
    return new SafeHttpError({
      cause: error,
      code: "playback_transition_invalid",
      message: "The playback session cannot accept that state transition.",
      statusCode: 409,
    });
  }
  if (error.reason === "range_invalid") {
    return new SafeHttpError({
      cause: error,
      code: "playback_range_invalid",
      message: "The requested media range is invalid.",
      statusCode: 416,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "playback_unavailable",
    message: "Playback is temporarily unavailable.",
    statusCode: 503,
  });
}

export interface PlaybackRoutesOptions {
  dependencies?: PlaybackSessionDependencies;
}

export const playbackRoutes: FastifyPluginAsync<PlaybackRoutesOptions> = async (app, options) => {
  const playback = new PlaybackSessionService(app.database, app.appConfig, options.dependencies);

  function readPrincipal(request: FastifyRequest, reply: FastifyReply) {
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
    return requirePermission(session?.principal, "media.view");
  }

  app.post(
    "/v1/media/:referenceId/playback",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: negotiationParamsJsonSchema,
        response: { 201: playbackNegotiationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "media.view",
      );
      const params = negotiationParamsSchema.parse(request.params);
      const input = playbackNegotiationRequestSchema.parse(request.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const response = await playback.negotiate(
          { principal },
          params.referenceId,
          input,
          controller.signal,
        );
        reply.status(201);
        return playbackNegotiationResponseSchema.parse(response);
      } catch (error) {
        if (error instanceof PlaybackSessionError) throw playbackError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.post(
    "/v1/playback/:sessionId/progress",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 180, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: progressParamsJsonSchema,
        response: { 200: playbackProgressResponseJsonSchema },
      },
    },
    async (request) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "media.view",
      );
      const params = progressParamsSchema.parse(request.params);
      const input = playbackProgressRequestSchema.parse(request.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return playbackProgressResponseSchema.parse(
          await playback.report({ principal }, params.sessionId, input, controller.signal),
        );
      } catch (error) {
        if (error instanceof PlaybackSessionError) throw playbackError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/playback/:sessionId/stream",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: { params: progressParamsJsonSchema },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      const params = progressParamsSchema.parse(request.params);
      const range = request.headers.range;
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const stream = await playback.readDirect(
          { principal },
          params.sessionId,
          range,
          controller.signal,
        );
        reply.header("accept-ranges", "bytes");
        reply.header("cache-control", "private, no-store");
        reply.header("content-disposition", "inline");
        reply.header("vary", "Cookie, Range");
        if (stream.contentRange) reply.header("content-range", stream.contentRange);
        return reply.status(stream.status).type(stream.contentType).send(Buffer.from(stream.body));
      } catch (error) {
        if (error instanceof PlaybackSessionError) throw playbackError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/playback/:sessionId/master.m3u8",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { params: progressParamsJsonSchema },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      const params = progressParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const manifest = await playback.readManifest(
          { principal },
          params.sessionId,
          controller.signal,
        );
        reply.header("cache-control", "private, no-store");
        reply.header("content-disposition", "inline");
        reply.header("vary", "Cookie");
        return reply.status(200).type(manifest.contentType).send(manifest.body);
      } catch (error) {
        if (error instanceof PlaybackSessionError) throw playbackError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/playback/:sessionId/hls/:assetToken",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: { params: assetParamsJsonSchema },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      const params = assetParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const asset = await playback.readAsset(
          { principal },
          params.sessionId,
          params.assetToken,
          controller.signal,
        );
        reply.header("cache-control", "private, no-store");
        reply.header("content-disposition", "inline");
        reply.header("vary", "Cookie");
        return asset.kind === "manifest"
          ? reply.status(200).type(asset.contentType).send(asset.body)
          : reply
              .status(asset.status)
              .type(asset.contentType)
              .send(Readable.from(streamChunks(asset.body), { objectMode: false }));
      } catch (error) {
        if (error instanceof PlaybackSessionError) throw playbackError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
