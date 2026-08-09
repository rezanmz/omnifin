import {
  idempotencyKeySchema,
  requestReviewCursorSchema,
  requestReviewDecisionInputSchema,
  requestReviewFilterSchema,
  requestReviewItemJsonSchema,
  requestReviewItemSchema,
  requestReviewPageJsonSchema,
  requestReviewPageSchema,
} from "@omnifin/contracts/requests";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  RequestReviewService,
  RequestReviewServiceError,
  type RequestReviewDependencies,
} from "./request-review-service.js";

const requestReviewWireQuerySchema = z
  .strictObject({
    cursor: requestReviewCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    status: requestReviewFilterSchema.optional(),
  })
  .transform((query) => ({
    cursor: query.cursor ?? null,
    limit: query.limit ?? 20,
    status: query.status ?? "pending",
  }));

const requestReviewParametersSchema = z.strictObject({
  requestId: z.string().trim().min(9).max(64),
});

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function reviewError(error: RequestReviewServiceError, reply: FastifyReply) {
  if (error.operationId) reply.header("operation-id", error.operationId);
  switch (error.reason) {
    case "request_not_found":
      return new SafeHttpError({
        cause: error,
        code: "request_review_not_found",
        message: "The media request is not available for review.",
        statusCode: 404,
      });
    case "request_denied":
      return new SafeHttpError({
        cause: error,
        code: "request_review_denied",
        message: "Seerr denied this media request decision.",
        statusCode: 403,
      });
    case "request_conflict":
      return new SafeHttpError({
        cause: error,
        code: "request_review_conflict",
        message: "The media request is no longer in a reviewable state.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different review decision.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "request_review_outcome_pending",
        message: "The outcome of this review decision is still being determined.",
        statusCode: 409,
      });
    case "request_review_outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "request_review_outcome_uncertain",
        message: "The review outcome is uncertain and will not be changed automatically.",
        statusCode: 409,
      });
    case "request_review_reconcile_required":
      return new SafeHttpError({
        cause: error,
        code: "request_review_reconcile_required",
        message: "The review decision requires reconciliation before another change.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "request_review_response_invalid",
        message: "Seerr returned a response that could not be safely interpreted.",
        statusCode: 502,
      });
    case "principal_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "request_review_principal_unavailable",
        message: "An active operator account is required to review media requests.",
        statusCode: 403,
      });
    case "configuration_unavailable":
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "request_review_configuration_unavailable",
        message: "Media request review is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "request_review_temporarily_unavailable",
        message: "Media request review is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

export interface RequestReviewRoutesOptions {
  dependencies?: RequestReviewDependencies;
}

export const requestReviewRoutes: FastifyPluginAsync<RequestReviewRoutesOptions> = async (
  app,
  options,
) => {
  const reviews = new RequestReviewService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/requests/review",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: requestReviewPageJsonSchema } },
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
      const principal = requirePermission(session?.principal, "request.review");
      const query = requestReviewWireQuerySchema.parse(request.query);
      try {
        return requestReviewPageSchema.parse(
          await reviews.list(query, { principal }, request.operationSignal),
        );
      } catch (error) {
        if (error instanceof RequestReviewServiceError) throw reviewError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/requests/:requestId/review",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: { response: { 200: requestReviewItemJsonSchema } },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "request.review",
      );
      const { requestId } = requestReviewParametersSchema.parse(request.params);
      const input = requestReviewDecisionInputSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      try {
        const result = await reviews.review(
          requestId,
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        return requestReviewItemSchema.parse(result.request);
      } catch (error) {
        if (error instanceof RequestReviewServiceError) throw reviewError(error, reply);
        throw error;
      }
    },
  );
};
