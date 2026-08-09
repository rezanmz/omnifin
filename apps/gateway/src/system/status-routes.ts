import {
  systemStatusEventCursorSchema,
  systemStatusResponseJsonSchema,
  systemStatusResponseSchema,
} from "@omnifin/contracts/system";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import { safeFailureDiagnostics } from "../logger.js";
import {
  SystemStatusEventBroker,
  type SystemStatusEventBrokerDependencies,
  type SystemStatusEventSubscription,
} from "./status-events.js";
import {
  SystemStatusError,
  SystemStatusService,
  type SystemStatusDependencies,
} from "./status-service.js";

const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_LIFETIME_MS = 45_000;
const DEFAULT_EVENT_RECONNECT_MS = 3_000;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function readPrincipal(request: FastifyRequest, reply: FastifyReply) {
  const session = request.server.sessionService.resolveAndRefresh(
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
  return requirePermission(session?.principal, "acquisition.manage");
}

function boundedEventTiming(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

export interface SystemStatusRoutesOptions {
  dependencies?: SystemStatusDependencies;
  eventDependencies?: SystemStatusEventBrokerDependencies & {
    connectionLifetimeMs?: number;
    heartbeatIntervalMs?: number;
    reconnectDelayMs?: number;
  };
}

export const systemStatusRoutes: FastifyPluginAsync<SystemStatusRoutesOptions> = async (
  app,
  options,
) => {
  const status = new SystemStatusService(app.database, app.appConfig, options.dependencies);
  const eventBroker = new SystemStatusEventBroker(status, {
    ...options.eventDependencies,
    drainSignal: app.runtimeDrain.signal,
    onFailure: (error) => {
      app.log.warn(
        {
          ...safeFailureDiagnostics(error),
          operation: "system.status.events.refresh",
        },
        "Live system status refresh failed",
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
    "/v1/system/status/events",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      const lastEventIdHeader = request.headers["last-event-id"];
      let lastEventId: string | undefined;
      if (lastEventIdHeader !== undefined) {
        const parsed = systemStatusEventCursorSchema.safeParse(lastEventIdHeader);
        if (!parsed.success) {
          throw new SafeHttpError({
            code: "system_status_event_cursor_invalid",
            message: "The system status resume cursor is invalid.",
            statusCode: 400,
          });
        }
        lastEventId = parsed.data;
      }

      let closed = false;
      let hijacked = false;
      const state: {
        heartbeat?: ReturnType<typeof setInterval>;
        lifetime?: ReturnType<typeof setTimeout>;
        subscription?: SystemStatusEventSubscription;
      } = {};
      const operationAborted = () =>
        request.operationSignal.aborted || app.runtimeDrain.signal.aborted;
      const close = () => {
        if (closed) return;
        closed = true;
        if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
        if (state.lifetime !== undefined) clearTimeout(state.lifetime);
        request.raw.off("aborted", close);
        reply.raw.off("close", close);
        if (state.subscription?.accepted) state.subscription.unsubscribe();
        if (hijacked && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      if (operationAborted()) return;
      state.subscription = eventBroker.subscribe({
        ...(lastEventId === undefined ? {} : { lastEventId }),
        onClose: close,
        onEvent: (event) => {
          if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
          reply.raw.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        principal,
      });
      if (!state.subscription.accepted) {
        if (operationAborted() || state.subscription.reason === "closed") return;
        reply.header("retry-after", Math.ceil(eventReconnectMs / 1_000));
        throw new SafeHttpError({
          code: "system_status_event_capacity_reached",
          message: "Live system updates are temporarily at capacity.",
          statusCode: 429,
        });
      }

      if (operationAborted()) {
        close();
        return;
      }
      reply.hijack();
      hijacked = true;
      if (operationAborted()) {
        close();
        return;
      }
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
      state.heartbeat = setInterval(() => {
        if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(": keep-alive\n\n");
        }
      }, eventHeartbeatMs);
      state.heartbeat.unref();
      state.lifetime = setTimeout(close, eventLifetimeMs);
      state.lifetime.unref();
      request.raw.once("aborted", close);
      reply.raw.once("close", close);
    },
  );

  app.get(
    "/v1/system/status",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: systemStatusResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return systemStatusResponseSchema.parse(
          await status.read({ principal }, request.operationSignal),
        );
      } catch (error) {
        if (error instanceof SystemStatusError) {
          throw new SafeHttpError({
            cause: error,
            code: "system_status_configuration_unavailable",
            message: "System telemetry configuration is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
    },
  );
};
