import {
  AUTH_USERS_PAGE_MAX_COUNT,
  oidcRoleAssignmentRequestSchema,
  oidcRoleAssignmentResponseSchema,
  userAccessListQuerySchema,
  userAccessListResponseSchema,
  userAccessMutationParamsSchema,
  userAccessMutationRequestSchema,
  userAccessMutationResponseSchema,
  type Permission,
  type SessionPrincipal,
  type UserAccessMutationRequest,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { SafeHttpError } from "../http-error.js";
import { requirePermission } from "./authorization.js";
import { sessionCookieName, writeSessionCookie } from "./session-cookie.js";
import {
  UserAccessAdminError,
  UserAccessAdminService,
  type UserAccessAdminDependencies,
} from "./user-access-admin-service.js";

const identifierJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
} as const;

const dateTimeJsonSchema = {
  type: "string",
  format: "date-time",
  maxLength: 64,
} as const;

const userSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "activeSessions",
    "authenticationMethods",
    "createdAt",
    "displayName",
    "id",
    "jellyfinLinkHealth",
    "lastActiveAt",
    "role",
    "roleSource",
    "status",
    "updatedAt",
  ],
  properties: {
    activeSessions: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    authenticationMethods: {
      type: "array",
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ["jellyfin", "oidc"] },
    },
    createdAt: dateTimeJsonSchema,
    displayName: { type: "string", minLength: 1, maxLength: 160 },
    id: identifierJsonSchema,
    jellyfinLinkHealth: {
      anyOf: [{ enum: ["linked", "unavailable", "relink_required", "revoked"] }, { type: "null" }],
    },
    lastActiveAt: { anyOf: [dateTimeJsonSchema, { type: "null" }] },
    role: { enum: ["viewer", "requester", "operator", "admin"] },
    roleSource: { enum: ["default", "oidc_mapping", "manual", "recovery_bootstrap"] },
    status: { enum: ["active", "pending_link", "disabled"] },
    updatedAt: dateTimeJsonSchema,
  },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  return payload;
}

function administrationError(error: UserAccessAdminError): SafeHttpError {
  switch (error.reason) {
    case "cursor_invalid":
      return new SafeHttpError({
        cause: error,
        code: "user_access_cursor_invalid",
        message: "The user access cursor is not valid.",
        statusCode: 400,
      });
    case "user_not_found":
      return new SafeHttpError({
        cause: error,
        code: "user_not_found",
        message: "The user account does not exist.",
        statusCode: 404,
      });
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "permission_denied",
        message: "This session cannot administer that account change.",
        statusCode: 403,
      });
    case "stale_revision":
      return new SafeHttpError({
        cause: error,
        code: "user_access_revision_conflict",
        message: "The account changed since it was loaded.",
        statusCode: 409,
      });
    case "self_mutation":
      return new SafeHttpError({
        cause: error,
        code: "user_access_self_mutation",
        message: "Use your account settings to change your own access.",
        statusCode: 409,
      });
    case "role_managed_by_provider":
      return new SafeHttpError({
        cause: error,
        code: "user_role_managed_by_provider",
        message: "This role is controlled by an OIDC provider mapping.",
        statusCode: 409,
      });
    case "last_active_admin":
      return new SafeHttpError({
        cause: error,
        code: "last_active_admin_required",
        message: "At least one active administrator must remain.",
        statusCode: 409,
      });
    case "mapping_conflict":
      return new SafeHttpError({
        cause: error,
        code: "oidc_role_mapping_conflict",
        message: "An equivalent role mapping already exists.",
        statusCode: 409,
      });
    case "mapping_limit_reached":
      return new SafeHttpError({
        cause: error,
        code: "oidc_role_mapping_limit_reached",
        message: "The identity provider role mapping limit has been reached.",
        statusCode: 409,
      });
    case "oidc_identity_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "oidc_identity_unavailable",
        message: "The account does not have one usable OIDC identity.",
        statusCode: 409,
      });
    case "oidc_role_assignment_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "oidc_role_assignment_unavailable",
        message: "This account cannot receive a provider role assignment.",
        statusCode: 409,
      });
    case "no_effect":
      return new SafeHttpError({
        cause: error,
        code: "user_access_unchanged",
        message: "The requested account access is already in effect.",
        statusCode: 409,
      });
    case "integrity_failure":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "user_access_unavailable",
        message: "User access administration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function requireUserAccessPermission(
  principal: SessionPrincipal | null | undefined,
  permission: Permission,
) {
  if (principal?.authenticationMethod.kind === "recovery") {
    throw new SafeHttpError({
      code: "permission_denied",
      message: "Recovery access cannot administer user accounts.",
      statusCode: 403,
    });
  }
  return requirePermission(principal, permission);
}

