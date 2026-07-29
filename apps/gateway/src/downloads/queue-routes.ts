import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  downloadQueueActionInputJsonSchema,
  downloadQueueActionInputSchema,
  downloadQueueActionResponseJsonSchema,
  downloadQueueActionResponseSchema,
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
  switch (error.reason) {
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_identity_required",
        message: "An active operator account is required to control downloads.",
        statusCode: 403,
      });
    case "target_not_found":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_item_not_found",
        message: "That download is no longer present in the selected client.",
        statusCode: 404,
      });
    case "stale_state":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_state_changed",
        message: "The download changed before the action was confirmed. Refresh and try again.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_action_unconfirmed",
        message: "The download client did not confirm the requested state.",
        statusCode: 502,
      });
    case "connector_unavailable":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_configuration_unavailable",
        message: "Download controls are temporarily unavailable due to configuration.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
    return new SafeHttpError({
      cause: error,
      code: "download_queue_action_rate_limited",
      message: "Download controls are temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "download_queue_action_unconfirmed",
      message: "The download client did not confirm the requested state.",
      statusCode: 502,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "download_queue_action_unavailable",
    message: "The download client could not safely apply that action.",
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

  app.post(
    "/v1/downloads/queue/actions",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: downloadQueueActionInputJsonSchema,
        response: { 200: downloadQueueActionResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "downloads.manage",
      );
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return downloadQueueActionResponseSchema.parse(
          await queue.update(
            downloadQueueActionInputSchema.parse(request.body),
            { ipAddress: request.ip, principal, requestId: request.id },
            controller.signal,
          ),
        );
      } catch (error) {
        if (error instanceof DownloadQueueError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
