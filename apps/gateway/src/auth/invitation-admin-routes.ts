import {
  INVITATION_MAX_TTL_SECONDS,
  INVITATION_MIN_TTL_SECONDS,
  INVITATIONS_PAGE_MAX_COUNT,
  invitationAdminParamsSchema,
  invitationCreateRequestSchema,
  invitationCreateResponseSchema,
  invitationListQuerySchema,
  invitationListResponseSchema,
  invitationRevokeResponseSchema,
} from "@omnifin/contracts/invitations";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { SafeHttpError } from "../http-error.js";
import { requirePermission } from "./authorization.js";
import { sessionCookieName, writeSessionCookie } from "./session-cookie.js";
import {
  InvitationService,
  InvitationServiceError,
  type InvitationServiceDependencies,
  type InvitationAdminContext,
} from "./invitation-service.js";

const identifierJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
} as const;

const dateTimeJsonSchema = { type: "string", format: "date-time", maxLength: 64 } as const;

const invitationSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["consumedAt", "createdAt", "expiresAt", "id", "revokedAt", "status"],
  properties: {
    consumedAt: { anyOf: [dateTimeJsonSchema, { type: "null" }] },
    createdAt: dateTimeJsonSchema,
    expiresAt: dateTimeJsonSchema,
    id: identifierJsonSchema,
    revokedAt: { anyOf: [dateTimeJsonSchema, { type: "null" }] },
    status: { enum: ["active", "expired", "consumed", "revoked"] },
  },
} as const;

const createResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["invitation", "invitationUrl"],
  properties: {
    invitation: invitationSummaryJsonSchema,
    invitationUrl: { type: "string", format: "uri", maxLength: 2_048 },
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: InvitationServiceError): SafeHttpError {
  switch (error.reason) {
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "permission_denied",
        message: "This session cannot administer invitations.",
        statusCode: 403,
      });
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "invitation_cursor_invalid",
        message: "The invitation cursor is not valid.",
        statusCode: 400,
      });
    case "invitation_not_found":
      return new SafeHttpError({
        cause: error,
        code: "invitation_not_found",
        message: "The invitation does not exist.",
        statusCode: 404,
      });
    case "invitation_expired":
      return new SafeHttpError({
        cause: error,
        code: "invitation_expired",
        message: "The invitation has expired.",
        statusCode: 409,
      });
    case "invitation_consumed":
      return new SafeHttpError({
        cause: error,
        code: "invitation_consumed",
        message: "The invitation has already been consumed.",
        statusCode: 409,
      });
    case "invitation_revoked":
      return new SafeHttpError({
        cause: error,
        code: "invitation_revoked",
        message: "The invitation has already been revoked.",
        statusCode: 409,
      });
    case "registration_handoff_invalid":
      return new SafeHttpError({
        cause: error,
        code: "invitation_unavailable",
        message: "Invitation administration is temporarily unavailable.",
        statusCode: 503,
      });
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "invitation_unavailable",
        message: "Invitation administration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function requireInvitationAdministrator(principal: Parameters<typeof requirePermission>[0]) {
  const authorized = requirePermission(principal, "identities.manage");
  if (
    authorized.accountState !== "active" ||
    authorized.role !== "admin" ||
    authorized.authenticationMethod.kind === "recovery"
  ) {
    throw new SafeHttpError({
      code: "permission_denied",
      message: "An active administrator session is required.",
      statusCode: 403,
    });
  }
  return authorized;
}

function context(
  request: FastifyRequest,
  principal: InvitationAdminContext["principal"],
): InvitationAdminContext {
  return {
    ipAddress: request.ip,
    principal,
    requestId: request.id,
  };
}

export interface InvitationAdminRoutesOptions {
  dependencies?: InvitationServiceDependencies;
}

export const invitationAdminRoutes: FastifyPluginAsync<InvitationAdminRoutesOptions> = async (
  app,
  options,
) => {
  const invitations = new InvitationService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/admin/invites",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor: identifierJsonSchema },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["invitations", "nextCursor"],
            properties: {
              invitations: {
                type: "array",
                maxItems: INVITATIONS_PAGE_MAX_COUNT,
                items: invitationSummaryJsonSchema,
              },
              nextCursor: { anyOf: [identifierJsonSchema, { type: "null" }] },
            },
          },
        },
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
      const principal = requireInvitationAdministrator(session?.principal);
      try {
        return invitationListResponseSchema.parse(
          invitations.list(
            invitationListQuerySchema.parse(request.query),
            context(request, principal),
          ),
        );
      } catch (error) {
        if (error instanceof InvitationServiceError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/invites",
    {
      bodyLimit: 4 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            expiresInSeconds: {
              type: "integer",
              minimum: INVITATION_MIN_TTL_SECONDS,
              maximum: INVITATION_MAX_TTL_SECONDS,
            },
          },
        },
        response: { 201: createResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requireInvitationAdministrator(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      try {
        const result = invitationCreateResponseSchema.parse(
          invitations.create(
            invitationCreateRequestSchema.parse(request.body),
            context(request, principal),
          ),
        );
        reply.status(201);
        return result;
      } catch (error) {
        if (error instanceof InvitationServiceError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/invites/:invitationId/revoke",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["invitationId"],
          properties: { invitationId: identifierJsonSchema },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["invitation"],
            properties: { invitation: invitationSummaryJsonSchema },
          },
        },
      },
    },
    async (request) => {
      const principal = requireInvitationAdministrator(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      try {
        return invitationRevokeResponseSchema.parse(
          invitations.revoke(
            invitationAdminParamsSchema.parse(request.params).invitationId,
            context(request, principal),
          ),
        );
      } catch (error) {
        if (error instanceof InvitationServiceError) throw administrationError(error);
        throw error;
      }
    },
  );
};
