import { sessionResponseSchema, themePreferenceSchema } from "@omnifin/contracts/auth";
import type { FastifyPluginAsync } from "fastify";
import { requireSelfSessionRevocation } from "./authorization.js";
import { AppearanceService } from "./appearance-service.js";
import { clearSessionCookie, sessionCookieName, writeSessionCookie } from "./session-cookie.js";

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const appearance = new AppearanceService(app.database);

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

      const theme =
        session.principal.userId === null
          ? undefined
          : (() => {
              try {
                return themePreferenceSchema.parse(
                  appearance.read({ principal: session.principal }).theme,
                );
              } catch {
                return undefined;
              }
            })();

      return sessionResponseSchema.parse({
        csrfToken: session.csrfToken,
        principal: session.principal,
        ...(theme === undefined ? {} : { theme }),
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
      requireSelfSessionRevocation(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      app.sessionService.revokeValidatedSession(request.validatedSession!, {
        ipAddress: request.ip,
        requestId: request.id,
      });
      clearSessionCookie(reply, app.appConfig);
      await reply.status(204).send();
    },
  );

  app.delete(
    "/v1/auth/sessions",
    {
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      requireSelfSessionRevocation(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
      );
      app.sessionService.revokeAllValidatedSessions(request.validatedSession!, {
        ipAddress: request.ip,
        requestId: request.id,
      });
      clearSessionCookie(reply, app.appConfig);
      await reply.status(204).send();
    },
  );
};