function mutationPrincipal(
  request: FastifyRequest,
  input: UserAccessMutationRequest,
): SessionPrincipal {
  const principal = request.server.sessionService.resolveValidatedSessionPrincipal(
    request.validatedSession,
  );
  if (input.role !== undefined) requireUserAccessPermission(principal, "roles.manage");
  if (input.enabled !== undefined) requireUserAccessPermission(principal, "identities.manage");
  return principal!;
}

export interface UserAccessAdminRoutesOptions {
  dependencies?: UserAccessAdminDependencies;
}

export const userAccessAdminRoutes: FastifyPluginAsync<UserAccessAdminRoutesOptions> = async (
  app,
  options,
) => {
  const access = new UserAccessAdminService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/admin/users",
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
            required: ["nextCursor", "users"],
            properties: {
              nextCursor: { anyOf: [identifierJsonSchema, { type: "null" }] },
              users: {
                type: "array",
                maxItems: AUTH_USERS_PAGE_MAX_COUNT,
                items: userSummaryJsonSchema,
              },
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
      requireUserAccessPermission(session?.principal, "roles.manage");
      try {
        return userAccessListResponseSchema.parse(
          access.list(userAccessListQuerySchema.parse(request.query)),
        );
      } catch (error) {
        if (error instanceof UserAccessAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.patch(
    "/v1/admin/users/:userId",
    {
      bodyLimit: 4 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: { userId: identifierJsonSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedUpdatedAt"],
          anyOf: [{ required: ["enabled"] }, { required: ["role"] }],
          properties: {
            enabled: { type: "boolean" },
            expectedUpdatedAt: dateTimeJsonSchema,
            role: { enum: ["viewer", "requester", "operator", "admin"] },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["revokedSessions", "user"],
            properties: {
              revokedSessions: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
              user: userSummaryJsonSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = userAccessMutationParamsSchema.parse(request.params);
      const input = userAccessMutationRequestSchema.parse(request.body);
      const principal = mutationPrincipal(request, input);
      try {
        return userAccessMutationResponseSchema.parse(
          access.update(userId, input, {
            ipAddress: request.ip,
            principal,
            requestId: request.id,
          }),
        );
      } catch (error) {
        if (error instanceof UserAccessAdminError) throw administrationError(error);
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/users/:userId/oidc-role-assignment",
    {
      bodyLimit: 4 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: { userId: identifierJsonSchema },
        },
        body: {
          type: "object",
          additionalProperties: true,
          required: ["expectedUpdatedAt", "role"],
          properties: {
            expectedUpdatedAt: dateTimeJsonSchema,
            role: { enum: ["viewer", "requester", "operator", "admin"] },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: [
              "effectiveAfter",
              "fallbackPrecedence",
              "mappingId",
              "priority",
              "revokedSessions",
              "role",
            ],
            properties: {
              effectiveAfter: { const: "next_oidc_sign_in" },
              fallbackPrecedence: { const: "lowest" },
              mappingId: identifierJsonSchema,
              priority: { const: 0 },
              revokedSessions: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
              role: { enum: ["viewer", "requester", "operator", "admin"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requireUserAccessPermission(
        request.server.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "roles.manage",
      );
      const { userId } = userAccessMutationParamsSchema.parse(request.params);
      const input = oidcRoleAssignmentRequestSchema.parse(request.body);
      try {
        const result = access.assignOidcRole(userId, input, {
          ipAddress: request.ip,
          principal,
          requestId: request.id,
        });
        reply.status(201);
        return oidcRoleAssignmentResponseSchema.parse(result);
      } catch (error) {
        if (error instanceof UserAccessAdminError) throw administrationError(error);
        throw error;
      }
    },
  );
};
