import {
  systemStatusResponseJsonSchema,
  systemStatusResponseSchema,
} from "@omnifin/contracts/system";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  SystemStatusError,
  SystemStatusService,
  type SystemStatusDependencies,
} from "./status-service.js";

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
  return requirePermission(session?.principal, "acquisition.manage");
}

async function withAbort<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

export interface SystemStatusRoutesOptions {
  dependencies?: SystemStatusDependencies;
}

export const systemStatusRoutes: FastifyPluginAsync<SystemStatusRoutesOptions> = async (
  app,
  options,
) => {
  const status = new SystemStatusService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/system/status",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: systemStatusResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = readPrincipal(request, reply);
      try {
        return systemStatusResponseSchema.parse(
          await withAbort(request, (signal) => status.read({ principal }, signal)),
        );
      } catch (error) {
        if (error instanceof SystemStatusError) {
          throw new SafeHttpError({
            cause: error,
            code: "system_status_configuration_unavailable",
            message: "System telemetry configuration is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
    },
  );
};
