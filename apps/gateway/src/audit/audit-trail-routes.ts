import {
  AUDIT_EVENT_PAGE_MAX_COUNT,
  auditEventListQuerySchema,
  auditEventListResponseJsonSchema,
  auditEventListResponseSchema,
} from "@omnifin/contracts/audit";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  AuditTrailError,
  AuditTrailService,
  type AuditTrailDependencies,
} from "./audit-trail-service.js";

const categories = [
  "access",
  "acquisition",
  "authentication",
  "configuration",
  "downloads",
  "indexers",
  "issues",
  "library",
  "requests",
  "system",
] as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function authorizedPrincipal(principal: SessionPrincipal | null | undefined) {
  if (principal?.authenticationMethod.kind === "recovery") {
    throw new SafeHttpError({
      code: "permission_denied",
      message: "Recovery access cannot inspect the audit trail.",
      statusCode: 403,
    });
  }
  return requirePermission(principal, "audit.view");
}

function auditError(error: AuditTrailError) {
  switch (error.reason) {
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "audit_cursor_invalid",
        message: "The audit trail cursor is not valid for this view.",
        statusCode: 400,
      });
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "permission_denied",
        message: "This session cannot inspect the audit trail.",
        statusCode: 403,
      });
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "audit_trail_unavailable",
        message: "The audit trail is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

export interface AuditTrailRoutesOptions {
  dependencies?: AuditTrailDependencies;
}

export const auditTrailRoutes: FastifyPluginAsync<AuditTrailRoutesOptions> = async (
  app,
  options,
) => {
  const auditTrail = new AuditTrailService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/admin/audit-events",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { enum: categories },
            cursor: {
              type: "string",
              minLength: 64,
              maxLength: 512,
              pattern: "^audit_cursor_v2\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{22}$",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: AUDIT_EVENT_PAGE_MAX_COUNT,
            },
            outcome: { enum: ["success", "denied", "failure"] },
          },
        },
        response: { 200: auditEventListResponseJsonSchema },
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
      const principal = authorizedPrincipal(session?.principal);
      try {
        return auditEventListResponseSchema.parse(
          auditTrail.list(auditEventListQuerySchema.parse(request.query), principal),
        );
      } catch (error) {
        if (error instanceof AuditTrailError) throw auditError(error);
        throw error;
      }
    },
  );
};
