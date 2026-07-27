import {
  idempotencyKeySchema,
  mediaRequestInputSchema,
  mediaRequestResponseJsonSchema,
  mediaRequestResponseSchema,
} from "@omnifin/contracts/requests";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
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
  switch (error.reason) {
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

  app.post(
    "/v1/requests",
    {
      bodyLimit: 2 * 1_024,
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
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = await mediaRequests.create(
          input,
          idempotencyKey,
          {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          },
          controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return mediaRequestResponseSchema.parse(result.request);
      } catch (error) {
        if (error instanceof MediaRequestServiceError) throw requestError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
