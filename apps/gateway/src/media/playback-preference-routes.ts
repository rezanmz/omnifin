import {
  playbackPreferencesResponseJsonSchema,
  playbackPreferencesResponseSchema,
  playbackPreferencesUpdateRequestJsonSchema,
  playbackPreferencesUpdateRequestSchema,
} from "@omnifin/contracts/playback";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import { clientNetworkClass } from "../security/client-network.js";
import {
  PlaybackPreferenceError,
  PlaybackPreferenceService,
  type PlaybackPreferenceDependencies,
} from "./playback-preference-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function userId(value: string | null) {
  if (value) return value;
  throw new SafeHttpError({
    code: "playback_preferences_unavailable",
    message: "Playback preferences require a normal user session.",
    statusCode: 403,
  });
}

function requestNetworkClass(request: FastifyRequest, trustedProxyHops: number) {
  // A private web-container socket is not evidence that the browser is at home.
  // When a proxy hop is configured, fail closed unless Fastify resolved an
  // authenticated forwarding hop and supplied a distinct client address.
  if (trustedProxyHops > 0 && (request.ips?.length ?? 0) < 2) return "remote" as const;
  return clientNetworkClass(request.ip);
}

function routeError(error: PlaybackPreferenceError) {
  if (error.reason === "conflict") {
    return new SafeHttpError({
      cause: error,
      code: "playback_preferences_conflict",
      message: "Playback preferences changed in another session. Refresh before saving again.",
      statusCode: 409,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "playback_preferences_unavailable",
    message: "Playback preferences are temporarily unavailable.",
    statusCode: 503,
  });
}

export interface PlaybackPreferenceRoutesOptions {
  dependencies?: PlaybackPreferenceDependencies;
}

export const playbackPreferenceRoutes: FastifyPluginAsync<PlaybackPreferenceRoutesOptions> = async (
  app,
  options,
) => {
  const preferences = new PlaybackPreferenceService(app.database, options.dependencies);

  app.get(
    "/v1/playback/preferences",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: playbackPreferencesResponseJsonSchema } },
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
      const principal = requirePermission(session?.principal, "playback.use");
      try {
        return playbackPreferencesResponseSchema.parse(
          preferences.read(
            userId(principal.userId),
            requestNetworkClass(request, app.appConfig.trustProxyHops),
          ),
        );
      } catch (error) {
        if (error instanceof PlaybackPreferenceError) throw routeError(error);
        throw error;
      }
    },
  );

  app.put(
    "/v1/playback/preferences",
    {
      bodyLimit: 8 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: playbackPreferencesUpdateRequestJsonSchema,
        response: { 200: playbackPreferencesResponseJsonSchema },
      },
    },
    async (request) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "playback.use",
      );
      const input = playbackPreferencesUpdateRequestSchema.parse(request.body);
      try {
        return playbackPreferencesResponseSchema.parse(
          preferences.update(
            userId(principal.userId),
            input,
            requestNetworkClass(request, app.appConfig.trustProxyHops),
          ),
        );
      } catch (error) {
        if (error instanceof PlaybackPreferenceError) throw routeError(error);
        throw error;
      }
    },
  );
};
