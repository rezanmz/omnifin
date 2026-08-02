import type { LoggerOptions } from "pino";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { AppConfig } from "./config.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const OPAQUE_OBJECT = "[OPAQUE_OBJECT]";
const MAX_LOG_NESTING = 24;
const MAX_ERROR_CAUSE_DEPTH = 6;
const SAFE_FAILURE_REASONS = new Set(["integrity_failure", "storage_failure"]);
const SAFE_FAILURE_STAGES = new Set([
  "connector_negotiation",
  "session_payload_validation",
  "session_persistence",
]);
const SAFE_INFRASTRUCTURE_ERROR_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_CANTOPEN",
  "SQLITE_CONSTRAINT",
  "SQLITE_CONSTRAINT_CHECK",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
]);
const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "gateway.shutdown": "Graceful shutdown failed",
  "gateway.startup": "Gateway startup failed",
  "http.request": "Request failed",
});

const SENSITIVE_NORMALIZED_KEYS = new Set([
  "apikey",
  "assertion",
  "assertions",
  "authheader",
  "authorization",
  "authorizationcode",
  "authorizationheader",
  "cookie",
  "code",
  "credential",
  "credentials",
  "encryptionkey",
  "encryptedidtokenhint",
  "encryptedpayload",
  "idtokenhint",
  "masterkey",
  "mediapath",
  "nonce",
  "password",
  "passwords",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "pw",
  "pws",
  "rootfolder",
  "routing",
  "routingreference",
  "secret",
  "secrets",
  "sessionid",
  "setcookie",
  "signingkey",
  "state",
  "filepath",
  "filesystempath",
  "xapikey",
]);

type LogEnvironment = AppConfig["environment"] | "unknown";

function normalizedKey(key: string) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string) {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_NORMALIZED_KEYS.has(normalized) ||
    normalized.endsWith("assertion") ||
    normalized.endsWith("codeverifier") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("cookies") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("nonce") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    /sessionid(?:digest|hash|value)?$/.test(normalized) ||
    /(?:assertion|authorization|password|pw|secret|token)(?:digest|hash|value)$/.test(normalized) ||
    normalized === "codeverifier"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorType(value: unknown) {
  const fallback = "Error";
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    return fallback;
  }
  return value;
}

export function safeFailureDiagnostics(error: unknown) {
  let connectorErrorCode: string | undefined;
  let connectorOperation: string | undefined;
  let connectorService: string | undefined;
  let current: unknown = error;
  let failureReason: string | undefined;
  let failureStage: string | undefined;
  let infrastructureCode: string | undefined;
  let upstreamStatus: number | undefined;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && isRecord(current); depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    try {
      if (connectorService === undefined && current instanceof SafeConnectorError) {
        connectorErrorCode = current.code;
        connectorOperation = current.operation;
        connectorService = current.service;
        if (current.status !== null) upstreamStatus = current.status;
      }
      if (
        failureReason === undefined &&
        typeof current.reason === "string" &&
        SAFE_FAILURE_REASONS.has(current.reason)
      ) {
        failureReason = current.reason;
      }
      if (
        failureStage === undefined &&
        typeof current.stage === "string" &&
        SAFE_FAILURE_STAGES.has(current.stage)
      ) {
        failureStage = current.stage;
      }
      if (
        infrastructureCode === undefined &&
        typeof current.code === "string" &&
        SAFE_INFRASTRUCTURE_ERROR_CODES.has(current.code)
      ) {
        infrastructureCode = current.code;
      }
      current = current.cause;
    } catch {
      break;
    }
  }

  return {
    ...(connectorErrorCode === undefined ? {} : { connectorErrorCode }),
    ...(connectorOperation === undefined ? {} : { connectorOperation }),
    ...(connectorService === undefined ? {} : { connectorService }),
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(infrastructureCode === undefined ? {} : { infrastructureCode }),
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  };
}

function safeError(error: unknown) {
  if (!isRecord(error)) return { type: "Error" };

  const type = safeErrorType(error instanceof Error ? error.name : (error.type ?? error.name));
  let code: unknown;
  let statusCode: unknown;
  try {
    code = error.errorCode ?? error.code;
    statusCode = error.statusCode;
  } catch {
    return { type };
  }

  return {
    ...(typeof code === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(code)
      ? { errorCode: code }
      : {}),
    ...(typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
      ? { statusCode }
      : {}),
    type,
  };
}

function containsError(value: unknown, seen: WeakSet<object>, depth: number): boolean {
  if (value instanceof Error) return true;
  if (!isRecord(value)) return false;
  if (depth > MAX_LOG_NESTING || seen.has(value)) return depth > MAX_LOG_NESTING;
  seen.add(value);

  let entries: unknown[];
  try {
    entries = Array.isArray(value) ? value : Object.values(value);
  } catch {
    return true;
  }
  return entries.some((entry) => containsError(entry, seen, depth + 1));
}

function safeErrorMessage(value: unknown) {
  if (!isRecord(value)) return "Error logged";
  let operation: unknown;
  try {
    operation = value.operation;
  } catch {
    return "Error logged";
  }
  return typeof operation === "string" && Object.hasOwn(SAFE_ERROR_MESSAGES, operation)
    ? SAFE_ERROR_MESSAGES[operation]
    : "Error logged";
}

function sanitizeLogValue(value: unknown, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (value instanceof Error) return safeError(value);
  if (depth > MAX_LOG_NESTING) return TRUNCATED;
  if (!isRecord(value)) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const entry of value) {
      sanitized.push(sanitizeLogValue(entry, seen, depth + 1));
    }
    return sanitized;
  }

  let prototype: object | null;
  let keys: string[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Object.keys(value);
  } catch {
    return TRUNCATED;
  }
  if (prototype !== Object.prototype && prototype !== null) return OPAQUE_OBJECT;

  const sanitized: Record<string, unknown> = {};
  seen.set(value, sanitized);
  for (const key of keys) {
    let sanitizedValue: unknown;
    if (isSensitiveKey(key)) {
      sanitizedValue = REDACTED;
    } else {
      try {
        sanitizedValue = sanitizeLogValue(value[key], seen, depth + 1);
      } catch {
        sanitizedValue = TRUNCATED;
      }
    }
    Object.defineProperty(sanitized, key, {
      configurable: true,
      enumerable: true,
      value: sanitizedValue,
      writable: true,
    });
  }
  return sanitized;
}

function sanitizeLogRecord(record: Record<string, unknown>) {
  return sanitizeLogValue(record, new WeakMap(), 0) as Record<string, unknown>;
}

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
    formatters: {
      bindings: sanitizeLogRecord,
      log: sanitizeLogRecord,
    },
    hooks: {
      logMethod(args, method) {
        if (args.some((argument) => containsError(argument, new WeakSet(), 0))) {
          const structuredArgument = args.find(isRecord);
          const logObject =
            structuredArgument instanceof Error
              ? { err: structuredArgument }
              : (structuredArgument ?? {});
          method.apply(this, [logObject, safeErrorMessage(args[0])]);
          return;
        }
        method.apply(this, args);
      },
    },
    redact: {
      censor: REDACTED,
      paths: [
        'req.headers["Authorization"]',
        'req.headers["Cookie"]',
        'req.headers["Proxy-Authorization"]',
        'req.headers["X-API-Key"]',
        'req.headers["proxy-authorization"]',
        'req.headers["x-api-key"]',
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["Set-Cookie"]',
        'res.headers["set-cookie"]',
      ],
      remove: false,
    },
    serializers: {
      err(error: unknown) {
        return safeError(error);
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
