import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  stackVerificationResponseJsonSchema,
  stackVerificationResponseSchema,
  type StackVerificationFindingCode,
} from "@omnifin/contracts/setup";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  OidcProviderAdminService,
  type OidcProviderValidationAuditReason,
} from "../auth/oidc/provider-admin-service.js";
import { OidcProviderRegistry, OidcProviderRegistryError } from "../auth/oidc/provider-registry.js";
import { requirePermission } from "../auth/authorization.js";
import { ConnectorAdminError, ConnectorAdminService } from "../connectors/admin-service.js";
import { SafeHttpError } from "../http-error.js";
import {
  StackVerificationError,
  StackVerificationService,
  type StackVerificationContext,
  type StackVerificationDependencies,
} from "./stack-verification-service.js";

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function administrator(request: FastifyRequest) {
  const principal = requirePermission(
    request.server.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
    "connectors.manage",
  );
  return requirePermission(principal, "recovery.oidc.manage");
}

function context(request: FastifyRequest, principal: SessionPrincipal): StackVerificationContext {
  return { ipAddress: request.ip, principal, requestId: request.id };
}

function oidcAuditReason(error: OidcProviderRegistryError): OidcProviderValidationAuditReason {
  if (error.code === "oidc_provider_logout_token_invalid") {
    return "oidc_provider_discovery_failed";
  }
  return error.code;
}

function oidcFinding(error: OidcProviderRegistryError): StackVerificationFindingCode {
  if (error.code === "oidc_provider_misconfigured") return "configuration_invalid";
  if (error.code === "oidc_provider_discovery_failed") return "unreachable";
  return "verification_unavailable";
}

function connectorFinding(error: ConnectorAdminError): StackVerificationFindingCode {
  return error.reason === "configuration_invalid"
    ? "configuration_invalid"
    : "verification_unavailable";
}

export interface StackVerificationRoutesDependencies {
  connectorAdmin?: ConstructorParameters<typeof ConnectorAdminService>[2];
  oidcProviderAdmin?: ConstructorParameters<typeof OidcProviderAdminService>[2];
  oidcProviderRegistry?: ConstructorParameters<typeof OidcProviderRegistry>[2];
  service?: Partial<StackVerificationDependencies>;
}

export interface StackVerificationRoutesOptions {
  dependencies?: StackVerificationRoutesDependencies;
}

export const stackVerificationRoutes: FastifyPluginAsync<StackVerificationRoutesOptions> = async (
  app,
  options,
) => {
  const connectors = new ConnectorAdminService(
    app.database,
    app.appConfig,
    options.dependencies?.connectorAdmin,
  );
  const providers = new OidcProviderAdminService(
    app.database,
    app.appConfig,
    options.dependencies?.oidcProviderAdmin,
  );
  const providerRegistry = new OidcProviderRegistry(
    app.database,
    app.appConfig,
    options.dependencies?.oidcProviderRegistry,
  );
  const verification = new StackVerificationService(app.database, {
    ...(options.dependencies?.service?.clock === undefined
      ? {}
      : { clock: options.dependencies.service.clock }),
    probeConnector:
      options.dependencies?.service?.probeConnector ??
      (async (connectorId, probeContext) => {
        try {
          const connector = await connectors.probe(connectorId, probeContext);
          return connector.lastProbe === null
            ? { finding: "verification_unavailable" as const, kind: "unavailable" as const }
            : { kind: "completed" as const, value: connector.lastProbe };
        } catch (error) {
          return {
            finding:
              error instanceof ConnectorAdminError
                ? connectorFinding(error)
                : "verification_unavailable",
            kind: "unavailable" as const,
          };
        }
      }),
    validateOidcProvider:
      options.dependencies?.service?.validateOidcProvider ??
      (async (providerId, probeContext) => {
        try {
          const runtime = await providerRegistry.validate(providerId);
          providers.recordValidation(providerId, probeContext, "success", "ready", false);
          return { kind: "completed" as const, value: runtime.provider.capabilities };
        } catch (error) {
          if (error instanceof OidcProviderRegistryError) {
            try {
              providers.recordValidation(
                providerId,
                probeContext,
                "failure",
                oidcAuditReason(error),
                error.retryable,
              );
            } catch {
              return {
                finding: "verification_unavailable" as const,
                kind: "unavailable" as const,
              };
            }
            return { finding: oidcFinding(error), kind: "unavailable" as const };
          }
          return { finding: "verification_unavailable" as const, kind: "unavailable" as const };
        }
      }),
  });
  const inFlightSessions = new Set<string>();

  app.post(
    "/v1/admin/setup/verification",
    {
      bodyLimit: 1,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 2, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: { response: { 200: stackVerificationResponseJsonSchema } },
    },
    async (request, reply) => {
      const principal = administrator(request);
      if (inFlightSessions.has(principal.sessionId)) {
        reply.header("retry-after", "5");
        throw new SafeHttpError({
          code: "stack_verification_in_progress",
          message: "A stack verification is already running for this session.",
          statusCode: 409,
        });
      }
      inFlightSessions.add(principal.sessionId);
      try {
        return stackVerificationResponseSchema.parse(
          await verification.run(context(request, principal)),
        );
      } catch (error) {
        if (error instanceof StackVerificationError) {
          reply.header("retry-after", "5");
          throw new SafeHttpError({
            cause: error,
            code: "stack_verification_unavailable",
            message: "Stack verification is temporarily unavailable.",
            statusCode: 503,
          });
        }
        throw error;
      } finally {
        inFlightSessions.delete(principal.sessionId);
      }
    },
  );
};
