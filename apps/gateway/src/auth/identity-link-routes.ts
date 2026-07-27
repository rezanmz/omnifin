import {
  identityLinkRevocationResponseSchema,
  identityLinksResponseSchema,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync } from "fastify";

import { SafeHttpError } from "../http-error.js";
import {
  IdentityLinkService,
  IdentityLinkServiceError,
  type IdentityLinkServiceDependencies,
} from "./identity-link-service.js";
import { clearSessionCookie, sessionCookieName, writeSessionCookie } from "./session-cookie.js";

const LINK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface IdentityLinkRoutesOptions {
  dependencies?: IdentityLinkServiceDependencies;
}

export const identityLinkRoutes: FastifyPluginAsync<IdentityLinkRoutesOptions> = async (
  app,
  options,
) => {
  const links = new IdentityLinkService(
    app.database,
    app.appConfig,
    app.sessionService,
    options.dependencies,
  );

  app.get(
    "/v1/auth/identity-links",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      const sessionToken = request.cookies[sessionCookieName(app.appConfig)];
      const session = app.sessionService.resolveAndRefresh(sessionToken);
      if (!session) {
        throw new SafeHttpError({
          code: "authentication_required",
          message: "Sign in to inspect linked identities.",
          statusCode: 401,
        });
      }
      if (session.rotatedSessionToken) {
        writeSessionCookie(
          reply,
          app.appConfig,
          session.rotatedSessionToken,
          session.absoluteExpiresAt,
        );
      }
      try {
        return identityLinksResponseSchema.parse({
          links: links.listForPrincipal(session.principal),
        });
      } catch (error) {
        if (error instanceof IdentityLinkServiceError) {
          throw new SafeHttpError({
            cause: error,
            code:
              error.reason === "permission_denied" ? "permission_denied" : "identity_unavailable",
            message:
              error.reason === "permission_denied"
                ? "This action is not permitted."
                : "Linked identity status is currently unavailable.",
            statusCode: error.reason === "permission_denied" ? 403 : 503,
          });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { linkId: string } }>(
    "/v1/auth/identity-links/:linkId",
    {
      bodyLimit: 16,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      if (request.body !== undefined || !LINK_ID_PATTERN.test(request.params.linkId)) {
        throw new SafeHttpError({
          code: request.body === undefined ? "identity_link_not_found" : "invalid_request",
          message:
            request.body === undefined
              ? "The linked identity was not found."
              : "The linked identity revocation request is invalid.",
          statusCode: request.body === undefined ? 404 : 400,
        });
      }

      let result;
      try {
        result = links.revoke({
          ipAddress: request.ip,
          linkId: request.params.linkId,
          requestId: request.id,
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (error instanceof IdentityLinkServiceError) {
          if (error.reason === "identity_link_not_found") {
            throw new SafeHttpError({
              cause: error,
              code: "identity_link_not_found",
              message: "The linked identity was not found.",
              statusCode: 404,
            });
          }
          if (error.reason === "permission_denied") {
            throw new SafeHttpError({
              cause: error,
              code: "permission_denied",
              message: "This action is not permitted.",
              statusCode: 403,
            });
          }
          if (error.reason === "invalid_session") {
            throw new SafeHttpError({
              cause: error,
              code: "session_changed",
              message: "The session changed before the linked identity could be revoked.",
              statusCode: 409,
            });
          }
          throw new SafeHttpError({
            cause: error,
            code: "identity_unavailable",
            message: "The linked identity could not be updated.",
            statusCode: 503,
          });
        }
        throw error;
      }

      if (result.principal === null) clearSessionCookie(reply, app.appConfig);
      return identityLinkRevocationResponseSchema.parse({
        link: result.link,
        principal: result.principal,
      });
    },
  );
};
