import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  savedMembershipSummaryJsonSchema,
  savedMembershipSummarySchema,
  savedOwnedTargetIssueRequestJsonSchema,
  savedOwnedTargetIssueRequestSchema,
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

function operationContext(request: FastifyRequest, reply: FastifyReply): SavedTargetContext {
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
    principal: requirePermission(
      validatedPrincipal ?? session?.principal,
      "saved.lists.self.manage",
    ),
  };
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function serviceError(error: SavedTargetServiceError) {
  switch (error.reason) {
    case "not_found":
      return new SafeHttpError({
        cause: error,
        code: "saved_target_not_found",
        message: "The selected library title is no longer available for saving.",
        statusCode: 404,
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
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const summary = await targets.issueOwned(
          referenceId,
          operationContext(request, reply),
          controller.signal,
        );
        reply.status(201);
        return savedMembershipSummarySchema.parse(summary);
      } catch (error) {
        if (error instanceof SavedTargetServiceError) throw serviceError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
