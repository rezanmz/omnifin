import {
  continueWatchingResponseJsonSchema,
  continueWatchingResponseSchema,
} from "@omnifin/contracts/dashboard";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  ContinueWatchingError,
  ContinueWatchingService,
  type ContinueWatchingDependencies,
} from "./continue-watching-service.js";

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
};
