import {
  idempotencyKeySchema,
  mediaRequestInputSchema,
  mediaRequestResponseJsonSchema,
  mediaRequestResponseSchema,
  mediaRequestRoutingOptionsQuerySchema,
  mediaRequestRoutingOptionsResponseJsonSchema,
  mediaRequestRoutingOptionsResponseSchema,
  mediaRequestRoutingPreferenceInputJsonSchema,
  mediaRequestRoutingPreferenceInputSchema,
} from "@omnifin/contracts/requests";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  MediaRequestService,
  MediaRequestServiceError,
  type MediaRequestDependencies,
} from "./media-request-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function requestError(error: MediaRequestServiceError, reply: FastifyReply) {
  if (error.operationId) reply.header("operation-id", error.operationId);
  switch (error.reason) {
    case "title_already_owned":
      return new SafeHttpError({
        cause: error,
        code: "request_title_already_owned",
        message: "This title is already available in the linked Jellyfin library.",
        statusCode: 409,
      });
    case "availability_unverified":
      return new SafeHttpError({
        cause: error,
        code: "request_availability_unverified",
        message: "Jellyfin ownership could not be verified before creating the request.",
        statusCode: 503,
      });
    case "identity_link_required":
      return new SafeHttpError({
        cause: error,
        code: "request_identity_link_required",
        message: "Link a Jellyfin account before requesting media.",
        statusCode: 409,
      });
    case "identity_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "request_identity_unavailable",
        message: "The linked Jellyfin user is not available in Seerr.",
        statusCode: 409,
      });
    case "request_denied":
      return new SafeHttpError({
        cause: error,
        code: "request_denied",
        message: "Seerr denied this request for the linked user.",
        statusCode: 403,
      });
    case "no_seasons_available":
      return new SafeHttpError({
        cause: error,
        code: "request_no_seasons_available",
        message: "No unrequested seasons are available for this title.",
        statusCode: 409,
      });
    case "request_conflict":
      return new SafeHttpError({
        cause: error,
        code: "request_already_exists",
        message: "A matching media request already exists.",
        statusCode: 409,
      });
    case "routing_invalid":
      return new SafeHttpError({
        cause: error,
        code: "request_routing_invalid",
        message: "The selected request routing expired or is no longer valid.",
        statusCode: 409,
      });
    case "routing_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "request_routing_unavailable",
        message: "No healthy default destination can route the selected format.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different request.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "request_outcome_pending",
        message: "The outcome of this request is still being determined.",
        statusCode: 409,
      });
    case "request_outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "request_outcome_uncertain",
        message: "The media request outcome is uncertain and will not be sent again.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "request_response_invalid",
        message: "Seerr returned a response that could not be safely interpreted.",
        statusCode: 502,
      });
    case "configuration_unavailable":
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "request_configuration_unavailable",
        message: "Media requests are temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "request_temporarily_unavailable",
        message: "Media requests are temporarily unavailable.",
        statusCode: 503,
      });
  }
}

export interface MediaRequestRoutesOptions {
  dependencies?: MediaRequestDependencies;
}

export const mediaRequestRoutes: FastifyPluginAsync<MediaRequestRoutesOptions> = async (
  app,
  options,
) => {
  const mediaRequests = new MediaRequestService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/requests/routing-options",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        response: { 200: mediaRequestRoutingOptionsResponseJsonSchema },
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
      const principal = requirePermission(session?.principal, "request.create");
      const query = mediaRequestRoutingOptionsQuerySchema.parse(request.query);
      try {
        return mediaRequestRoutingOptionsResponseSchema.parse(
          await mediaRequests.routingOptions(
            query,
            {
              ipAddress: request.ip,
              principal,
              requestId: request.id,
            },
            request.operationSignal,
          ),
        );
      } catch (error) {
        if (error instanceof MediaRequestServiceError) throw requestError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/requests",
    {
      bodyLimit: 8 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        response: {
          200: mediaRequestResponseJsonSchema,
          201: mediaRequestResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "request.create",
      );
      const input = mediaRequestInputSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      try {
        const result = await mediaRequests.create(
          input,
          idempotencyKey,
          {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return mediaRequestResponseSchema.parse(result.request);
      } catch (error) {
        if (error instanceof MediaRequestServiceError) throw requestError(error, reply);
        throw error;
      }
    },
  );

  app.put(
    "/v1/requests/routing-preference",
    {
      bodyLimit: 8 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: { body: mediaRequestRoutingPreferenceInputJsonSchema },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "connectors.manage",
      );
      const input = mediaRequestRoutingPreferenceInputSchema.parse(request.body);
      try {
        await mediaRequests.setRoutingPreference(
          input,
          {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          },
          request.operationSignal,
        );
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof MediaRequestServiceError) throw requestError(error, reply);
        throw error;
      }
    },
  );
};
