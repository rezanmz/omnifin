import {
  appearanceUpdateRequestSchema,
  appearanceUpdateResponseJsonSchema,
  appearanceUpdateResponseSchema,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync } from "fastify";

import { SafeHttpError } from "../http-error.js";
import { requirePermission } from "./authorization.js";
import { AppearanceError, AppearanceService } from "./appearance-service.js";
import { sessionCookieName, writeSessionCookie } from "./session-cookie.js";

export interface AppearanceRoutesOptions {
  service?: AppearanceService;
}

const appearanceRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["theme"],
  properties: { theme: { type: "string", enum: ["system", "light", "dark"] } },
} as const;

function appearanceError(error: AppearanceError) {
  if (error.reason === "not_found") {
    return new SafeHttpError({
      cause: error,
      code: "appearance_account_not_found",
      message: "This account is no longer available.",
      statusCode: 404,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "appearance_unavailable",
    message: "The appearance preference is temporarily unavailable.",
    statusCode: 503,
  });
}

export const appearanceRoutes: FastifyPluginAsync<AppearanceRoutesOptions> = async (
  app,
  options,
) => {
  const appearance = options.service ?? new AppearanceService(app.database);

  app.get(
    "/v1/profile/appearance",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      const session = app.sessionService.resolveAndRefresh(
        request.cookies[sessionCookieName(app.appConfig)],
      );
      if (!session) {
        throw new SafeHttpError({
          code: "authentication_required",
          message: "Sign in to inspect your appearance preferences.",
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
        return appearanceUpdateResponseSchema.parse(
          appearance.read({ principal: session.principal }),
        );
      } catch (error) {
        if (error instanceof AppearanceError) throw appearanceError(error);
        throw error;
      }
    },
  );

  app.patch(
    "/v1/profile/appearance",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
      schema: {
        body: appearanceRequestJsonSchema,
        response: { 200: appearanceUpdateResponseJsonSchema },
      },
    },
    async (request) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "identities.self.manage",
      );
      const input = appearanceUpdateRequestSchema.parse(request.body);
      try {
        return appearanceUpdateResponseSchema.parse(appearance.update({ principal }, input));
      } catch (error) {
        if (error instanceof AppearanceError) throw appearanceError(error);
        throw error;
      }
    },
  );
};
