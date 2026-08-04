import {
  savedListCreateRequestJsonSchema,
  savedListCreateRequestSchema,
  savedListDeleteResponseJsonSchema,
  savedListDeleteResponseSchema,
  savedListIdempotencyKeySchema,
  savedListIdSchema,
  savedCatalogReferenceIdSchema,
  savedListMembershipRequestJsonSchema,
  savedListMembershipRequestSchema,
  savedListMembershipDeleteResponseJsonSchema,
  savedListMembershipDeleteResponseSchema,
  savedListMembershipResponseJsonSchema,
  savedListMembershipResponseSchema,
  savedListItemsQueryJsonSchema,
  savedListItemsQuerySchema,
  savedListItemsResponseJsonSchema,
  savedListItemsResponseSchema,
  savedListMutationResponseJsonSchema,
  savedListMutationResponseSchema,
  savedListReorderRequestJsonSchema,
  savedListReorderRequestSchema,
  savedListReorderResponseJsonSchema,
  savedListReorderResponseSchema,
  savedListRestoreRequestJsonSchema,
  savedListRestoreRequestSchema,
  savedListsQueryJsonSchema,
  savedListsQuerySchema,
  savedListsResponseJsonSchema,
  savedListsResponseSchema,
  savedListUpdateRequestJsonSchema,
  savedListUpdateRequestSchema,
} from "@omnifin/contracts/saved";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  ContinueWatchingError,
  ContinueWatchingService,
  type ContinueWatchingDependencies,
  MediaArtworkError,
} from "../media/continue-watching-service.js";
import {
  SavedListService,
  SavedListServiceError,
  type SavedListContext,
  type SavedListServiceDependencies,
} from "./list-service.js";

const listParamsSchema = z.strictObject({ listId: savedListIdSchema });
const membershipParamsSchema = z.strictObject({
  catalogReferenceId: savedCatalogReferenceIdSchema,
  listId: savedListIdSchema,
});
const artworkParamsSchema = z.strictObject({
  catalogReferenceId: savedCatalogReferenceIdSchema,
  kind: z.enum(["backdrop", "poster"]),
});
const listParamsJsonSchema = {
  additionalProperties: false,
  properties: { listId: { pattern: "^saved_list_[A-Za-z0-9_-]{22}$", type: "string" } },
  required: ["listId"],
  type: "object",
} as const;
const membershipParamsJsonSchema = {
  additionalProperties: false,
  properties: {
    catalogReferenceId: {
      pattern: "^catalog_[A-Za-z0-9_-]{22}$",
      type: "string",
    },
    listId: { pattern: "^saved_list_[A-Za-z0-9_-]{22}$", type: "string" },
  },
  required: ["listId", "catalogReferenceId"],
  type: "object",
} as const;
const artworkParamsJsonSchema = {
  additionalProperties: false,
  properties: {
    catalogReferenceId: {
      pattern: "^catalog_[A-Za-z0-9_-]{22}$",
      type: "string",
    },
    kind: { enum: ["backdrop", "poster"] },
  },
  required: ["catalogReferenceId", "kind"],
  type: "object",
} as const;
const STRONG_ETAG_PATTERN = /^"saved_[A-Za-z0-9_-]{22}"$/u;

function operationContext(request: FastifyRequest, reply: FastifyReply): SavedListContext {
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
    principal: requirePermission(
      validatedPrincipal ?? session?.principal,
      "saved.lists.self.manage",
    ),
    requestId: request.id,
  };
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function idempotencyKey(request: FastifyRequest) {
  return savedListIdempotencyKeySchema.parse(request.headers["idempotency-key"]);
}

function ifMatch(request: FastifyRequest) {
  const value = request.headers["if-match"];
  if (value === undefined) {
    throw new SafeHttpError({
      code: "saved_list_precondition_required",
      message: "Refresh this private list before changing it.",
      statusCode: 428,
    });
  }
  if (typeof value !== "string" || !STRONG_ETAG_PATTERN.test(value)) {
    throw new SafeHttpError({
      code: "saved_list_precondition_invalid",
      message: "The saved-list version proof is malformed.",
      statusCode: 400,
    });
  }
  return value;
}

