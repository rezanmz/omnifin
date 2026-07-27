import cookie from "@fastify/cookie";
import formBody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { createApiError } from "@omnifin/contracts/errors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { authProviderRoutes } from "./auth/provider-routes.js";
import { identityLinkRoutes, type IdentityLinkRoutesOptions } from "./auth/identity-link-routes.js";
import { bootstrapConfiguredJellyfinConnector } from "./auth/jellyfin/connector-registry.js";
import type { JellyfinQuickConnectServiceDependencies } from "./auth/jellyfin/quick-connect-service.js";
import { jellyfinRoutes, type JellyfinRoutesOptions } from "./auth/jellyfin/routes.js";
import { oidcRoutes, type OidcRoutesDependencies } from "./auth/oidc/routes.js";
import {
  oidcProviderAdminRoutes,
  type OidcProviderAdminRoutesOptions,
} from "./auth/oidc/provider-admin-routes.js";
import {
  oidcRoleMappingAdminRoutes,
  type OidcRoleMappingAdminRoutesOptions,
} from "./auth/oidc/role-mapping-admin-routes.js";
import {
  OidcBackchannelLogoutError,
  OidcBackchannelLogoutService,
} from "./auth/oidc/backchannel-logout.js";
import { recoveryRoutes, type RecoveryRoutesOptions } from "./auth/recovery-routes.js";
import { revokeRecoverySessionsOnStartup } from "./auth/recovery-session.js";
import { SESSION_CSRF_HEADER, sessionCookieName } from "./auth/session-cookie.js";
import { sessionRoutes } from "./auth/session-routes.js";
import {
  SessionService,
  type SessionServiceDependencies,
  type ValidatedSession,
} from "./auth/session-service.js";
import { type AppConfig, loadConfig } from "./config.js";
import { type DatabaseHandle, openDatabase } from "./db/client.js";
import { healthRoutes } from "./health.js";
import { isSafeHttpError, SafeHttpError } from "./http-error.js";
import { createLoggerOptions } from "./logger.js";
import { asStartupError } from "./startup-error.js";
import { clientNetworkGroup } from "./security/client-network.js";
import { installRequestPolicy } from "./security/request-policy.js";

declare module "fastify" {
  interface FastifyInstance {
    appConfig: AppConfig;
    database: DatabaseHandle;
    sessionService: SessionService;
  }

  interface FastifyRequest {
    validatedSession: ValidatedSession | null;
  }
}

export interface CreateAppOptions {
  config?: AppConfig;
  database?: DatabaseHandle;
  migrate?: boolean;
  oidcDependencies?: OidcRoutesDependencies;
  oidcProviderAdminDependencies?: OidcProviderAdminRoutesOptions["dependencies"];
  oidcRoleMappingAdminDependencies?: OidcRoleMappingAdminRoutesOptions["dependencies"];
  jellyfinDependencies?: JellyfinRoutesOptions["dependencies"];
  jellyfinQuickConnectDependencies?: JellyfinQuickConnectServiceDependencies;
  identityLinkDependencies?: IdentityLinkRoutesOptions["dependencies"];
  recoveryAccessDependencies?: RecoveryRoutesOptions["dependencies"];
  sessionDependencies?: SessionServiceDependencies;
}

function requestId(incomingId: string | undefined) {
  if (incomingId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId)) return incomingId;
  return randomUUID();
}

function frameworkErrorStatus(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : 500;
}

function sessionCsrfProof(request: FastifyRequest) {
  if (request.method !== "POST" || request.routeOptions.url !== "/v1/auth/oidc/logout") {
    return request.headers[SESSION_CSRF_HEADER];
  }
  if (request.headers[SESSION_CSRF_HEADER] !== undefined) return undefined;
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
  ) {
    return undefined;
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "csrfToken")) return undefined;
  const csrfToken = Object.getOwnPropertyDescriptor(body, "csrfToken");
  return csrfToken && "value" in csrfToken && typeof csrfToken.value === "string"
    ? csrfToken.value
    : undefined;
}

