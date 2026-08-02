import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  downloadQueueActionInputJsonSchema,
  downloadQueueActionInputSchema,
  downloadQueueActionResponseJsonSchema,
  downloadQueueActionResponseSchema,
  downloadQueueBulkActionInputJsonSchema,
  downloadQueueBulkActionInputSchema,
  downloadQueueBulkActionResponseJsonSchema,
  downloadQueueBulkActionResponseSchema,
  downloadQueuePromotionInputJsonSchema,
  downloadQueuePromotionInputSchema,
  downloadQueuePromotionResponseJsonSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueRemovalInputJsonSchema,
  downloadQueueRemovalInputSchema,
  downloadQueueRemovalResponseJsonSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueueEventCursorSchema,
  downloadQueueResponseJsonSchema,
  downloadQueueResponseSchema,
} from "@omnifin/contracts/downloads";
import { idempotencyKeySchema } from "@omnifin/contracts/requests";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import { safeFailureDiagnostics } from "../logger.js";
import {
  DownloadQueueError,
  DownloadQueueService,
  type DownloadQueueDependencies,
} from "./queue-service.js";
import {
  DownloadQueueEventBroker,
  type DownloadQueueEventBrokerDependencies,
  type DownloadQueueEventSubscription,
} from "./queue-events.js";

const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_LIFETIME_MS = 45_000;
const DEFAULT_EVENT_RECONNECT_MS = 3_000;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function boundedEventTiming(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
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
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different queue operation.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_operation_in_progress",
        message: "That queue operation is already in progress.",
        statusCode: 409,
      });
    case "operation_failed":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_removal_failed",
        message: "The previous queue removal attempt failed. Refresh before trying again.",
        statusCode: 409,
      });
    case "operation_limit_reached":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_operation_limit_reached",
        message: "Too many queue operation records are retained for this account.",
        statusCode: 429,
      });
    case "queue_order_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_order_unavailable",
        message: "That download client is not exposing a verifiable queue order.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "download_queue_action_unconfirmed",
        message: "The download client did not confirm the requested queue change.",
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
      message: "The download client did not confirm the requested queue change.",
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
  eventDependencies?: DownloadQueueEventBrokerDependencies & {
    connectionLifetimeMs?: number;
    heartbeatIntervalMs?: number;
    reconnectDelayMs?: number;
  };
}

export const downloadQueueRoutes: FastifyPluginAsync<DownloadQueueRoutesOptions> = async (
  app,
  options,
) => {
  const queue = new DownloadQueueService(app.database, app.appConfig, options.dependencies);
  const eventBroker = new DownloadQueueEventBroker(queue, {
    ...options.eventDependencies,
    onFailure: (error) => {
      app.log.warn(
        {
          ...safeFailureDiagnostics(error),
          operation: "download.queue.events.refresh",
        },
        "Live download queue refresh failed",
      );
    },
  });
  const eventLifetimeMs = boundedEventTiming(
    options.eventDependencies?.connectionLifetimeMs,
    DEFAULT_EVENT_LIFETIME_MS,
  );
  const eventHeartbeatMs = boundedEventTiming(
    options.eventDependencies?.heartbeatIntervalMs,
    DEFAULT_EVENT_HEARTBEAT_MS,
  );
  const eventReconnectMs = boundedEventTiming(
    options.eventDependencies?.reconnectDelayMs,
    DEFAULT_EVENT_RECONNECT_MS,
  );

  app.addHook("onClose", async () => {
    eventBroker.close();
  });

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

  app.get(
    "/v1/downloads/queue/events",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
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
      const lastEventIdHeader = request.headers["last-event-id"];
      let lastEventId: string | undefined;
      if (lastEventIdHeader !== undefined) {
        const parsed = downloadQueueEventCursorSchema.safeParse(lastEventIdHeader);
        if (!parsed.success) {
          throw new SafeHttpError({
            code: "download_queue_event_cursor_invalid",
            message: "The download queue resume cursor is invalid.",
            statusCode: 400,
          });
        }
        lastEventId = parsed.data;
      }

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        if (subscription.accepted) subscription.unsubscribe();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      const subscription: DownloadQueueEventSubscription = eventBroker.subscribe({
        ...(lastEventId === undefined ? {} : { lastEventId }),
        onClose: close,
        onEvent: (event) => {
          if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
          reply.raw.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        principal,
      });
      if (!subscription.accepted) {
        reply.header("retry-after", Math.ceil(eventReconnectMs / 1_000));
        throw new SafeHttpError({
          code: "download_queue_event_capacity_reached",
          message: "Live download updates are temporarily at capacity.",
          statusCode: 429,
        });
      }

      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.setHeader("cache-control", "no-store, no-transform");
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("pragma", "no-cache");
      reply.raw.setHeader("vary", "Cookie");
      reply.raw.setHeader("x-accel-buffering", "no");
      reply.raw.writeHead(200);
      reply.raw.write(`retry: ${eventReconnectMs}\n\n`);
      const heartbeat = setInterval(() => {
        if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(": keep-alive\n\n");
        }
      }, eventHeartbeatMs);
      heartbeat.unref();
      const lifetime = setTimeout(close, eventLifetimeMs);
      lifetime.unref();
      request.raw.once("aborted", close);
      reply.raw.once("close", close);
    },
  );

  app.post(
    "/v1/downloads/queue/bulk-actions",
    {
      bodyLimit: 65_536,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: downloadQueueBulkActionInputJsonSchema,
        response: { 200: downloadQueueBulkActionResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "downloads.manage",
      );
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = downloadQueueBulkActionResponseSchema.parse(
          await queue.bulkUpdate(
            downloadQueueBulkActionInputSchema.parse(request.body),
            idempotencyKey,
            { ipAddress: request.ip, principal, requestId: request.id },
            controller.signal,
          ),
        );
        reply.header("idempotency-replayed", String(result.replayed));
        return result;
      } catch (error) {
        if (error instanceof DownloadQueueError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
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

  app.post(
    "/v1/downloads/queue/removals",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: downloadQueueRemovalInputJsonSchema,
        response: { 200: downloadQueueRemovalResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "downloads.manage",
      );
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = downloadQueueRemovalResponseSchema.parse(
          await queue.remove(
            downloadQueueRemovalInputSchema.parse(request.body),
            idempotencyKey,
            { ipAddress: request.ip, principal, requestId: request.id },
            controller.signal,
          ),
        );
        reply.header("idempotency-replayed", String(result.replayed));
        return result;
      } catch (error) {
        if (error instanceof DownloadQueueError) throw serviceError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.post(
    "/v1/downloads/queue/promotions",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: downloadQueuePromotionInputJsonSchema,
        response: { 200: downloadQueuePromotionResponseJsonSchema },
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
        return downloadQueuePromotionResponseSchema.parse(
          await queue.promote(
            downloadQueuePromotionInputSchema.parse(request.body),
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
