import type { LoggerOptions } from "pino";
import type { AppConfig } from "./config.js";

const REDACTED = "[REDACTED]";

type LogEnvironment = AppConfig["environment"] | "unknown";

function pathnameOnly(rawUrl: string | undefined) {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, "http://gateway.invalid").pathname;
  } catch {
    return "[INVALID_URL]";
  }
}

function loggerOptions(environment: LogEnvironment, level: AppConfig["logLevel"]): LoggerOptions {
  return {
    base: {
      component: "gateway",
      environment,
    },
    level,
    messageKey: "message",
    redact: {
      censor: REDACTED,
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-api-key",
        "res.headers.set-cookie",
        "*.accessToken",
        "*.clientSecret",
        "*.code",
        "*.cookie",
        "*.idToken",
        "*.password",
        "*.refreshToken",
        "*.token",
      ],
      remove: false,
    },
    serializers: {
      err(error: Error & { code?: string; statusCode?: number }) {
        return {
          ...(error.code ? { code: error.code } : {}),
          ...(error.statusCode ? { statusCode: error.statusCode } : {}),
          type: error.name,
        };
      },
      req(request: { id?: string; method?: string; url?: string }) {
        return {
          id: request.id,
          method: request.method,
          path: pathnameOnly(request.url),
        };
      },
      res(response: { statusCode?: number }) {
        return { statusCode: response.statusCode };
      },
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  };
}

export function createBootstrapLoggerOptions(environment: string | undefined): LoggerOptions {
  const normalizedEnvironment =
    environment === "development" || environment === "test" || environment === "production"
      ? environment
      : "unknown";
  return loggerOptions(normalizedEnvironment, "info");
}

export function createLoggerOptions(config: AppConfig): LoggerOptions {
  return loggerOptions(config.environment, config.logLevel);
}
