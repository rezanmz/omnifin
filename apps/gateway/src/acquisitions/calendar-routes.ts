import {
  acquisitionCalendarQuerySchema,
  acquisitionCalendarResponseJsonSchema,
  acquisitionCalendarResponseSchema,
} from "@omnifin/contracts/calendar";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  AcquisitionCalendarError,
  AcquisitionCalendarService,
  type AcquisitionCalendarDependencies,
} from "./calendar-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function serviceError(error: AcquisitionCalendarError) {
  if (error.reason === "cursor_invalid") {
    return new SafeHttpError({
      cause: error,
      code: "acquisition_calendar_cursor_invalid",
      message: "The acquisition calendar cursor is invalid or no longer applies.",
      statusCode: 400,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "acquisition_calendar_configuration_unavailable",
    message: "The acquisition calendar configuration is temporarily unavailable.",
    statusCode: 503,
  });
}

export interface AcquisitionCalendarRoutesOptions {
  dependencies?: AcquisitionCalendarDependencies;
}

export const acquisitionCalendarRoutes: FastifyPluginAsync<
  AcquisitionCalendarRoutesOptions
> = async (app, options) => {
  const calendar = new AcquisitionCalendarService(
    app.database,
    app.appConfig,
    options.dependencies,
  );

  app.get(
    "/v1/acquisitions/calendar",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: { response: { 200: acquisitionCalendarResponseJsonSchema } },
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
      const principal = requirePermission(session?.principal, "media.view");
      const query = acquisitionCalendarQuerySchema.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      try {
        return acquisitionCalendarResponseSchema.parse(
          await calendar.read(query, { principal }, controller.signal),
        );
      } catch (error) {
        if (error instanceof AcquisitionCalendarError) throw serviceError(error);
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );
};
