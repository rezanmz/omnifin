import {
  administratorRecoveryConfirmationRequestSchema,
  administratorRecoveryJellyfinPasswordRequestSchema,
  administratorRecoveryQuickConnectPollResponseSchema,
  administratorRecoveryReplacementResponseSchema,
  authenticatedSessionResponseSchema,
  jellyfinIdentityPairingResponseSchema,
  jellyfinPasswordAuthenticationRequestSchema,
  jellyfinPasswordPairingRequestSchema,
  jellyfinQuickConnectBootstrapPollResponseSchema,
  jellyfinQuickConnectInitiationRequestSchema,
  jellyfinQuickConnectInitiationResponseSchema,
  jellyfinQuickConnectPairingPollResponseSchema,
  jellyfinQuickConnectPollResponseSchema,
} from "@omnifin/contracts/auth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { SafeHttpError } from "../../http-error.js";
import type { ConnectorHttpLaneLifecycle } from "../../connectors/http-lane-registry.js";
import { clientNetworkGroup } from "../../security/client-network.js";
import { privacyHash } from "../../security/crypto.js";
import { requirePermission } from "../authorization.js";
import { InvitationService, InvitationServiceError } from "../invitation-service.js";
import {
  AdministratorRecoveryError,
  type AdministratorRecoveryReplacementResult,
} from "../administrator-recovery-service.js";
import {
  registrationHandoffCookieName,
  sessionCookieName,
  writeRegistrationHandoffCookie,
  writeSessionCookie,
} from "../session-cookie.js";
import { SESSION_ISSUANCE_WINDOW_MS, SessionIssuanceLimitError } from "../session-service.js";
import {
  jellyfinQuickConnectBrowserBindingCookieName,
  JellyfinQuickConnectService,
  JellyfinQuickConnectServiceError,
  type JellyfinQuickConnectServiceDependencies,
  writeJellyfinQuickConnectBrowserBindingCookie,
} from "./quick-connect-service.js";
import {
  JellyfinSignInService,
  JellyfinSignInServiceError,
  type JellyfinSignInServiceDependencies,
} from "./sign-in-service.js";

const PASSWORD_REQUEST_BODY_LIMIT_BYTES = 2_048;
const QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES = 16;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JellyfinRoutesOptions {
  dependencies?: JellyfinSignInServiceDependencies;
  laneProvider?: ConnectorHttpLaneLifecycle;
  quickConnectDependencies?: JellyfinQuickConnectServiceDependencies;
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

function auditFailureReason(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "permission_denied") return "permission_denied" as const;
    if ("statusCode" in error && error.statusCode === 429) return "rate_limited" as const;
  }
  return "invalid_request" as const;
}

