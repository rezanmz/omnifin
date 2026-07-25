import cookie from "@fastify/cookie";
import formBody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { createApiError } from "@omnifin/contracts/errors";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { authProviderRoutes } from "./auth/provider-routes.js";
import { type AppConfig, loadConfig } from "./config.js";
import { type DatabaseHandle, openDatabase } from "./db/client.js";
import { healthRoutes } from "./health.js";
import { createLoggerOptions } from "./logger.js";
import { asStartupError } from "./startup-error.js";

declare module "fastify" {
  interface FastifyInstance {
    appConfig: AppConfig;
    database: DatabaseHandle;
  }
}

export interface CreateAppOptions {
  config?: AppConfig;
  database?: DatabaseHandle;
  migrate?: boolean;
}

function requestId(incomingId: string | undefined) {
  if (incomingId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId)) return incomingId;
  return randomUUID();
}

function isMutation(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
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

    app = Fastify({
      bodyLimit: 64 * 1_024,
      genReqId: (request) => requestId(request.headers["x-request-id"] as string | undefined),
      logger: createLoggerOptions(config),
      requestIdHeader: false,
      trustProxy: config.trustProxyHops,
    });

    app.decorate("appConfig", config);
    app.decorate("database", database);

    await app.register(cookie, { hook: "onRequest" });
    await app.register(formBody, { bodyLimit: 64 * 1_024 });
    await app.register(sensible);
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      hook: "onRequest",
      keyGenerator: (request) => request.ip,
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

    app.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
      reply.header(
        "permissions-policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      );
      if (!isMutation(request.method) || request.url.startsWith("/v1/auth/oidc/backchannel/"))
        return;

      const origin = request.headers.origin;
      if (!origin || origin !== config.baseUrl.origin) {
        await reply.status(403).send({
          ...createApiError({
            code: "origin_denied",
            message: "The request origin is not allowed.",
            requestId: request.id,
          }),
        });
      }
    });

    app.setErrorHandler(async (error, request, reply) => {
      const handledError = error as Error & {
        code?: string;
        statusCode?: number;
        validation?: unknown;
      };
      const validationFailure = handledError.validation || handledError instanceof ZodError;
      const statusCode = validationFailure ? 400 : (handledError.statusCode ?? 500);
      if (statusCode >= 500) {
        request.log.error(
          { err: handledError, operation: "http.request", requestId: request.id },
          "Request failed",
        );
      } else {
        request.log.warn(
          { code: handledError.code, operation: "http.request", requestId: request.id, statusCode },
          "Request rejected",
        );
      }

      await reply.status(statusCode).send(
        createApiError({
          code: validationFailure
            ? "invalid_request"
            : statusCode >= 500
              ? "internal_error"
              : "request_failed",
          message:
            statusCode >= 500
              ? "The gateway could not complete the request."
              : validationFailure
                ? "The request did not match the expected shape."
                : "The gateway rejected the request.",
          requestId: request.id,
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