function handleServiceError(error: SavedListServiceError, reply: FastifyReply) {
  switch (error.reason) {
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_cursor_invalid",
        message: "The private-list continuation cursor is invalid or no longer current.",
        statusCode: 400,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different saved-list operation.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "saved_list_operation_in_progress",
        message: "This saved-list operation is still in progress.",
        statusCode: 409,
      });
    case "list_immutable":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_immutable",
        message: "Watch Later cannot be renamed or deleted.",
        statusCode: 409,
      });
    case "list_item_quota_reached":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_item_quota_reached",
        message: "This private list has reached its title limit.",
        statusCode: 409,
      });
    case "list_not_found":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_not_found",
        message: "The private list does not exist.",
        statusCode: 404,
      });
    case "list_not_deleted":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_not_deleted",
        message: "Only a recently deleted private list can be restored.",
        statusCode: 409,
      });
    case "list_quota_reached":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_quota_reached",
        message: "This account has reached the private-list limit.",
        statusCode: 409,
      });
    case "principal_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_principal_unavailable",
        message: "An active linked account is required for private lists.",
        statusCode: 403,
      });
    case "reorder_window_changed":
      return new SafeHttpError({
        cause: error,
        code: "saved_reorder_window_changed",
        message: "The selected titles moved. Refresh this private list before reordering it.",
        statusCode: 409,
      });
    case "revision_stale":
      if (error.currentEtag) reply.header("etag", error.currentEtag);
      return new SafeHttpError({
        cause: error,
        code: "saved_list_revision_stale",
        ...(error.currentEtag ? { details: { currentEtag: error.currentEtag } } : {}),
        message: "This private list changed. Refresh it before trying again.",
        statusCode: 412,
      });
    case "undo_expired":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_undo_expired",
        message: "The private-list undo window has expired.",
        statusCode: 410,
      });
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "saved_list_temporarily_unavailable",
        message: "Private lists are temporarily unavailable.",
        statusCode: 503,
      });
    case "target_not_found":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_not_found",
        message: "Refresh this title before saving it.",
        statusCode: 404,
      });
  }
}

function handleError(error: unknown, reply: FastifyReply): never {
  if (error instanceof SavedListServiceError) throw handleServiceError(error, reply);
  throw error;
}

export interface SavedListRoutesOptions {
  artworkDependencies?: ContinueWatchingDependencies;
  dependencies?: SavedListServiceDependencies;
}