export const jellyfinRoutes: FastifyPluginAsync<JellyfinRoutesOptions> = async (app, options) => {
  const invitations =
    options.dependencies?.invitationService ?? new InvitationService(app.database, app.appConfig);
  const signIn = new JellyfinSignInService(app.database, app.appConfig, app.sessionService, {
    ...(options.dependencies ?? {}),
    invitationService: invitations,
    laneProvider: options.laneProvider ?? app.connectorHttpLaneRegistry,
  });
  const quickConnect = new JellyfinQuickConnectService(app.database, app.appConfig, signIn, {
    ...(options.quickConnectDependencies ?? {}),
    invitationService: invitations,
    laneProvider: options.laneProvider ?? app.connectorHttpLaneRegistry,
  });
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
  const globalQuickConnectStartRateLimit = app.createRateLimit({
    keyGenerator: () => "jellyfin-quick-connect-start-global:v1",
    max: 256,
    timeWindow: "10 minutes",
  });
  const clientQuickConnectStartRateLimit = app.createRateLimit({
    keyGenerator: (request) => clientNetworkGroup(request.ip),
    max: 6,
    timeWindow: "1 minute",
  });
  const globalQuickConnectPollRateLimit = app.createRateLimit({
    keyGenerator: () => "jellyfin-quick-connect-poll-global:v1",
    max: 8_192,
    timeWindow: "10 minutes",
  });
  const recordedRequests = new WeakSet<FastifyRequest>();

  const invitationHandoff = (request: FastifyRequest, reply: FastifyReply) => {
    if (app.sessionService.resolveAndRefresh(request.cookies[sessionCookieName(app.appConfig)])) {
      throw new SafeHttpError({
        code: "invitation_onboarding_invalid",
        message: "The invitation could not be used for Jellyfin onboarding.",
        statusCode: 400,
      });
    }
    const handoffToken = request.cookies[registrationHandoffCookieName(app.appConfig)];
    if (typeof handoffToken !== "string") throw invitationInvalid();
    try {
      const handoff = invitations.beginRegistrationHandoff(handoffToken);
      writeRegistrationHandoffCookie(reply, app.appConfig, handoffToken, handoff.expiresAt);
      return { handoffToken, invitationId: handoff.invitationId };
    } catch (error) {
      if (error instanceof InvitationServiceError) {
        throw new SafeHttpError({
          cause: error,
          code: "invitation_onboarding_invalid",
          message: "The invitation could not be used for Jellyfin onboarding.",
          statusCode: 400,
        });
      }
      throw error;
    }
  };

  const clearInvitationHandoff = (reply: FastifyReply) => {
    reply.clearCookie(registrationHandoffCookieName(app.appConfig), {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.appConfig.secureCookies,
    });
  };

  const invitationInvalid = (cause?: unknown) =>
    new SafeHttpError({
      ...(cause === undefined ? {} : { cause }),
      code: "invitation_onboarding_invalid",
      message: "The invitation could not be used for Jellyfin onboarding.",
      statusCode: 400,
    });

  const invitationIdentityConflict = () =>
    new SafeHttpError({
      code: "invitation_identity_already_exists",
      message: "This Jellyfin account is already linked to Omnifin and cannot use an invitation.",
      statusCode: 409,
    });

  const recordFailure = (
    request: FastifyRequest,
    reason:
      | "authentication_denied"
      | "configuration_invalid"
      | "invalid_request"
      | "permission_denied"
      | "rate_limited"
      | "upstream_unavailable",
    operation: "administrator_replacement" | "bootstrap" | "pairing" | "sign_in" = "sign_in",
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
          ) values (?, ?, 'denied', 'connector', 'jellyfin', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          operation === "administrator_replacement"
            ? "auth.administrator.replacement_attempt"
            : operation === "pairing"
              ? "auth.jellyfin.identity.pairing_attempt"
              : operation === "bootstrap"
                ? "auth.admin.bootstrap_attempt"
                : "auth.jellyfin.sign_in",
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

  const enforceRateLimit = async (
    limiter: ReturnType<typeof app.createRateLimit>,
    request: FastifyRequest,
    reply: FastifyReply,
    message: string,
    operation: "administrator_replacement" | "bootstrap" | "pairing" | "sign_in" = "sign_in",
  ) => {
    const result = await limiter(request);
    if (result.isAllowed || !result.isExceeded) return;
    setRateLimitHeaders(reply, result);
    recordFailure(request, "rate_limited", operation);
    throw new SafeHttpError({
      code: "rate_limit_exceeded",
      message,
      statusCode: 429,
    });
  };

  const sendAdministratorReplacement = (
    reply: FastifyReply,
    result: AdministratorRecoveryReplacementResult,
  ) => {
    if (result.status === "denied") {
      return reply
        .status(403)
        .send(administratorRecoveryReplacementResponseSchema.parse({ status: "denied" }));
    }
    if (result.status === "unavailable") {
      return reply
        .status(409)
        .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
    }
    const response = administratorRecoveryReplacementResponseSchema.parse({
      csrfToken: result.session.csrfToken,
      revokedSessions: result.revokedSessions,
      status: "replaced",
    });
    writeSessionCookie(
      reply,
      app.appConfig,
      result.session.sessionToken,
      result.session.absoluteExpiresAt,
    );
    return response;
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
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error));
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

  app.post(
    "/v1/auth/bootstrap/jellyfin/password",
    {
      bodyLimit: PASSWORD_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "bootstrap");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.jellyfin.manage",
      );
      const clientLimit = await clientCredentialRateLimit(request);
      if (!clientLimit.isAllowed && clientLimit.isExceeded) {
        setRateLimitHeaders(reply, clientLimit);
        recordFailure(request, "rate_limited", "bootstrap");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Too many administrator bootstrap attempts were received.",
          statusCode: 429,
        });
      }
      const globalLimit = await globalCredentialRateLimit(request);
      if (!globalLimit.isAllowed && globalLimit.isExceeded) {
        setRateLimitHeaders(reply, globalLimit);
        recordFailure(request, "rate_limited", "bootstrap");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Administrator bootstrap is temporarily rate limited.",
          statusCode: 429,
        });
      }
      const parsed = jellyfinPasswordPairingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        recordFailure(request, "invalid_request", "bootstrap");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator bootstrap request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await signIn.bootstrapWithPassword({
          ...parsed.data,
          ...requestContext(request),
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          recordFailure(request, "rate_limited", "bootstrap");
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Administrator bootstrap is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinSignInServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "bootstrap",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin administrator verification is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
      if (result.status === "denied") {
        if (result.reason === "jellyfin_admin_required") {
          recordFailure(request, "permission_denied", "bootstrap");
          throw new SafeHttpError({
            code: "jellyfin_admin_required",
            message: "A Jellyfin administrator account is required.",
            statusCode: 403,
          });
        }
        if (
          result.reason === "administrator_already_exists" ||
          result.reason === "recovery_session_required"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "bootstrap_not_available",
            message: "Administrator bootstrap is not available.",
            statusCode: 409,
          });
        }
        recordFailure(request, "authentication_denied", "bootstrap");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin account was not accepted.",
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

  app.post(
    "/v1/auth/jellyfin/link/password",
    {
      bodyLimit: PASSWORD_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "pairing");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "identities.self.manage",
      );
      const clientLimit = await clientCredentialRateLimit(request);
      if (!clientLimit.isAllowed && clientLimit.isExceeded) {
        setRateLimitHeaders(reply, clientLimit);
        recordFailure(request, "rate_limited", "pairing");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Too many Jellyfin pairing attempts were received.",
          statusCode: 429,
        });
      }
      const globalLimit = await globalCredentialRateLimit(request);
      if (!globalLimit.isAllowed && globalLimit.isExceeded) {
        setRateLimitHeaders(reply, globalLimit);
        recordFailure(request, "rate_limited", "pairing");
        throw new SafeHttpError({
          code: "rate_limit_exceeded",
          message: "Jellyfin pairing is temporarily rate limited.",
          statusCode: 429,
        });
      }
      const parsed = jellyfinPasswordPairingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        recordFailure(request, "invalid_request", "pairing");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin pairing request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await signIn.pairWithPassword({
          ...parsed.data,
          ...requestContext(request),
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          recordFailure(request, "rate_limited", "pairing");
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Jellyfin pairing is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinSignInServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "pairing",
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
        if (
          result.reason === "identity_already_linked" ||
          result.reason === "link_already_exists"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "identity_link_conflict",
            message: "That Jellyfin identity cannot be linked to this account.",
            statusCode: 409,
          });
        }
        if (result.reason === "pairing_session_required") {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "pairing_not_available",
            message: "This session is not eligible for Jellyfin pairing.",
            statusCode: 409,
          });
        }
        recordFailure(request, "authentication_denied", "pairing");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin username or password was not accepted.",
          statusCode: 401,
        });
      }

      recordedRequests.add(request);
      const response = jellyfinIdentityPairingResponseSchema.parse({
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

  app.post(
    "/v1/auth/invitations/jellyfin/password",
    {
      bodyLimit: PASSWORD_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error));
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        reply.header("referrer-policy", "no-referrer");
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
      const handoff = invitationHandoff(request, reply);
      let result;
      try {
        result = await signIn.signInWithInvitationPassword({
          ...parsed.data,
          ...requestContext(request),
          registrationHandoff: handoff,
        });
      } catch (error) {
        if (error instanceof InvitationServiceError) throw invitationInvalid(error);
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
        if (result.reason === "invitation_identity_already_exists") {
          recordedRequests.add(request);
          throw invitationIdentityConflict();
        }
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
      clearInvitationHandoff(reply);
      return response;
    },
  );

  app.post(
    "/v1/auth/jellyfin/quick-connect",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        recordFailure(request, auditFailureReason(error));
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        clientQuickConnectStartRateLimit,
        request,
        reply,
        "Too many Jellyfin Quick Connect attempts were started.",
      );
      await enforceRateLimit(
        globalQuickConnectStartRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect is temporarily rate limited.",
      );
      const parsed = jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        recordFailure(request, "invalid_request");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect request is invalid.",
          statusCode: 400,
        });
      }

      let started;
      try {
        started = await quickConnect.start({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
        });
      } catch (error) {
        if (error instanceof JellyfinQuickConnectServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
      recordedRequests.add(request);
      writeJellyfinQuickConnectBrowserBindingCookie(
        reply,
        app.appConfig,
        started.browserBindingToken,
        started.expiresAt,
      );
      return jellyfinQuickConnectInitiationResponseSchema.parse({
        code: started.code,
        expiresAt: started.expiresAt.toISOString(),
        pollAfterMs: started.pollAfterMs,
        transactionId: started.transactionId,
      });
    },
  );

  app.post(
    "/v1/auth/invitations/jellyfin/quick-connect",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        recordFailure(request, auditFailureReason(error));
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        reply.header("referrer-policy", "no-referrer");
        return payload;
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        clientQuickConnectStartRateLimit,
        request,
        reply,
        "Too many Jellyfin Quick Connect attempts were started.",
      );
      await enforceRateLimit(
        globalQuickConnectStartRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect is temporarily rate limited.",
      );
      if (!jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success) {
        recordFailure(request, "invalid_request");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect request is invalid.",
          statusCode: 400,
        });
      }
      const handoff = invitationHandoff(request, reply);
      let started;
      try {
        started = await quickConnect.startInvitation({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          registrationHandoff: handoff,
        });
      } catch (error) {
        if (error instanceof InvitationServiceError) throw invitationInvalid(error);
        if (error instanceof JellyfinQuickConnectServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
      recordedRequests.add(request);
      writeJellyfinQuickConnectBrowserBindingCookie(
        reply,
        app.appConfig,
        started.browserBindingToken,
        started.expiresAt,
      );
      return jellyfinQuickConnectInitiationResponseSchema.parse({
        code: started.code,
        expiresAt: started.expiresAt.toISOString(),
        pollAfterMs: started.pollAfterMs,
        transactionId: started.transactionId,
      });
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/auth/invitations/jellyfin/quick-connect/:transactionId/poll",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 90, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        recordFailure(request, auditFailureReason(error));
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        reply.header("referrer-policy", "no-referrer");
        return payload;
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        globalQuickConnectPollRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect polling is temporarily rate limited.",
      );
      if (
        !TRANSACTION_ID_PATTERN.test(request.params.transactionId) ||
        !jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success
      ) {
        recordFailure(request, "invalid_request");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect poll request is invalid.",
          statusCode: 400,
        });
      }
      if (app.sessionService.resolveAndRefresh(request.cookies[sessionCookieName(app.appConfig)])) {
        throw invitationInvalid();
      }
      const handoffToken = request.cookies[registrationHandoffCookieName(app.appConfig)];
      let result;
      try {
        result = await quickConnect.pollInvitation({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          ...requestContext(request),
          registrationHandoffToken: handoffToken,
          transactionId: request.params.transactionId,
        });
      } catch (error) {
        if (error instanceof InvitationServiceError) throw invitationInvalid(error);
        if (error instanceof JellyfinQuickConnectServiceError) {
          if (error.reason === "invalid_transaction") throw invitationInvalid(error);
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }
      if (result.status === "expired") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPollResponseSchema.parse({ status: "expired" });
      }
      if (result.status === "pending") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPollResponseSchema.parse({
          expiresAt: result.expiresAt.toISOString(),
          pollAfterMs: result.pollAfterMs,
          status: "pending",
        });
      }
      if (result.status === "denied") {
        if (result.reason === "invitation_identity_already_exists") {
          recordedRequests.add(request);
          throw invitationIdentityConflict();
        }
        recordFailure(request, "authentication_denied");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin account is not permitted to sign in.",
          statusCode: 401,
        });
      }
      recordedRequests.add(request);
      const response = jellyfinQuickConnectPollResponseSchema.parse({
        csrfToken: result.session.csrfToken,
        principal: result.session.principal,
        status: "signed_in",
      });
      writeSessionCookie(
        reply,
        app.appConfig,
        result.session.sessionToken,
        result.session.absoluteExpiresAt,
      );
      clearInvitationHandoff(reply);
      return response;
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/auth/jellyfin/quick-connect/:transactionId/poll",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "public-browser" },
        rateLimit: { max: 90, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        recordFailure(request, auditFailureReason(error));
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        globalQuickConnectPollRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect polling is temporarily rate limited.",
      );
      if (
        !TRANSACTION_ID_PATTERN.test(request.params.transactionId) ||
        !jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success
      ) {
        recordFailure(request, "invalid_request");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect poll request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await quickConnect.poll({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          currentSessionToken: request.cookies[sessionCookieName(app.appConfig)],
          ...requestContext(request),
          transactionId: request.params.transactionId,
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
        if (error instanceof JellyfinQuickConnectServiceError) {
          if (error.reason === "invalid_transaction") {
            recordFailure(request, "invalid_request");
            throw new SafeHttpError({
              cause: error,
              code: "authentication_attempt_invalid",
              message: "The Jellyfin Quick Connect attempt is invalid or has expired.",
              statusCode: 400,
            });
          }
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }

      if (result.status === "expired") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPollResponseSchema.parse({ status: "expired" });
      }
      if (result.status === "pending") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPollResponseSchema.parse({
          expiresAt: result.expiresAt.toISOString(),
          pollAfterMs: result.pollAfterMs,
          status: "pending",
        });
      }
      if (result.status === "denied") {
        recordFailure(request, "authentication_denied");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin account is not permitted to sign in.",
          statusCode: 401,
        });
      }

      recordedRequests.add(request);
      const response = jellyfinQuickConnectPollResponseSchema.parse({
        csrfToken: result.session.csrfToken,
        principal: result.session.principal,
        status: "signed_in",
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

  app.post(
    "/v1/auth/bootstrap/jellyfin/quick-connect",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "bootstrap");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.jellyfin.manage",
      );
      await enforceRateLimit(
        clientQuickConnectStartRateLimit,
        request,
        reply,
        "Too many administrator Quick Connect attempts were started.",
        "bootstrap",
      );
      await enforceRateLimit(
        globalQuickConnectStartRateLimit,
        request,
        reply,
        "Administrator Quick Connect is temporarily rate limited.",
        "bootstrap",
      );
      if (!jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success) {
        recordFailure(request, "invalid_request", "bootstrap");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator Quick Connect request is invalid.",
          statusCode: 400,
        });
      }

      let started;
      try {
        started = await quickConnect.startBootstrap({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (
          error instanceof JellyfinQuickConnectServiceError &&
          error.reason === "recovery_session_required"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "bootstrap_not_available",
            message: "Administrator bootstrap is not available.",
            statusCode: 409,
          });
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "bootstrap",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin administrator verification is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }

      recordedRequests.add(request);
      writeJellyfinQuickConnectBrowserBindingCookie(
        reply,
        app.appConfig,
        started.browserBindingToken,
        started.expiresAt,
      );
      return jellyfinQuickConnectInitiationResponseSchema.parse({
        code: started.code,
        expiresAt: started.expiresAt.toISOString(),
        pollAfterMs: started.pollAfterMs,
        transactionId: started.transactionId,
      });
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/auth/bootstrap/jellyfin/quick-connect/:transactionId/poll",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 90, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "bootstrap");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.jellyfin.manage",
      );
      await enforceRateLimit(
        globalQuickConnectPollRateLimit,
        request,
        reply,
        "Administrator Quick Connect polling is temporarily rate limited.",
        "bootstrap",
      );
      if (
        !TRANSACTION_ID_PATTERN.test(request.params.transactionId) ||
        !jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success
      ) {
        recordFailure(request, "invalid_request", "bootstrap");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator Quick Connect poll request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await quickConnect.pollBootstrap({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          ...requestContext(request),
          transactionId: request.params.transactionId,
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          recordFailure(request, "rate_limited", "bootstrap");
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Administrator bootstrap is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          if (error.reason === "recovery_session_required") {
            recordedRequests.add(request);
            throw new SafeHttpError({
              code: "bootstrap_not_available",
              message: "Administrator bootstrap is not available.",
              statusCode: 409,
            });
          }
          if (error.reason === "invalid_transaction") {
            recordFailure(request, "invalid_request", "bootstrap");
            throw new SafeHttpError({
              cause: error,
              code: "authentication_attempt_invalid",
              message: "The administrator Quick Connect attempt is invalid or has expired.",
              statusCode: 400,
            });
          }
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "bootstrap",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin administrator verification is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }

      if (result.status === "expired") {
        recordedRequests.add(request);
        return jellyfinQuickConnectBootstrapPollResponseSchema.parse({ status: "expired" });
      }
      if (result.status === "pending") {
        recordedRequests.add(request);
        return jellyfinQuickConnectBootstrapPollResponseSchema.parse({
          expiresAt: result.expiresAt.toISOString(),
          pollAfterMs: result.pollAfterMs,
          status: "pending",
        });
      }
      if (result.status === "denied") {
        if (result.reason === "jellyfin_admin_required") {
          recordFailure(request, "permission_denied", "bootstrap");
          throw new SafeHttpError({
            code: "jellyfin_admin_required",
            message: "A Jellyfin administrator account is required.",
            statusCode: 403,
          });
        }
        if (
          result.reason === "administrator_already_exists" ||
          result.reason === "recovery_session_required"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "bootstrap_not_available",
            message: "Administrator bootstrap is not available.",
            statusCode: 409,
          });
        }
        recordFailure(request, "authentication_denied", "bootstrap");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin account was not accepted.",
          statusCode: 401,
        });
      }

      recordedRequests.add(request);
      const response = jellyfinQuickConnectBootstrapPollResponseSchema.parse({
        csrfToken: result.session.csrfToken,
        principal: result.session.principal,
        status: "bootstrapped",
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

  app.post(
    "/v1/auth/jellyfin/link/quick-connect",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "pairing");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "identities.self.manage",
      );
      await enforceRateLimit(
        clientQuickConnectStartRateLimit,
        request,
        reply,
        "Too many Jellyfin Quick Connect pairing attempts were started.",
        "pairing",
      );
      await enforceRateLimit(
        globalQuickConnectStartRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect pairing is temporarily rate limited.",
        "pairing",
      );
      if (!jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success) {
        recordFailure(request, "invalid_request", "pairing");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect pairing request is invalid.",
          statusCode: 400,
        });
      }

      let started;
      try {
        started = await quickConnect.startPairing({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (
          error instanceof JellyfinQuickConnectServiceError &&
          error.reason === "pairing_session_required"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "pairing_not_available",
            message: "This session is not eligible for Jellyfin pairing.",
            statusCode: 409,
          });
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "pairing",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }

      recordedRequests.add(request);
      writeJellyfinQuickConnectBrowserBindingCookie(
        reply,
        app.appConfig,
        started.browserBindingToken,
        started.expiresAt,
      );
      return jellyfinQuickConnectInitiationResponseSchema.parse({
        code: started.code,
        expiresAt: started.expiresAt.toISOString(),
        pollAfterMs: started.pollAfterMs,
        transactionId: started.transactionId,
      });
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/auth/jellyfin/link/quick-connect/:transactionId/poll",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 90, timeWindow: "1 minute" },
      },
      onError: async (request, _reply, error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "csrf_denied" || error.code === "origin_denied")
        ) {
          return;
        }
        recordFailure(request, auditFailureReason(error), "pairing");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "identities.self.manage",
      );
      await enforceRateLimit(
        globalQuickConnectPollRateLimit,
        request,
        reply,
        "Jellyfin Quick Connect pairing polling is temporarily rate limited.",
        "pairing",
      );
      if (
        !TRANSACTION_ID_PATTERN.test(request.params.transactionId) ||
        !jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success
      ) {
        recordFailure(request, "invalid_request", "pairing");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The Jellyfin Quick Connect pairing poll request is invalid.",
          statusCode: 400,
        });
      }

      let result;
      try {
        result = await quickConnect.pollPairing({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          ...requestContext(request),
          transactionId: request.params.transactionId,
          validatedSession: request.validatedSession,
        });
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          recordFailure(request, "rate_limited", "pairing");
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Jellyfin pairing is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          if (error.reason === "pairing_session_required") {
            recordedRequests.add(request);
            throw new SafeHttpError({
              code: "pairing_not_available",
              message: "This session is not eligible for Jellyfin pairing.",
              statusCode: 409,
            });
          }
          if (error.reason === "invalid_transaction") {
            recordFailure(request, "invalid_request", "pairing");
            throw new SafeHttpError({
              cause: error,
              code: "authentication_attempt_invalid",
              message: "The Jellyfin Quick Connect pairing attempt is invalid or has expired.",
              statusCode: 400,
            });
          }
          recordFailure(
            request,
            error.reason === "configuration_invalid"
              ? "configuration_invalid"
              : "upstream_unavailable",
            "pairing",
          );
          throw new SafeHttpError({
            cause: error,
            code: "authentication_unavailable",
            message: "Jellyfin Quick Connect is currently unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      }

      if (result.status === "expired") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPairingPollResponseSchema.parse({ status: "expired" });
      }
      if (result.status === "pending") {
        recordedRequests.add(request);
        return jellyfinQuickConnectPairingPollResponseSchema.parse({
          expiresAt: result.expiresAt.toISOString(),
          pollAfterMs: result.pollAfterMs,
          status: "pending",
        });
      }
      if (result.status === "denied") {
        if (
          result.reason === "identity_already_linked" ||
          result.reason === "link_already_exists"
        ) {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "identity_link_conflict",
            message: "That Jellyfin identity cannot be linked to this account.",
            statusCode: 409,
          });
        }
        if (result.reason === "pairing_session_required") {
          recordedRequests.add(request);
          throw new SafeHttpError({
            code: "pairing_not_available",
            message: "This session is not eligible for Jellyfin pairing.",
            statusCode: 409,
          });
        }
        recordFailure(request, "authentication_denied", "pairing");
        throw new SafeHttpError({
          code: "authentication_denied",
          message: "The Jellyfin account is not permitted to pair.",
          statusCode: 401,
        });
      }

      recordedRequests.add(request);
      const response = jellyfinQuickConnectPairingPollResponseSchema.parse({
        csrfToken: result.session.csrfToken,
        principal: result.session.principal,
        status: "paired",
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

  app.post(
    "/v1/auth/recovery/administrator-replacement/jellyfin/password",
    {
      bodyLimit: 4_096,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.administrator.replace",
      );
      await enforceRateLimit(
        clientCredentialRateLimit,
        request,
        reply,
        "Too many administrator recovery attempts were received.",
        "administrator_replacement",
      );
      await enforceRateLimit(
        globalCredentialRateLimit,
        request,
        reply,
        "Administrator recovery is temporarily rate limited.",
        "administrator_replacement",
      );
      const parsed = administratorRecoveryJellyfinPasswordRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        recordFailure(request, "invalid_request", "administrator_replacement");
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator recovery request is invalid.",
          statusCode: 400,
        });
      }
      try {
        const result = await signIn.replaceAdministratorWithPassword({
          ...parsed.data,
          ...requestContext(request),
          validatedSession: request.validatedSession,
        });
        recordedRequests.add(request);
        return sendAdministratorReplacement(reply, result);
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Administrator recovery is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (
          error instanceof JellyfinSignInServiceError ||
          error instanceof AdministratorRecoveryError
        ) {
          recordFailure(request, "upstream_unavailable", "administrator_replacement");
          return reply
            .status(503)
            .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect",
    {
      bodyLimit: 512,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.administrator.replace",
      );
      await enforceRateLimit(
        clientQuickConnectStartRateLimit,
        request,
        reply,
        "Too many administrator recovery attempts were started.",
        "administrator_replacement",
      );
      await enforceRateLimit(
        globalQuickConnectStartRateLimit,
        request,
        reply,
        "Administrator recovery is temporarily rate limited.",
        "administrator_replacement",
      );
      const parsed = administratorRecoveryConfirmationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator recovery request is invalid.",
          statusCode: 400,
        });
      }
      try {
        const started = await quickConnect.startAdministratorReplacement({
          ...parsed.data,
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          validatedSession: request.validatedSession,
        });
        recordedRequests.add(request);
        writeJellyfinQuickConnectBrowserBindingCookie(
          reply,
          app.appConfig,
          started.browserBindingToken,
          started.expiresAt,
        );
        return jellyfinQuickConnectInitiationResponseSchema.parse({
          code: started.code,
          expiresAt: started.expiresAt.toISOString(),
          pollAfterMs: started.pollAfterMs,
          transactionId: started.transactionId,
        });
      } catch (error) {
        if (
          error instanceof JellyfinQuickConnectServiceError &&
          error.reason === "recovery_session_required"
        ) {
          recordedRequests.add(request);
          return reply
            .status(409)
            .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          recordFailure(request, "upstream_unavailable", "administrator_replacement");
          return reply
            .status(503)
            .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { transactionId: string } }>(
    "/v1/auth/recovery/administrator-replacement/jellyfin/quick-connect/:transactionId/poll",
    {
      bodyLimit: QUICK_CONNECT_REQUEST_BODY_LIMIT_BYTES,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 90, timeWindow: "1 minute" },
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "recovery.administrator.replace",
      );
      await enforceRateLimit(
        globalQuickConnectPollRateLimit,
        request,
        reply,
        "Administrator recovery polling is temporarily rate limited.",
        "administrator_replacement",
      );
      if (
        !TRANSACTION_ID_PATTERN.test(request.params.transactionId) ||
        !jellyfinQuickConnectInitiationRequestSchema.safeParse(request.body).success
      ) {
        throw new SafeHttpError({
          code: "invalid_request",
          message: "The administrator recovery poll request is invalid.",
          statusCode: 400,
        });
      }
      try {
        const result = await quickConnect.pollAdministratorReplacement({
          browserBindingToken:
            request.cookies[jellyfinQuickConnectBrowserBindingCookieName(app.appConfig)],
          ...requestContext(request),
          transactionId: request.params.transactionId,
          validatedSession: request.validatedSession,
        });
        recordedRequests.add(request);
        if (result.status === "expired") {
          return administratorRecoveryQuickConnectPollResponseSchema.parse({ status: "expired" });
        }
        if (result.status === "pending") {
          return administratorRecoveryQuickConnectPollResponseSchema.parse({
            expiresAt: result.expiresAt.toISOString(),
            pollAfterMs: result.pollAfterMs,
            status: "pending",
          });
        }
        return sendAdministratorReplacement(reply, result);
      } catch (error) {
        if (error instanceof SessionIssuanceLimitError) {
          reply.header("retry-after", Math.ceil(SESSION_ISSUANCE_WINDOW_MS / 1_000));
          throw new SafeHttpError({
            code: "rate_limit_exceeded",
            message: "Administrator recovery is temporarily rate limited.",
            statusCode: 429,
          });
        }
        if (error instanceof JellyfinQuickConnectServiceError) {
          if (error.reason === "invalid_transaction") {
            throw new SafeHttpError({
              code: "authentication_attempt_invalid",
              message: "The administrator recovery attempt is invalid or has expired.",
              statusCode: 400,
            });
          }
          if (error.reason === "recovery_session_required") {
            return reply
              .status(409)
              .send(
                administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }),
              );
          }
          return reply
            .status(503)
            .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
        }
        if (error instanceof AdministratorRecoveryError) {
          return reply
            .status(503)
            .send(administratorRecoveryReplacementResponseSchema.parse({ status: "unavailable" }));
        }
        throw error;
      }
    },
  );
};
