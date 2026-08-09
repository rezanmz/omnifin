import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  acquisitionMonitoringStateJsonSchema,
  acquisitionMonitoringStateSchema,
  acquisitionMonitoringTargetInputJsonSchema,
  acquisitionMonitoringTargetInputSchema,
  acquisitionMonitoringUpdateInputJsonSchema,
  acquisitionMonitoringUpdateInputSchema,
  acquisitionProvenanceEventCursorSchema,
  acquisitionProvenanceResponseJsonSchema,
  acquisitionProvenanceResponseSchema,
  acquisitionQueueRecoveryIdempotencyKeySchema,
  acquisitionQueueRecoveryInputJsonSchema,
  acquisitionQueueRecoveryInputSchema,
  acquisitionQueueRecoveryResponseJsonSchema,
  acquisitionQueueRecoveryResponseSchema,
  acquisitionSearchIdempotencyKeySchema,
  acquisitionSearchInputJsonSchema,
  acquisitionSearchInputSchema,
  acquisitionSearchResponseJsonSchema,
  acquisitionSearchResponseSchema,
  acquisitionTargetInputJsonSchema,
  acquisitionTargetInputSchema,
} from "@omnifin/contracts/acquisition";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import { safeFailureDiagnostics } from "../logger.js";
import {
  AcquisitionProvenanceEventBroker,
  type AcquisitionProvenanceEventBrokerDependencies,
} from "./provenance-events.js";
import {
  AcquisitionProvenanceError,
  AcquisitionProvenanceService,
  type AcquisitionProvenanceDependencies,
} from "./provenance-service.js";

const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_LIFETIME_MS = 45_000;
const DEFAULT_EVENT_RECONNECT_MS = 3_000;

function configurationError(error: AcquisitionProvenanceError) {
  switch (error.reason) {
    case "connector_unconfigured":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_not_configured",
        message: "Acquisition history has not been configured for this service.",
        statusCode: 503,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_configuration_unavailable",
        message: "Acquisition history configuration is temporarily unavailable.",
        statusCode: 503,
      });
    case "configuration_unavailable":
    case "idempotency_conflict":
    case "idempotency_in_progress":
    case "identity_required":
    case "operation_failed":
    case "operation_limit_reached":
    case "outcome_uncertain":
    case "outcome_unconfirmed":
    case "rate_limited":
    case "reference_expired":
    case "reference_invalid":
    case "response_invalid":
    case "stale_state":
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_configuration_unavailable",
        message: "Acquisition history configuration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function searchError(error: AcquisitionProvenanceError, reply: FastifyReply) {
  switch (error.reason) {
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different acquisition search.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_outcome_pending",
        message: "The outcome of this acquisition search is still being determined.",
        statusCode: 409,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_identity_required",
        message: "An active operator account is required to start an acquisition search.",
        statusCode: 403,
      });
    case "rate_limited":
      reply.header("retry-after", "30");
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_rate_limited",
        message: "The acquisition service is cooling down before another search.",
        statusCode: 429,
      });
    case "outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_outcome_uncertain",
        message:
          "The acquisition search may have been queued. Verify acquisition history before acting again.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_response_invalid",
        message: "The acquisition service returned an unexpected command response.",
        statusCode: 502,
      });
    case "connector_unconfigured":
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "configuration_unavailable":
    case "storage_failure":
    case "operation_failed":
    case "operation_limit_reached":
    case "outcome_unconfirmed":
    case "reference_expired":
    case "reference_invalid":
    case "stale_state":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_configuration_unavailable",
        message: "Acquisition search is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_search_temporarily_unavailable",
        message: "The acquisition search could not be safely queued.",
        statusCode: 503,
      });
  }
}

