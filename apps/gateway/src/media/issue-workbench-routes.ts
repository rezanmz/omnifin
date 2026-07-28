import {
  mediaIssueFilterSchema,
  mediaIssueSourceFilterSchema,
  mediaIssueStatusUpdateJsonSchema,
  mediaIssueStatusUpdateSchema,
  mediaIssueWorkbenchItemJsonSchema,
  mediaIssueWorkbenchItemSchema,
  mediaIssueWorkbenchPageJsonSchema,
  mediaIssueWorkbenchPageSchema,
  playbackIssueIdSchema,
} from "@omnifin/contracts/issues";
import { idempotencyKeySchema } from "@omnifin/contracts/requests";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  IssueWorkbenchService,
  IssueWorkbenchServiceError,
  type IssueWorkbenchDependencies,
} from "./issue-workbench-service.js";

const workbenchWireQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    source: mediaIssueSourceFilterSchema.optional(),
    status: mediaIssueFilterSchema.optional(),
  })
  .transform((query) => ({
    limit: query.limit ?? 20,
    source: query.source ?? "all",
    status: query.status ?? "open",
  }));
const issueParamsSchema = z.strictObject({ issueId: playbackIssueIdSchema });

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function workbenchError(error: IssueWorkbenchServiceError, reply: FastifyReply) {
  switch (error.reason) {
    case "issue_not_found":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_not_found",
        message: "The issue is no longer available.",
        statusCode: 404,
      });
    case "issue_conflict":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_conflict",
        message: "The issue changed before this decision could be applied.",
        statusCode: 409,
      });
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for another issue decision.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "media_issue_outcome_pending",
        message: "The outcome of this issue decision is still being determined.",
        statusCode: 409,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_response_invalid",
        message: "Seerr returned an issue response that could not be safely interpreted.",
        statusCode: 502,
      });
    case "principal_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_principal_unavailable",
        message: "An active operator account is required to manage issues.",
        statusCode: 403,
      });
    case "configuration_unavailable":
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_configuration_unavailable",
        message: "Issue management is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "media_issue_temporarily_unavailable",
        message: "Issue management is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

export interface IssueWorkbenchRoutesOptions {
  dependencies?: IssueWorkbenchDependencies;
}

export const issueWorkbenchRoutes: FastifyPluginAsync<IssueWorkbenchRoutesOptions> = async (
  app,
  options,
) => {
  const workbench = new IssueWorkbenchService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/issues",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: mediaIssueWorkbenchPageJsonSchema } },
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
      const principal = requirePermission(session?.principal, "issue.manage");
      const query = workbenchWireQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return mediaIssueWorkbenchPageSchema.parse(
          await workbench.list(query, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof IssueWorkbenchServiceError) throw workbenchError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  app.post(
    "/v1/issues/:issueId/status",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      preValidation: (request, _reply, done) => {
        try {
          mediaIssueStatusUpdateSchema.parse(request.body);
          done();
        } catch (error) {
          done(error as Error);
        }
      },
      schema: {
        body: mediaIssueStatusUpdateJsonSchema,
        response: { 200: mediaIssueWorkbenchItemJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "issue.manage",
      );
      const { issueId } = issueParamsSchema.parse(request.params);
      const input = mediaIssueStatusUpdateSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        const result = await workbench.updateStatus(
          issueId,
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          controller.signal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        return mediaIssueWorkbenchItemSchema.parse(result.issue);
      } catch (error) {
        if (error instanceof IssueWorkbenchServiceError) throw workbenchError(error, reply);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
