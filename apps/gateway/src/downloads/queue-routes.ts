import {
  downloadQueueResponseJsonSchema,
  downloadQueueResponseSchema,
} from "@omnifin/contracts/downloads";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  DownloadQueueError,
  DownloadQueueService,
  type DownloadQueueDependencies,
} from "./queue-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function serviceError(error: DownloadQueueError) {
  return new SafeHttpError({
    cause: error,
    code: "download_queue_configuration_unavailable",
    message: "The download queue configuration is temporarily unavailable.",
    statusCode: 503,
  });
}

export interface DownloadQueueRoutesOptions {
  dependencies?: DownloadQueueDependencies;
}

export const downloadQueueRoutes: FastifyPluginAsync<DownloadQueueRoutesOptions> = async (
  app,
  options,
) => {
  const queue = new DownloadQueueService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/downloads/queue",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: downloadQueueResponseJsonSchema } },
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
      const principal = requirePermission(session?.principal, "downloads.manage");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return downloadQueueResponseSchema.parse(
          await queue.read({ principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof DownloadQueueError) throw serviceError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
