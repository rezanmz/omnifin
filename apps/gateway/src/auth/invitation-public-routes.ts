import { invitationExchangeRequestSchema } from "@omnifin/contracts/invitations";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { SafeHttpError } from "../http-error.js";
import {
  InvitationService,
  InvitationServiceError,
  type InvitationServiceDependencies,
} from "./invitation-service.js";
import { sessionCookieName, writeRegistrationHandoffCookie } from "./session-cookie.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("referrer-policy", "no-referrer");
  return payload;
}

function invalidExchange() {
  return new SafeHttpError({
    code: "invitation_exchange_invalid",
    message: "The invitation could not be accepted.",
    statusCode: 400,
  });
}

export interface InvitationPublicRoutesOptions {
  dependencies?: InvitationServiceDependencies;
}

export const invitationPublicRoutes: FastifyPluginAsync<InvitationPublicRoutesOptions> = async (
  app,
  options,
) => {
  const invitations = new InvitationService(app.database, app.appConfig, options.dependencies);

  app.post(
    "/v1/auth/invitations/exchange",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onSend: noStore,
    },
    async (request, reply) => {
      const contentType = request.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
      ) {
        throw invalidExchange();
      }
      const activeSession = app.sessionService.resolveAndRefresh(
        request.cookies[sessionCookieName(app.appConfig)],
      );
      if (activeSession) throw invalidExchange();

      let input: { token: string };
      try {
        input = invitationExchangeRequestSchema.parse(request.body);
      } catch {
        throw invalidExchange();
      }

      try {
        const exchanged = invitations.exchangeForRegistrationHandoff(input.token);
        writeRegistrationHandoffCookie(
          reply,
          app.appConfig,
          exchanged.handoffToken,
          exchanged.expiresAt,
        );
        reply.status(204);
        return;
      } catch (error) {
        if (error instanceof InvitationServiceError) throw invalidExchange();
        throw error;
      }
    },
  );
};
