import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { sessionCookieName, writeSessionCookie } from "../session-cookie.js";
import { SessionIssuanceLimitError } from "../session-service.js";
import { SafeHttpError } from "../../http-error.js";
import { clientNetworkGroup } from "../../security/client-network.js";
import { randomToken } from "../../security/crypto.js";
import {
  canonicalLocalReturnPath,
  canonicalOidcCallbackUri,
  clearOidcTransactionBindingCookie,
  oidcBrowserBindingCookieName,
  oidcTransactionBindingCookieName,
  OIDC_TRANSACTION_TTL_MS,
  OidcAuthorizationTransactionError,
  OidcAuthorizationTransactionService,
  type OidcAuthorizationTransactionDependencies,
  writeOidcBrowserBindingCookie,
  writeOidcTransactionBindingCookie,
} from "./authorization-transaction.js";
import {
  OidcFailureAuditService,
  type OidcFailureAuditDependencies,
  type OidcFailureAuditReason,
} from "./failure-audit.js";
import {
  OidcIdentityService,
  type OidcIdentityDenialReason,
  type OidcIdentityServiceDependencies,
} from "./identity-service.js";
import {
  OidcProtocolError,
  OidcProtocolService,
  type OidcProtocolDependencies,
} from "./protocol.js";
import {
  createOidcProviderRuntimeBindingVerifier,
  OidcProviderRegistry,
  oidcProviderRuntimeBinding,
  type OidcProviderRegistryDependencies,
  OidcProviderRegistryError,
} from "./provider-registry.js";
import { OidcSignInService } from "./sign-in-service.js";

const ALLOWED_RETURN_PATHS = new Set(["/", "/settings"]);
const MAX_CALLBACK_REQUEST_TARGET_LENGTH = 16_384;
const MAX_START_REQUEST_TARGET_LENGTH = 4_096;
const OPAQUE_256_BIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type OidcBrowserError =
  | "account_not_authorized"
  | "authorization_denied"
  | "authentication_failed"
  | "invalid_request"
  | "provider_unavailable"
  | "session_limit_reached";

class OidcBrowserRouteError extends Error {
  public constructor() {
    super("The browser authentication request is invalid.");
    this.name = "OidcBrowserRouteError";
  }
}

interface ParsedCallbackRequest {
  readonly query: string;
  readonly state: string;
}

type ParsedCallbackResponse =
  | { readonly kind: "authorization_denied" }
  | { readonly callbackUrl: URL; readonly kind: "authorization_code" }
  | { readonly kind: "provider_error" };

function safeReturnPath(value: unknown) {
  let returnPath: string;
  try {
    returnPath = canonicalLocalReturnPath(value === undefined ? "/" : value);
  } catch {
    throw new OidcBrowserRouteError();
  }
  if (!ALLOWED_RETURN_PATHS.has(returnPath)) throw new OidcBrowserRouteError();
  return returnPath;
}

function startReturnPath(rawUrl: unknown) {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_START_REQUEST_TARGET_LENGTH
  ) {
    throw new OidcBrowserRouteError();
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(rawUrl, "http://gateway.invalid");
  } catch {
    throw new OidcBrowserRouteError();
  }
  const keys = [...requestUrl.searchParams.keys()];
  if (keys.some((key) => key !== "returnPath")) throw new OidcBrowserRouteError();
  const returnPaths = requestUrl.searchParams.getAll("returnPath");
  if (returnPaths.length > 1) throw new OidcBrowserRouteError();
  return safeReturnPath(returnPaths[0]);
}