export const savedListRoutes: FastifyPluginAsync<SavedListRoutesOptions> = async (app, options) => {
  const saved = new SavedListService(app.database, app.appConfig, options.dependencies);
  const media = new ContinueWatchingService(
    app.database,
    app.appConfig,
    options.artworkDependencies,
  );

  app.get(
    "/v1/saved/lists",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        querystring: savedListsQueryJsonSchema,
        response: { 200: savedListsResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        return savedListsResponseSchema.parse(
          saved.list(savedListsQuerySchema.parse(request.query), operationContext(request, reply)),
        );
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.post(
    "/v1/saved/lists",
    {
      bodyLimit: 4_096,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedListCreateRequestJsonSchema,
        response: { 201: savedListMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const result = saved.create(
          savedListCreateRequestSchema.parse(request.body),
          idempotencyKey(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        reply.header("idempotency-replayed", String(result.replayed));
        reply.header("location", `/v1/saved/lists/${result.body.list.id}`);
        reply.status(201);
        return savedListMutationResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.get(
    "/v1/saved/lists/:listId",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: listParamsJsonSchema,
        response: { 200: savedListMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.read(listId, operationContext(request, reply));
        reply.header("etag", result.etag);
        return savedListMutationResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.patch(
    "/v1/saved/lists/:listId",
    {
      bodyLimit: 4_096,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedListUpdateRequestJsonSchema,
        params: listParamsJsonSchema,
        response: { 200: savedListMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.update(
          listId,
          savedListUpdateRequestSchema.parse(request.body),
          ifMatch(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        return savedListMutationResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.delete(
    "/v1/saved/lists/:listId",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: listParamsJsonSchema,
        response: { 200: savedListDeleteResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.delete(listId, ifMatch(request), operationContext(request, reply));
        reply.header("etag", result.etag);
        return savedListDeleteResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.post(
    "/v1/saved/lists/:listId/restore",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedListRestoreRequestJsonSchema,
        params: listParamsJsonSchema,
        response: { 200: savedListMutationResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.restore(
          listId,
          savedListRestoreRequestSchema.parse(request.body),
          idempotencyKey(request),
          ifMatch(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        reply.header("idempotency-replayed", String(result.replayed));
        return savedListMutationResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.post(
    "/v1/saved/lists/:listId/items",
    {
      bodyLimit: 2_048,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedListMembershipRequestJsonSchema,
        params: listParamsJsonSchema,
        response: { 201: savedListMembershipResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.addItem(
          listId,
          savedListMembershipRequestSchema.parse(request.body),
          idempotencyKey(request),
          ifMatch(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        reply.header("idempotency-replayed", String(result.replayed));
        reply.header("location", `/v1/saved/lists/${listId}/items/${result.body.item.catalog.id}`);
        reply.status(201);
        return savedListMembershipResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.get(
    "/v1/saved/lists/:listId/items",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: listParamsJsonSchema,
        querystring: savedListItemsQueryJsonSchema,
        response: { 200: savedListItemsResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.readItems(
          listId,
          savedListItemsQuerySchema.parse(request.query),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        return savedListItemsResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.delete(
    "/v1/saved/lists/:listId/items/:catalogReferenceId",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: membershipParamsJsonSchema,
        response: { 200: savedListMembershipDeleteResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { catalogReferenceId, listId } = membershipParamsSchema.parse(request.params);
        const result = saved.removeItem(
          listId,
          catalogReferenceId,
          ifMatch(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        return savedListMembershipDeleteResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.patch(
    "/v1/saved/lists/:listId/items/order",
    {
      bodyLimit: 8_192,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: savedListReorderRequestJsonSchema,
        params: listParamsJsonSchema,
        response: { 200: savedListReorderResponseJsonSchema },
      },
    },
    async (request, reply) => {
      try {
        const { listId } = listParamsSchema.parse(request.params);
        const result = saved.reorderItems(
          listId,
          savedListReorderRequestSchema.parse(request.body),
          idempotencyKey(request),
          ifMatch(request),
          operationContext(request, reply),
        );
        reply.header("etag", result.etag);
        reply.header("idempotency-replayed", String(result.replayed));
        return savedListReorderResponseSchema.parse(result.body);
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.get(
    "/v1/saved/catalog/:catalogReferenceId/images/:kind",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 120, timeWindow: "1 minute" },
      },
      schema: { params: artworkParamsJsonSchema },
    },
    async (request, reply) => {
      const context = operationContext(request, reply);
      const params = artworkParamsSchema.parse(request.params);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const referenceId = saved.resolveOwnedArtworkReference(params.catalogReferenceId, context);
        const artwork = await media.readArtwork(
          { principal: context.principal },
          referenceId,
          params.kind,
          controller.signal,
        );
        reply.header("cache-control", "private, max-age=3600, stale-while-revalidate=86400");
        reply.header("content-disposition", "inline");
        reply.header("etag", artwork.etag);
        reply.header("vary", "Cookie, Accept");
        if (request.headers["if-none-match"] === artwork.etag) {
          return reply.status(304).send();
        }
        return reply.type(artwork.contentType).send(Buffer.from(artwork.body));
      } catch (error) {
        if (error instanceof SavedListServiceError) {
          if (error.reason === "target_not_found") {
            throw new SafeHttpError({
              cause: error,
              code: "saved_artwork_not_found",
              message: "The requested saved-title artwork is not available.",
              statusCode: 404,
            });
          }
          handleError(error, reply);
        }
        if (error instanceof MediaArtworkError) {
          throw new SafeHttpError({
            cause: error,
            code:
              error.reason === "not_found"
                ? "saved_artwork_not_found"
                : "saved_artwork_unavailable",
            message:
              error.reason === "not_found"
                ? "The requested saved-title artwork is not available."
                : "Saved-title artwork is temporarily unavailable.",
            statusCode: error.reason === "not_found" ? 404 : 503,
          });
        }
        if (error instanceof ContinueWatchingError) {
          throw new SafeHttpError({
            cause: error,
            code: "saved_artwork_unavailable",
            message: "Saved-title artwork is temporarily unavailable.",
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
