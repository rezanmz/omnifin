import { sessionResponseSchema } from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { SafeHttpError } from "../http-error.js";
import {
  RecoveryAccessService,
  type RecoveryAccessServiceDependencies,
} from "./recovery-access-service.js";
import { sessionCookieName, writeSessionCookie } from "./session-cookie.js";
import { SESSION_ISSUANCE_WINDOW_MS, SessionIssuanceLimitError } from "./session-service.js";

const RECOVERY_REQUEST_BODY_LIMIT_BYTES = 256;
const RECOVERY_SECRET_MIN_DECODED_BYTES = 32;
const RECOVERY_SECRET_MAX_DECODED_BYTES = 128;
const RECOVERY_SECRET_MAX_ENCODED_CHARACTERS = 172;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isCanonicalRecoverySecretCandidate(value: string) {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  try {
    return (
      decoded.length >= RECOVERY_SECRET_MIN_DECODED_BYTES &&
      decoded.length <= RECOVERY_SECRET_MAX_DECODED_BYTES &&
      decoded.toString("base64") === value
    );
  } finally {
    decoded.fill(0);
  }
}

const recoveryAccessRequestSchema = z
  .object({
    secret: z
      .string()
      .min(1)
      .max(RECOVERY_SECRET_MAX_ENCODED_CHARACTERS)
      .refine(isCanonicalRecoverySecretCandidate),
  })
  .strict();

const recoveryAccessDenied = () =>
  new SafeHttpError({
    code: "recovery_access_denied",
    message: "Recovery access was denied.",
    statusCode: 401,
  });

function requestContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    requestId: request.id,
    userAgent: request.headers["user-agent"],
  };
}

function errorAttribution(error: unknown) {
  if (typeof error !== "object" || error === null) return { kind: "internal_failure" } as const;
  try {
    if ("statusCode" in error && error.statusCode === 429) {
      return { kind: "rate_limited" } as const;
    }
    if ("code" in error && error.code === "origin_denied") {
      return { kind: "origin_denied" } as const;
    }
    if (
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return { kind: "invalid_request" } as const;
    }
  } catch {
    return { kind: "internal_failure" } as const;
  }
  return { kind: "internal_failure" } as const;
}

export interface RecoveryRoutesOptions {
  dependencies?: RecoveryAccessServiceDependencies;
}

export const recoveryRoutes: FastifyPluginAsync<RecoveryRoutesOptions> = async (app, options) => {
  const recoveryAccess = new RecoveryAccessService(
    app.database,
    app.sessionService,
    app.appConfig,
    options.dependencies,
  );
  const recordedRequests = new WeakSet<FastifyRequest>();

  app.post(
    "/v1/auth/recovery/session",
    {
      bodyLimit: RECOVERY_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
      onError: async (request, _reply, error) => {
        if (recordedRequests.has(request)) return;
        recordedRequests.add(request);
        try {
          const attribution = errorAttribution(error);
          switch (attribution.kind) {
            case "rate_limited":
              recoveryAccess.recordRateLimitDeniedAttempt(requestContext(request));
              break;
            case "internal_failure":
              recoveryAccess.recordInternalFailure(requestContext(request));
              break;
            default:
              recoveryAccess.recordDeniedAttempt(requestContext(request), attribution.kind);
          }
        } catch (auditError) {
          request.log.error(
            { err: auditError, operation: "http.request", requestId: request.id },
            "Request failed",
          );
        }
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      const parsedBody = recoveryAccessRequestSchema.safeParse(request.body);
      let session;
      try {
        session = recoveryAccess.authenticate({
          ...requestContext(request),
          currentSessionToken: request.cookies[sessionCookieName(app.appConfig)],
          denialReason: parsedBody.success ? "credential_mismatch" : "invalid_request",
          secret: parsedBody.success ? parsedBody.data.secret : undefined,
        });
      } catch (error) {
        if (!(error instanceof SessionIssuanceLimitError)) throw error;
        reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Recovery access is temporarily rate limited.",
          statusCode: 429,
        });
      }
      recordedRequests.add(request);
      if (!session) throw recoveryAccessDenied();

      const response = sessionResponseSchema.parse({
        csrfToken: session.csrfToken,
        principal: session.principal,
      });
      writeSessionCookie(reply, app.appConfig, session.sessionToken, session.absoluteExpiresAt);
      return response;
    },
  );
};
