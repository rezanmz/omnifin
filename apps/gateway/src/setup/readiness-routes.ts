import {
  setupReadinessResponseJsonSchema,
  setupReadinessResponseSchema,
} from "@omnifin/contracts/setup";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  SetupReadinessError,
  SetupReadinessService,
  type SetupReadinessDependencies,
} from "./readiness-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function readPrincipal(request: FastifyRequest, reply: FastifyReply) {
  const session = request.server.sessionService.resolveAndRefresh(
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
  const principal = requirePermission(session?.principal, "connectors.manage");
  return requirePermission(principal, "recovery.oidc.manage");
}

export interface SetupReadinessRoutesOptions {
  dependencies?: SetupReadinessDependencies;
}

export const setupReadinessRoutes: FastifyPluginAsync<SetupReadinessRoutesOptions> = async (
  app,
  options,
) => {
  const readiness = new SetupReadinessService(app.database, options.dependencies);

  app.get(
    "/v1/admin/setup/readiness",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: setupReadinessResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return setupReadinessResponseSchema.parse(readiness.read({ principal }));
      } catch (error) {
        if (error instanceof SetupReadinessError) {
          reply.header("retry-after", "5");
          throw new SafeHttpError({
            cause: error,
            code: "setup_readiness_unavailable",
            message: "Setup readiness is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
    },
  );
};
