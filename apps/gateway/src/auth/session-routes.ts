import { sessionResponseSchema } from "@omnifin/contracts/auth";
import type { FastifyPluginAsync } from "fastify";
import { clearSessionCookie, sessionCookieName, writeSessionCookie } from "./session-cookie.js";

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/auth/session",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      const sessionToken = request.cookies[sessionCookieName(app.appConfig)];
      if (!sessionToken) {
        return sessionResponseSchema.parse({ csrfToken: null, principal: null });
      }

      const session = app.sessionService.resolveAndRefresh(sessionToken);
      if (!session) {
        if (app.sessionService.shouldClearSessionCookie(sessionToken)) {
          clearSessionCookie(reply, app.appConfig);
        }
        return sessionResponseSchema.parse({ csrfToken: null, principal: null });
      }
      if (session.rotatedSessionToken) {
        writeSessionCookie(
          reply,
          app.appConfig,
          session.rotatedSessionToken,
          session.absoluteExpiresAt,
        );
      }

      return sessionResponseSchema.parse({
        csrfToken: session.csrfToken,
        principal: session.principal,
      });
    },
  );

  app.delete(
    "/v1/auth/session",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      app.sessionService.revokeValidatedSession(request.validatedSession!, {
        ipAddress: request.ip,
        requestId: request.id,
      });
      clearSessionCookie(reply, app.appConfig);
      await reply.status(204).send();
    },
  );
};