function oidcBackchannelRequest(request: FastifyRequest) {
  if (
    request.method !== "POST" ||
    request.routeOptions.url !== "/v1/auth/oidc/backchannel/:providerId"
  ) {
    return undefined;
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim()) ||
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body) ||
    !request.params ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  ) {
    return undefined;
  }
  const logoutToken = Object.getOwnPropertyDescriptor(request.body, "logout_token");
  const providerId = Object.getOwnPropertyDescriptor(request.params, "providerId");
  if (
    !logoutToken ||
    !("value" in logoutToken) ||
    typeof logoutToken.value !== "string" ||
    !providerId ||
    !("value" in providerId) ||
    typeof providerId.value !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ logoutToken: logoutToken.value, providerId: providerId.value });
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? openDatabase(config.databaseUrl);
  let databaseClosed = false;
  const closeDatabase = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  };
  let app: FastifyInstance | undefined;

  try {
    if (options.migrate !== false) {
      try {
        database.migrate();
      } catch (error) {
        throw asStartupError(error, "database_migration_failed");
      }
    }
    let sessionsTableExists: boolean;
    try {
      sessionsTableExists = Boolean(
        database.sqlite
          .prepare("select 1 from sqlite_master where type = 'table' and name = 'sessions'")
          .get(),
      );
    } catch (error) {
      throw asStartupError(error, "database_initialization_failed");
    }
    if (options.migrate !== false || sessionsTableExists) {
      try {
        revokeRecoverySessionsOnStartup(database);
      } catch (error) {
        throw asStartupError(error, "database_initialization_failed");
      }
    }
    if (options.migrate !== false) {
      try {
        bootstrapConfiguredJellyfinConnector(database, config);
      } catch (error) {
        throw asStartupError(error, "jellyfin_configuration_invalid");
      }
    }

    app = Fastify({
      bodyLimit: 64 * 1_024,
      genReqId: (request) => requestId(request.headers["x-request-id"] as string | undefined),
      logger: createLoggerOptions(config),
      requestIdHeader: false,
      routerOptions: { maxParamLength: 512 },
      trustProxy: config.trustProxyHops,
    });

    app.decorate("appConfig", config);
    app.decorate("database", database);
    const sessionService = new SessionService(database, config, options.sessionDependencies);
    const backchannelDependencies = options.oidcDependencies?.backchannelLogout;
    const oidcBackchannelLogout = new OidcBackchannelLogoutService(database, config, {
      ...(backchannelDependencies ?? {}),
      ...(options.oidcDependencies?.providerRegistry === undefined
        ? {}
        : { providerRegistry: options.oidcDependencies.providerRegistry }),
    });
    app.decorate("sessionService", sessionService);
    app.decorateRequest("validatedSession", null);

    app.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
      reply.header(
        "permissions-policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      );
    });

    await app.register(cookie, { hook: "onRequest" });
    await app.register(formBody, { bodyLimit: 64 * 1_024 });
    await app.register(sensible);
    await app.register(rateLimit, {
      global: false,
      max: 300,
      timeWindow: "1 minute",
      hook: "onRequest",
      keyGenerator: (request) => clientNetworkGroup(request.ip),
    });
    const globalRateLimit = app.createRateLimit();
    app.addHook("onRequest", async (request, reply) => {
      const result = await globalRateLimit(request);
      if (result.isAllowed || !result.isExceeded) return;
      reply.header("x-ratelimit-limit", result.max);
      reply.header("x-ratelimit-remaining", 0);
      reply.header("x-ratelimit-reset", result.ttlInSeconds);
      reply.header("retry-after", result.ttlInSeconds);
      throw request.server.httpErrors.tooManyRequests("Rate limit exceeded.");
    });
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: "deny" },
      hsts: config.environment === "production" ? { maxAge: 63_072_000, preload: true } : false,
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
      referrerPolicy: { policy: "no-referrer" },
    });

    installRequestPolicy(app, {
      allowedOrigin: config.baseUrl.origin,
      validateOidcBackchannel: async (request) => {
        const input = oidcBackchannelRequest(request);
        if (!input) return false;
        try {
          await oidcBackchannelLogout.process({ ...input, requestId: request.id });
          return true;
        } catch (error) {
          if (
            error instanceof OidcBackchannelLogoutError &&
            error.code === "logout_storage_failed"
          ) {
            throw new SafeHttpError({
              code: "backchannel_temporarily_unavailable",
              message: "The logout request could not be completed.",
              statusCode: 503,
            });
          }
          return false;
        }
      },
      validateSessionCsrf: (request) => {
        const validatedSession = sessionService.validateSessionCsrf(
          request.cookies[sessionCookieName(config)],
          sessionCsrfProof(request),
          { ipAddress: request.ip, requestId: request.id },
        );
        request.validatedSession = validatedSession;
        return validatedSession !== null;
      },
    });

    app.setErrorHandler(async (error, request, reply) => {
      const handledError = error as Error & {
        code?: string;
        statusCode?: number;
        validation?: unknown;
      };
      const validationFailure = handledError.validation || handledError instanceof ZodError;
      const safeHttpError = isSafeHttpError(error) ? error : undefined;
      const statusCode = validationFailure
        ? 400
        : (safeHttpError?.statusCode ?? frameworkErrorStatus(handledError.statusCode));
      const publicCode = safeHttpError
        ? safeHttpError.code
        : validationFailure
          ? "invalid_request"
          : statusCode >= 500
            ? "internal_error"
            : "request_failed";
      const publicMessage = safeHttpError
        ? safeHttpError.message
        : statusCode >= 500
          ? "The gateway could not complete the request."
          : validationFailure
            ? "The request did not match the expected shape."
            : "The gateway rejected the request.";
      if (statusCode >= 500) {
        request.log.error(
          { err: handledError, operation: "http.request", requestId: request.id },
          "Request failed",
        );
      } else {
        request.log.warn(
          {
            errorCode: publicCode,
            operation: "http.request",
            requestId: request.id,
            statusCode,
          },
          "Request rejected",
        );
      }

      await reply.status(statusCode).send(
        createApiError({
          code: publicCode,
          message: publicMessage,
          requestId: request.id,
          ...(safeHttpError?.details === undefined ? {} : { details: safeHttpError.details }),
        }),
      );
    });

    app.setNotFoundHandler(async (request, reply) => {
      await reply.status(404).send(
        createApiError({
          code: "request_failed",
          message: "The requested resource does not exist.",
          requestId: request.id,
        }),
      );
    });

    app.addHook("onClose", async () => {
      closeDatabase();
    });

    await app.register(healthRoutes);
    await app.register(authProviderRoutes);
    await app.register(oidcProviderAdminRoutes, {
      ...(options.oidcProviderAdminDependencies === undefined
        ? {}
        : { dependencies: options.oidcProviderAdminDependencies }),
    });
    await app.register(oidcRoleMappingAdminRoutes, {
      ...(options.oidcRoleMappingAdminDependencies === undefined
        ? {}
        : { dependencies: options.oidcRoleMappingAdminDependencies }),
    });
    await app.register(jellyfinRoutes, {
      ...(options.jellyfinDependencies === undefined
        ? {}
        : { dependencies: options.jellyfinDependencies }),
      ...(options.jellyfinQuickConnectDependencies === undefined
        ? {}
        : { quickConnectDependencies: options.jellyfinQuickConnectDependencies }),
    });
    await app.register(
      oidcRoutes,
      options.oidcDependencies === undefined ? {} : { dependencies: options.oidcDependencies },
    );
    await app.register(
      recoveryRoutes,
      options.recoveryAccessDependencies === undefined
        ? {}
        : { dependencies: options.recoveryAccessDependencies },
    );
    await app.register(sessionRoutes);
    await app.register(
      identityLinkRoutes,
      options.identityLinkDependencies === undefined
        ? {}
        : { dependencies: options.identityLinkDependencies },
    );
    return app;
  } catch (initializationError) {
    const cleanupErrors: unknown[] = [];
    if (app) {
      try {
        await app.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      closeDatabase();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [initializationError, ...cleanupErrors],
        "Gateway initialization failed and cleanup did not complete.",
      );
    }
    throw initializationError;
  }
}