function monitoringError(error: AcquisitionProvenanceError) {
  switch (error.reason) {
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_monitoring_identity_required",
        message: "An active operator account is required to change monitoring.",
        statusCode: 403,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_monitoring_response_invalid",
        message: "The acquisition service did not confirm the exact monitoring state.",
        statusCode: 502,
      });
    case "rate_limited":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_monitoring_rate_limited",
        message: "Monitoring controls are temporarily rate limited.",
        statusCode: 429,
      });
    case "connector_unconfigured":
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "configuration_unavailable":
    case "storage_failure":
    case "operation_failed":
    case "operation_limit_reached":
    case "outcome_uncertain":
    case "outcome_unconfirmed":
    case "reference_expired":
    case "reference_invalid":
    case "stale_state":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_monitoring_configuration_unavailable",
        message: "Monitoring controls are temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
    case "idempotency_conflict":
    case "idempotency_in_progress":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_monitoring_temporarily_unavailable",
        message: "Monitoring controls are temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function recoveryError(error: AcquisitionProvenanceError, reply: FastifyReply) {
  switch (error.reason) {
    case "reference_invalid":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_reference_invalid",
        message: "That recovery reference is invalid. Refresh the timeline before continuing.",
        statusCode: 400,
      });
    case "reference_expired":
    case "stale_state":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_stale",
        message: "That queue item changed or expired. Refresh the timeline before continuing.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different queue recovery.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_pending",
        message: "That exact queue recovery is already in progress.",
        statusCode: 409,
      });
    case "operation_failed":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_failed",
        message: "The previous recovery attempt failed. Refresh before trying again.",
        statusCode: 409,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_identity_required",
        message: "An active operator account is required to recover a queue item.",
        statusCode: 403,
      });
    case "operation_limit_reached":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_limit_reached",
        message: "Too many recovery records are retained for this account.",
        statusCode: 429,
      });
    case "rate_limited":
      reply.header("retry-after", "30");
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_rate_limited",
        message: "Queue recovery is temporarily rate limited.",
        statusCode: 429,
      });
    case "response_invalid":
    case "outcome_unconfirmed":
    case "outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_unconfirmed",
        message: "The exact queue recovery outcome could not be confirmed. Refresh before acting.",
        statusCode: 502,
      });
    case "connector_unconfigured":
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "configuration_unavailable":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_configuration_unavailable",
        message: "Queue recovery is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "acquisition_queue_recovery_temporarily_unavailable",
        message: "The queue item could not be recovered safely.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", error.retryAfterSeconds);
    }
    return new SafeHttpError({
      cause: error,
      code: "acquisition_rate_limited",
      message: "Acquisition history is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "acquisition_response_invalid",
      message: "The acquisition service returned an unexpected response.",
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
      code: "acquisition_configuration_unavailable",
      message: "Acquisition history configuration is temporarily unavailable.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "acquisition_temporarily_unavailable",
    message: "Acquisition history is temporarily unavailable.",
    statusCode: 503,
  });
}

function monitoringUpstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", error.retryAfterSeconds);
    }
    return new SafeHttpError({
      cause: error,
      code: "acquisition_monitoring_rate_limited",
      message: "Monitoring controls are temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "acquisition_monitoring_response_invalid",
      message: "The acquisition service did not confirm the exact monitoring state.",
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
      code: "acquisition_monitoring_configuration_unavailable",
      message: "Monitoring controls are temporarily unavailable due to configuration.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "acquisition_monitoring_temporarily_unavailable",
    message: "Monitoring controls are temporarily unavailable.",
    statusCode: 503,
  });
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function boundedEventTiming(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function copySecurityHeaders(reply: FastifyReply) {
  const contentSecurityPolicy = reply.getHeader("content-security-policy");
  const crossOriginOpenerPolicy = reply.getHeader("cross-origin-opener-policy");
  const crossOriginResourcePolicy = reply.getHeader("cross-origin-resource-policy");
  const originAgentCluster = reply.getHeader("origin-agent-cluster");
  const permissionsPolicy = reply.getHeader("permissions-policy");
  const referrerPolicy = reply.getHeader("referrer-policy");
  const setCookie = reply.getHeader("set-cookie");
  const strictTransportSecurity = reply.getHeader("strict-transport-security");
  const xContentTypeOptions = reply.getHeader("x-content-type-options");
  const xDnsPrefetchControl = reply.getHeader("x-dns-prefetch-control");
  const xDownloadOptions = reply.getHeader("x-download-options");
  const xFrameOptions = reply.getHeader("x-frame-options");
  const xPermittedCrossDomainPolicies = reply.getHeader("x-permitted-cross-domain-policies");
  const xRequestId = reply.getHeader("x-request-id");

  if (contentSecurityPolicy !== undefined)
    reply.raw.setHeader("content-security-policy", contentSecurityPolicy);
  if (crossOriginOpenerPolicy !== undefined)
    reply.raw.setHeader("cross-origin-opener-policy", crossOriginOpenerPolicy);
  if (crossOriginResourcePolicy !== undefined)
    reply.raw.setHeader("cross-origin-resource-policy", crossOriginResourcePolicy);
  if (originAgentCluster !== undefined)
    reply.raw.setHeader("origin-agent-cluster", originAgentCluster);
  if (permissionsPolicy !== undefined) reply.raw.setHeader("permissions-policy", permissionsPolicy);
  if (referrerPolicy !== undefined) reply.raw.setHeader("referrer-policy", referrerPolicy);
  if (setCookie !== undefined) reply.raw.setHeader("set-cookie", setCookie);
  if (strictTransportSecurity !== undefined)
    reply.raw.setHeader("strict-transport-security", strictTransportSecurity);
  if (xContentTypeOptions !== undefined)
    reply.raw.setHeader("x-content-type-options", xContentTypeOptions);
  if (xDnsPrefetchControl !== undefined)
    reply.raw.setHeader("x-dns-prefetch-control", xDnsPrefetchControl);
  if (xDownloadOptions !== undefined) reply.raw.setHeader("x-download-options", xDownloadOptions);
  if (xFrameOptions !== undefined) reply.raw.setHeader("x-frame-options", xFrameOptions);
  if (xPermittedCrossDomainPolicies !== undefined)
    reply.raw.setHeader("x-permitted-cross-domain-policies", xPermittedCrossDomainPolicies);
  if (xRequestId !== undefined) reply.raw.setHeader("x-request-id", xRequestId);
}

export interface AcquisitionProvenanceRoutesOptions {
  dependencies?: AcquisitionProvenanceDependencies;
  eventDependencies?: AcquisitionProvenanceEventBrokerDependencies & {
    connectionLifetimeMs?: number;
    heartbeatIntervalMs?: number;
    reconnectDelayMs?: number;
  };
}

export const acquisitionProvenanceRoutes: FastifyPluginAsync<
  AcquisitionProvenanceRoutesOptions
> = async (app, options) => {
  const provenance = new AcquisitionProvenanceService(
    app.database,
    app.appConfig,
    options.dependencies,
  );
  const eventBroker = new AcquisitionProvenanceEventBroker(provenance, {
    ...options.eventDependencies,
    onFailure: (error) => {
      app.log.warn(
        {
          ...safeFailureDiagnostics(error),
          operation: "acquisition.provenance.events.refresh",
        },
        "Live acquisition provenance refresh failed",
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
    "/v1/acquisitions/provenance",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: acquisitionTargetInputJsonSchema,
        response: { 200: acquisitionProvenanceResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "acquisition.manage");
      try {
        return acquisitionProvenanceResponseSchema.parse(
          await provenance.read(
            acquisitionTargetInputSchema.parse(request.query),
            { principal },
            request.operationSignal,
          ),
        );
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw configurationError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.get(
    "/v1/acquisitions/provenance/events",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { querystring: acquisitionTargetInputJsonSchema },
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
      const principal = requirePermission(session?.principal, "acquisition.manage");
      const target = acquisitionTargetInputSchema.parse(request.query);
      const lastEventIdHeader = request.headers["last-event-id"];
      let lastEventId: string | undefined;
      if (lastEventIdHeader !== undefined) {
        const parsed = acquisitionProvenanceEventCursorSchema.safeParse(lastEventIdHeader);
        if (!parsed.success) {
          throw new SafeHttpError({
            code: "acquisition_provenance_event_cursor_invalid",
            message: "The acquisition provenance resume cursor is invalid.",
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
        request.raw.off("aborted", close);
        reply.raw.off("close", close);
        app.runtimeDrain.signal.removeEventListener("abort", close);
        if (subscription.accepted) subscription.unsubscribe();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      const subscription = eventBroker.subscribe({
        ...(lastEventId === undefined ? {} : { lastEventId }),
        onClose: close,
        onEvent: (event) => {
          if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
          reply.raw.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        principal,
        target,
      });
      if (!subscription.accepted) {
        reply.header("retry-after", Math.ceil(eventReconnectMs / 1_000));
        throw new SafeHttpError({
          code: "acquisition_provenance_event_capacity_reached",
          message: "Live acquisition provenance is temporarily at capacity.",
          statusCode: 429,
        });
      }

      reply.hijack();
      copySecurityHeaders(reply);
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
      app.runtimeDrain.signal.addEventListener("abort", close, { once: true });
      if (app.runtimeDrain.signal.aborted) close();
    },
  );

  app.get(
    "/v1/acquisitions/monitoring",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: acquisitionMonitoringTargetInputJsonSchema,
        response: { 200: acquisitionMonitoringStateJsonSchema },
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
      const principal = requirePermission(session?.principal, "acquisition.manage");
      try {
        return acquisitionMonitoringStateSchema.parse(
          await provenance.readMonitoring(
            acquisitionMonitoringTargetInputSchema.parse(request.query),
            { principal },
            request.operationSignal,
          ),
        );
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw monitoringError(error);
        if (error instanceof SafeConnectorError) throw monitoringUpstreamError(error, reply);
        throw error;
      }
    },
  );

  app.put(
    "/v1/acquisitions/monitoring",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: acquisitionMonitoringUpdateInputJsonSchema,
        response: { 200: acquisitionMonitoringStateJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      try {
        return acquisitionMonitoringStateSchema.parse(
          await provenance.updateMonitoring(
            acquisitionMonitoringUpdateInputSchema.parse(request.body),
            { ipAddress: request.ip, principal, requestId: request.id },
            request.operationSignal,
          ),
        );
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw monitoringError(error);
        if (error instanceof SafeConnectorError) throw monitoringUpstreamError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/acquisitions/searches",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: acquisitionSearchInputJsonSchema,
        response: {
          200: acquisitionSearchResponseJsonSchema,
          201: acquisitionSearchResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      const input = acquisitionSearchInputSchema.parse(request.body);
      const idempotencyKey = acquisitionSearchIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      try {
        const result = await provenance.queueSearch(
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return acquisitionSearchResponseSchema.parse(result.search);
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw searchError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/acquisitions/queue-recoveries",
    {
      bodyLimit: 4 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: acquisitionQueueRecoveryInputJsonSchema,
        response: {
          200: acquisitionQueueRecoveryResponseJsonSchema,
          201: acquisitionQueueRecoveryResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      const input = acquisitionQueueRecoveryInputSchema.parse(request.body);
      const idempotencyKey = acquisitionQueueRecoveryIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      try {
        const result = await provenance.recoverQueueItem(
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return acquisitionQueueRecoveryResponseSchema.parse(result.recovery);
      } catch (error) {
        if (error instanceof AcquisitionProvenanceError) throw recoveryError(error, reply);
        throw error;
      }
    },
  );
};