function callbackRequest(rawUrl: unknown): ParsedCallbackRequest {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_CALLBACK_REQUEST_TARGET_LENGTH
  ) {
    throw new OidcBrowserRouteError();
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(rawUrl, "http://gateway.invalid");
  } catch {
    throw new OidcBrowserRouteError();
  }
  if (
    requestUrl.origin !== "http://gateway.invalid" ||
    requestUrl.username !== "" ||
    requestUrl.password !== "" ||
    requestUrl.hash !== ""
  ) {
    throw new OidcBrowserRouteError();
  }
  const states = requestUrl.searchParams.getAll("state");
  if (states.length !== 1 || !isCanonicalBrowserBinding(states[0])) {
    throw new OidcBrowserRouteError();
  }
  return Object.freeze({ query: requestUrl.search, state: states[0] });
}

function callbackResponse(
  request: ParsedCallbackRequest,
  redirectUri: string,
): ParsedCallbackResponse {
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(redirectUri);
    callbackUrl.search = request.query;
  } catch {
    throw new OidcBrowserRouteError();
  }
  if (
    callbackUrl.href.length > MAX_CALLBACK_REQUEST_TARGET_LENGTH ||
    callbackUrl.username !== "" ||
    callbackUrl.password !== "" ||
    callbackUrl.hash !== "" ||
    callbackUrl.searchParams.getAll("state").length !== 1 ||
    callbackUrl.searchParams.get("state") !== request.state
  ) {
    throw new OidcBrowserRouteError();
  }
  const codes = callbackUrl.searchParams.getAll("code");
  const errors = callbackUrl.searchParams.getAll("error");
  if (codes.length === 1 && codes[0] !== "" && errors.length === 0) {
    return Object.freeze({ callbackUrl, kind: "authorization_code" });
  }
  if (errors.length === 1 && errors[0] !== "" && codes.length === 0) {
    return errors[0] === "access_denied"
      ? Object.freeze({ kind: "authorization_denied" })
      : Object.freeze({ kind: "provider_error" });
  }
  throw new OidcBrowserRouteError();
}

