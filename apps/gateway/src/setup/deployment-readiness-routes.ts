import {
  deploymentReadinessResponseJsonSchema,
  deploymentReadinessResponseSchema,
} from "@omnifin/contracts/deployment";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  DeploymentReadinessError,
  DeploymentReadinessService,
  type DeploymentReadinessDependencies,
} from "./deployment-readiness-service.js";

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

export interface DeploymentReadinessRoutesOptions {
  dependencies?: DeploymentReadinessDependencies;
}

export const deploymentReadinessRoutes: FastifyPluginAsync<
  DeploymentReadinessRoutesOptions
> = async (app, options) => {
  const readiness = new DeploymentReadinessService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/admin/setup/deployment",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: deploymentReadinessResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return deploymentReadinessResponseSchema.parse(readiness.read({ principal }));
      } catch (error) {
        if (error instanceof DeploymentReadinessError) {
          reply.header("retry-after", "5");
          throw new SafeHttpError({
            cause: error,
            code: "deployment_readiness_unavailable",
            message: "Deployment readiness is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
    },
  );
};
