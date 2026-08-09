import type { Permission } from "@omnifin/contracts/auth";
import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  savedDiscoveryTargetIssueRequestJsonSchema,
  savedDiscoveryTargetIssueRequestSchema,
  savedFavoriteMutationRequestJsonSchema,
  savedFavoriteMutationRequestSchema,
  savedFavoriteMutationResponseJsonSchema,
  savedFavoriteMutationResponseSchema,
  savedListIdempotencyKeySchema,
  savedMembershipSummaryJsonSchema,
  savedMembershipSummarySchema,
  savedOwnedTargetIssueRequestJsonSchema,
  savedOwnedTargetIssueRequestSchema,
  savedTargetReferenceIdSchema,
} from "@omnifin/contracts/saved";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  SavedTargetService,
  SavedTargetServiceError,
  type SavedTargetContext,
  type SavedTargetServiceDependencies,
} from "./target-service.js";

const paramsSchema = z.strictObject({ referenceId: mediaReferenceIdSchema });
const paramsJsonSchema = {
  additionalProperties: false,
  properties: { referenceId: { pattern: "^media_[A-Za-z0-9_-]{22}$", type: "string" } },
  required: ["referenceId"],
  type: "object",
} as const;
const favoriteParamsSchema = z.strictObject({ targetReferenceId: savedTargetReferenceIdSchema });
const favoriteParamsJsonSchema = {
  additionalProperties: false,
  properties: {
    targetReferenceId: {
      pattern: "^save_target_[A-Za-z0-9_-]{22}$",
      type: "string",
    },
  },
  required: ["targetReferenceId"],
  type: "object",
} as const;

function operationContext(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): SavedTargetContext {
  const validatedPrincipal = request.server.sessionService.resolveValidatedSessionPrincipal(
    request.validatedSession,
  );
  const session = validatedPrincipal
    ? undefined
    : request.server.sessionService.resolveAndRefresh(
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
  return {
    ipAddress: request.ip,
    principal: requirePermission(validatedPrincipal ?? session?.principal, permission),
    requestId: request.id,
  };
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function serviceError(
  error: SavedTargetServiceError,
  reply: FastifyReply,
  operation: "favorite" | "target" = "target",
) {
  switch (error.reason) {
    case "connector_unavailable":
      reply.header("retry-after", "5");
      return new SafeHttpError({
        cause: error,
        code:
          operation === "favorite"
            ? "saved_favorite_connector_unavailable"
            : "saved_target_connector_unavailable",
        message:
          operation === "favorite"
            ? "Jellyfin could not confirm the favorite change. Try again shortly."
            : "The connected catalog could not confirm this title. Try again shortly.",
        statusCode: 503,
      });
    case "expired":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_expired",
        message: "This private save target expired. Refresh the title and try again.",
        statusCode: 410,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The retry key was already used for a different favorite state.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "saved_favorite_operation_in_progress",
        message: "This favorite change is still being reconciled.",
        statusCode: 409,
      });
    case "not_found":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_not_found",
        message: "The selected library title is no longer available for saving.",
        statusCode: 404,
      });
    case "outcome_unknown":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "saved_favorite_outcome_unknown",
        message: "Jellyfin may have applied this favorite change. Retry to reconcile its state.",
        statusCode: 503,
      });
    case "principal_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_principal_unavailable",
        message: "An active linked account is required to save this title.",
        statusCode: 403,
      });
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_temporarily_unavailable",
        message: "Saving this title is temporarily unavailable.",
        statusCode: 503,
      });
    case "synchronization_failed":
      return new SafeHttpError({
        cause: error,
        code: "saved_favorite_not_confirmed",
        message: "Jellyfin did not retain the requested favorite state.",
        statusCode: 502,
      });
  }
}

export interface SavedTargetRoutesOptions {
  dependencies?: SavedTargetServiceDependencies;
}

export const savedTargetRoutes: FastifyPluginAsync<SavedTargetRoutesOptions> = async (
  app,
  options,
) => {
  const targets = new SavedTargetService(app.database, app.appConfig, options.dependencies);

  app.post(
    "/v1/saved/targets/library/:referenceId",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedOwnedTargetIssueRequestJsonSchema,
        params: paramsJsonSchema,
        response: { 201: savedMembershipSummaryJsonSchema },
      },
    },
    async (request, reply) => {
      savedOwnedTargetIssueRequestSchema.parse(request.body);
      const { referenceId } = paramsSchema.parse(request.params);
      try {
        const summary = await targets.issueOwned(
          referenceId,
          operationContext(request, reply, "saved.lists.self.manage"),
          request.operationSignal,
        );
        reply.status(201);
        return savedMembershipSummarySchema.parse(summary);
      } catch (error) {
        if (error instanceof SavedTargetServiceError) throw serviceError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/saved/targets/discovery",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedDiscoveryTargetIssueRequestJsonSchema,
        response: { 201: savedMembershipSummaryJsonSchema },
      },
    },
    async (request, reply) => {
      const input = savedDiscoveryTargetIssueRequestSchema.parse(request.body);
      try {
        const summary = await targets.issueDiscovery(
          input,
          operationContext(request, reply, "saved.lists.self.manage"),
          request.operationSignal,
        );
        reply.status(201);
        return savedMembershipSummarySchema.parse(summary);
      } catch (error) {
        if (error instanceof SavedTargetServiceError) throw serviceError(error, reply);
        throw error;
      }
    },
  );

  app.put(
    "/v1/saved/favorites/:targetReferenceId",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedFavoriteMutationRequestJsonSchema,
        params: favoriteParamsJsonSchema,
        response: { 200: savedFavoriteMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const input = savedFavoriteMutationRequestSchema.parse(request.body);
      const { targetReferenceId } = favoriteParamsSchema.parse(request.params);
      try {
        const result = await targets.updateFavorite(
          targetReferenceId,
          input,
          savedListIdempotencyKeySchema.parse(request.headers["idempotency-key"]),
          operationContext(request, reply, "favorites.self.manage"),
          request.operationSignal,
        );
        return savedFavoriteMutationResponseSchema.parse(result);
      } catch (error) {
        if (error instanceof SavedTargetServiceError) throw serviceError(error, reply, "favorite");
        throw error;
      }
    },
  );
};
