import {
  authenticatedSessionResponseSchema,
  jellyfinPasswordAuthenticationRequestSchema,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { SafeHttpError } from "../../http-error.js";
import { clientNetworkGroup } from "../../security/client-network.js";
import { privacyHash } from "../../security/crypto.js";
import { sessionCookieName, writeSessionCookie } from "../session-cookie.js";
import { SESSION_ISSUANCE_WINDOW_MS, SessionIssuanceLimitError } from "../session-service.js";
import {
  JellyfinSignInService,
  JellyfinSignInServiceError,
  type JellyfinSignInServiceDependencies,
} from "./sign-in-service.js";

const PASSWORD_REQUEST_BODY_LIMIT_BYTES = 2_048;

export interface JellyfinRoutesOptions {
  dependencies?: JellyfinSignInServiceDependencies;
}

function requestContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    requestId: request.id,
    ...(request.headers["user-agent"] === undefined
      ? {}
      : { userAgent: request.headers["user-agent"] }),
  };
}

function setRateLimitHeaders(reply: FastifyReply, result: { max: number; ttlInSeconds: number }) {
  reply.header("x-ratelimit-limit", result.max);
  reply.header("x-ratelimit-remaining", 0);
  reply.header("x-ratelimit-reset", result.ttlInSeconds);
  reply.header("retry-after", Math.max(result.ttlInSeconds, 1));
}

export const jellyfinRoutes: FastifyPluginAsync<JellyfinRoutesOptions> = async (app, options) => {
  const signIn = new JellyfinSignInService(
    app.database,
    app.appConfig,
    app.sessionService,
    options.dependencies,
  );
  const globalCredentialRateLimit = app.createRateLimit({
    keyGenerator: () => "jellyfin-password-global:v1",
    max: 512,
    timeWindow: "10 minutes",
  });
  const clientCredentialRateLimit = app.createRateLimit({
    keyGenerator: (request) => clientNetworkGroup(request.ip),
    max: 10,
    timeWindow: "1 minute",
  });
  const recordedRequests = new WeakSet<FastifyRequest>();

  const recordFailure = (
    request: FastifyRequest,
    reason:
      | "authentication_denied"
      | "configuration_invalid"
      | "invalid_request"
      | "rate_limited"
      | "upstream_unavailable",
  ) => {
    if (recordedRequests.has(request)) return;
    recordedRequests.add(request);
    try {
      app.database.sqlite
        .prepare(
          `insert into audit_events (
            id,
            event_type,
            outcome,
            target_type,
            target_id,
            request_id,
            metadata_json,
            ip_hash,
            created_at
          ) values (?, 'auth.jellyfin.sign_in', 'denied', 'connector', 'jellyfin', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          request.id,
          JSON.stringify({ reason }),
          privacyHash("ip_address", request.ip, app.appConfig.encryptionKey),
          Date.now(),
        );
    } catch (error) {
      request.log.error(
        { err: error, operation: "http.request", requestId: request.id },
        "Request failed",
      );
    }
  };

  app.post(
    "/v1/auth/jellyfin/password",
    {
      bodyLimit: PASSWORD_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? error.statusCode
            : undefined;
        recordFailure(request, statusCode === 429 ? "rate_limited" : "invalid_request");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      const clientLimit = await clientCredentialRateLimit(request);
      if (!clientLimit.isAllowed && clientLimit.isExceeded) {
        setRateLimitHeaders(reply, clientLimit);
        recordFailure(request, "rate_limited");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Too many Jellyfin sign-in attempts were received.",
          statusCode: 429,
        });
      }
      const globalLimit = await globalCredentialRateLimit(request);
      if (!globalLimit.isAllowed && globalLimit.isExceeded) {
        setRateLimitHeaders(reply, globalLimit);
        recordFailure(request, "rate_limited");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Jellyfin sign-in is temporarily rate limited.",
          statusCode: 429,
        });
      }

      const parsed = jellyfinPasswordAuthenticationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        recordFailure(request, "invalid_request");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin sign-in request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await signIn.signInWithPassword({
          ...parsed.data,
          ...requestContext(request),
          currentSessionToken: request.cookies[sessionCookieName(app.appConfig)],
        });
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          recordFailure(request, "rate_limited");
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Jellyfin sign-in is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinSignInServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin authentication is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
      if (result.status === "denied") {
        recordFailure(request, "authentication_denied");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin username or password was not accepted.",
          statusCode: 401,
        });
      }

      recordedRequests.add(request);
      const response = authenticatedSessionResponseSchema.parse({
        csrfToken: result.session.csrfToken,
        principal: result.session.principal,
      });
      writeSessionCookie(
        reply,
        app.appConfig,
        result.session.sessionToken,
        result.session.absoluteExpiresAt,
      );
      return response;
    },
  );
};