function isCanonicalBrowserBinding(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_256_BIT_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function preflightLocation(providerId: string, returnPath: string) {
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new OidcBrowserRouteError();
  const query = new URLSearchParams({ returnPath });
  return `/api/auth/oidc/${encodeURIComponent(providerId)}/start?${query.toString()}`;
}

function failureLocation(error: OidcBrowserError) {
  return `/login?authError=${error}`;
}

function isRateLimitFailure(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  try {
    return "statusCode" in error && error.statusCode === 429;
  } catch {
    return false;
  }
}

function startFailure(error: unknown): {
  auditReason: OidcFailureAuditReason;
  browserError: OidcBrowserError;
} {
  if (
    error instanceof OidcBrowserRouteError ||
    (error instanceof OidcAuthorizationTransactionError &&
      error.code === "oidc_transaction_invalid")
  ) {
    return { auditReason: "invalid_request", browserError: "invalid_request" };
  }
  if (error instanceof OidcProviderRegistryError) {
    return { auditReason: "provider_unavailable", browserError: "provider_unavailable" };
  }
  if (error instanceof OidcProtocolError) {
    return { auditReason: "provider_unavailable", browserError: "provider_unavailable" };
  }
  return { auditReason: "internal_failure", browserError: "authentication_failed" };
}

function callbackFailure(error: unknown): {
  auditReason: OidcFailureAuditReason;
  browserError: OidcBrowserError;
  outcome?: "denied" | "failure";
} {
  if (
    error instanceof OidcBrowserRouteError ||
    (error instanceof OidcAuthorizationTransactionError &&
      error.code === "oidc_transaction_invalid")
  ) {
    return { auditReason: "callback_validation_failed", browserError: "invalid_request" };
  }
  if (error instanceof OidcAuthorizationTransactionError) {
    return { auditReason: "internal_failure", browserError: "authentication_failed" };
  }
  if (error instanceof OidcProviderRegistryError) {
    return { auditReason: "provider_unavailable", browserError: "provider_unavailable" };
  }
  if (error instanceof SessionIssuanceLimitError) {
    return {
      auditReason: "session_limit_reached",
      browserError: "session_limit_reached",
      outcome: "denied",
    };
  }
  if (error instanceof OidcProtocolError) {
    if (error.code === "oidc_protocol_token_exchange_failed") {
      return { auditReason: "token_exchange_failed", browserError: "authentication_failed" };
    }
    if (error.code === "oidc_protocol_claims_invalid") {
      return { auditReason: "claims_invalid", browserError: "authentication_failed" };
    }
    return { auditReason: "callback_validation_failed", browserError: "authentication_failed" };
  }
  return { auditReason: "internal_failure", browserError: "authentication_failed" };
}

export interface OidcRoutesDependencies {
  authorizationTransaction?: OidcAuthorizationTransactionDependencies;
  failureAudit?: OidcFailureAuditDependencies;
  identity?: Omit<OidcIdentityServiceDependencies, "providerBindingVerifier">;
  protocol?: OidcProtocolDependencies;
  providerRegistry?: OidcProviderRegistryDependencies;
}

export interface OidcRoutesOptions {
  dependencies?: OidcRoutesDependencies;
}

export const oidcRoutes: FastifyPluginAsync<OidcRoutesOptions> = async (app, options) => {
  const dependencies = options.dependencies ?? {};
  const providerRegistry = new OidcProviderRegistry(
    app.database,
    app.appConfig,
    dependencies.providerRegistry,
  );
  const transactions = new OidcAuthorizationTransactionService(
    app.database,
    app.appConfig,
    dependencies.authorizationTransaction,
  );
  const protocol = new OidcProtocolService(dependencies.protocol);
  const identity = new OidcIdentityService(app.database, {
    ...dependencies.identity,
    providerBindingVerifier: createOidcProviderRuntimeBindingVerifier(app.database, app.appConfig),
  });
  const signIn = new OidcSignInService(app.database, identity, app.sessionService);
  const failureAudit = new OidcFailureAuditService(
    app.database,
    app.appConfig,
    dependencies.failureAudit,
  );
  const bindingClock = dependencies.authorizationTransaction?.clock ?? (() => new Date());
  const createBrowserBinding =
    dependencies.authorizationTransaction?.createBrowserBinding ?? (() => randomToken(32));
  const globalStartRateLimit = app.createRateLimit({
    keyGenerator: () => "oidc-start-global:v1",
    max: 512,
    timeWindow: "10 minutes",
  });
  const startClientRateLimit = app.createRateLimit({
    keyGenerator: (request) => clientNetworkGroup(request.ip),
    max: 20,
    timeWindow: "1 minute",
  });
  const startAuditWorkRateLimit = app.createRateLimit({
    keyGenerator: () => "oidc-start-audit-work:v1",
    max: 512,
    timeWindow: "10 minutes",
  });
  const callbackClientRateLimit = app.createRateLimit({
    keyGenerator: (request) => clientNetworkGroup(request.ip),
    max: 30,
    timeWindow: "1 minute",
  });
  const callbackAuditWorkRateLimit = app.createRateLimit({
    keyGenerator: () => "oidc-callback-audit-work:v1",
    max: 512,
    timeWindow: "10 minutes",
  });
  const recordedRequests = new WeakSet<FastifyRequest>();
  const suppressedAuditRequests = new WeakSet<FastifyRequest>();
  const startAuditBudgetedRequests = new WeakSet<FastifyRequest>();

  const recordFailure = (
    request: FastifyRequest,
    reason: OidcFailureAuditReason,
    outcome: "denied" | "failure" = "failure",
    identityReason?: OidcIdentityDenialReason,
  ) => {
    if (recordedRequests.has(request) || suppressedAuditRequests.has(request)) return;
    recordedRequests.add(request);
    try {
      const context = {
        ipAddress: request.ip,
        outcome,
        requestId: request.id,
        userAgent: request.headers["user-agent"],
      };
      if (reason === "identity_rejected") {
        if (identityReason === undefined) {
          throw new TypeError("OIDC identity denial reason is required.");
        }
        failureAudit.record({ ...context, identityReason, reason });
      } else {
        if (identityReason !== undefined) {
          throw new TypeError("OIDC identity denial reason is invalid.");
        }
        failureAudit.record({ ...context, reason });
      }
    } catch (error) {
      request.log.error(
        { err: error, operation: "http.request", requestId: request.id },
        "Request failed",
      );
    }
  };

  const recordStartFailure = async (
    request: FastifyRequest,
    reason: OidcFailureAuditReason,
    outcome: "denied" | "failure" = "failure",
  ) => {
    if (recordedRequests.has(request) || startAuditBudgetedRequests.has(request)) return;
    startAuditBudgetedRequests.add(request);
    suppressedAuditRequests.add(request);
    try {
      const auditBudget = await startAuditWorkRateLimit(request);
      if (auditBudget.isAllowed || !auditBudget.isExceeded) {
        suppressedAuditRequests.delete(request);
      }
    } catch (error) {
      request.log.error(
        { err: error, operation: "http.request", requestId: request.id },
        "Request failed",
      );
    }
    recordFailure(request, reason, outcome);
  };

  const enforceRateLimit = async (
    limiter: ReturnType<typeof app.createRateLimit>,
    request: FastifyRequest,
    reply: FastifyReply,
    message: string,
  ) => {
    const result = await limiter(request);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("x-ratelimit-limit", result.max);
    reply.header("x-ratelimit-remaining", 0);
    reply.header("x-ratelimit-reset", result.ttlInSeconds);
    reply.header("retry-after", Math.max(result.ttlInSeconds, 1));
    throw new SafeHttpError({
      code: "rate_limit_exceeded",
      message,
      statusCode: 429,
    });
  };

  app.get<{
    Params: { providerId: string };
    Querystring: { returnPath?: string };
  }>(
    "/v1/auth/oidc/:providerId/start",
    {
      exposeHeadRoute: false,
      onError: async (request, reply, error) => {
        if (error instanceof SafeHttpError && error.statusCode === 429) {
          const retryAfter = reply.getHeader("retry-after");
          if (retryAfter === undefined) reply.header("retry-after", 600);
        }
        await recordStartFailure(request, "invalid_request");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      try {
        await enforceRateLimit(
          startClientRateLimit,
          request,
          reply,
          "Too many authentication attempts were started.",
        );
        const returnPath = startReturnPath(request.raw.url);
        const providerId = request.params.providerId;
        if (!PROVIDER_ID_PATTERN.test(providerId)) throw new OidcBrowserRouteError();
        const currentBinding = request.cookies[oidcBrowserBindingCookieName(app.appConfig)];
        if (!isCanonicalBrowserBinding(currentBinding)) {
          const browserBindingToken = createBrowserBinding();
          const now = bindingClock();
          const expiresAt =
            now instanceof Date && Number.isSafeInteger(now.getTime())
              ? new Date(now.getTime() + OIDC_TRANSACTION_TTL_MS)
              : new Date(Number.NaN);
          writeOidcBrowserBindingCookie(reply, app.appConfig, browserBindingToken, expiresAt);
          return reply.redirect(preflightLocation(providerId, returnPath), 303);
        }
        await enforceRateLimit(
          globalStartRateLimit,
          request,
          reply,
          "Too many authentication attempts were started.",
        );
        const runtime = await providerRegistry.discover(providerId);
        const providerRuntimeBinding = oidcProviderRuntimeBinding(runtime);
        protocol.assertAuthorizationRequestViable(runtime, {
          providerId,
          redirectUri: canonicalOidcCallbackUri(app.appConfig.baseUrl, providerId),
        });
        const transaction = await transactions.create({
          browserBindingToken: currentBinding,
          providerId,
          providerRuntimeBinding,
          returnPath,
        });
        try {
          const redirect = protocol.buildAuthorizationRequest(runtime, transaction);
          writeOidcBrowserBindingCookie(
            reply,
            app.appConfig,
            transaction.browserBindingToken,
            transaction.expiresAt,
          );
          writeOidcTransactionBindingCookie(
            reply,
            app.appConfig,
            transaction.state,
            transaction.browserBindingToken,
            transaction.expiresAt,
          );
          return reply.redirect(redirect.authorizationUrl, 302);
        } catch (error) {
          try {
            transactions.cancel({
              browserBindingToken: transaction.browserBindingToken,
              providerId: transaction.providerId,
              state: transaction.state,
            });
          } catch (cleanupError) {
            request.log.error(
              { err: cleanupError, operation: "http.request", requestId: request.id },
              "Request failed",
            );
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof SafeHttpError) throw error;
        const failure = startFailure(error);
        await recordStartFailure(request, failure.auditReason);
        return reply.redirect(failureLocation(failure.browserError), 303);
      }
    },
  );

  app.get<{
    Params: { providerId: string };
  }>(
    "/v1/auth/oidc/callback/:providerId",
    {
      exposeHeadRoute: false,
      onError: async (request, reply, error) => {
        const rateLimited = isRateLimitFailure(error);
        if (rateLimited) {
          const retryAfter = reply.getHeader("retry-after");
          if (retryAfter === undefined) reply.header("retry-after", 60);
          return;
        }
        recordFailure(request, "invalid_request");
      },
      onSend: async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return payload;
      },
    },
    async (request, reply) => {
      try {
        await enforceRateLimit(
          callbackClientRateLimit,
          request,
          reply,
          "Too many authentication callbacks were received.",
        );
        const auditBudget = await callbackAuditWorkRateLimit(request);
        if (!auditBudget.isAllowed && auditBudget.isExceeded) {
          suppressedAuditRequests.add(request);
        }
        const providerId = request.params.providerId;
        if (!PROVIDER_ID_PATTERN.test(providerId)) throw new OidcBrowserRouteError();
        const parsedRequest = callbackRequest(request.raw.url);
        const browserBinding =
          request.cookies[oidcTransactionBindingCookieName(app.appConfig, parsedRequest.state)];
        const transaction = transactions.consume({
          browserBindingToken: browserBinding ?? "",
          providerId,
          state: parsedRequest.state,
        });
        clearOidcTransactionBindingCookie(reply, app.appConfig, parsedRequest.state);
        const returnPath = safeReturnPath(transaction.returnPath);
        const response = callbackResponse(parsedRequest, transaction.redirectUri);
        if (response.kind === "authorization_denied") {
          recordFailure(request, "authorization_denied", "denied");
          return reply.redirect(failureLocation("authorization_denied"), 303);
        }
        if (response.kind === "provider_error") {
          recordFailure(request, "callback_validation_failed");
          return reply.redirect(failureLocation("authentication_failed"), 303);
        }

        const runtime = await providerRegistry.discover(providerId);
        const grant = await protocol.completeAuthorization({
          callbackUrl: response.callbackUrl,
          runtime,
          transaction,
        });
        const result = signIn.signIn({
          currentSessionToken: request.cookies[sessionCookieName(app.appConfig)],
          grant,
          ipAddress: request.ip,
          requestId: request.id,
          ...(request.headers["user-agent"] === undefined
            ? {}
            : { userAgent: request.headers["user-agent"] }),
        });
        if (result.status === "denied") {
          recordFailure(request, "identity_rejected", "denied", result.reason);
          return reply.redirect(failureLocation("account_not_authorized"), 303);
        }
        writeSessionCookie(
          reply,
          app.appConfig,
          result.session.sessionToken,
          result.session.absoluteExpiresAt,
        );
        return reply.redirect(returnPath, 303);
      } catch (error) {
        if (error instanceof SafeHttpError) throw error;
        const failure = callbackFailure(error);
        recordFailure(request, failure.auditReason, failure.outcome);
        return reply.redirect(failureLocation(failure.browserError), 303);
      }
    },
  );
};
