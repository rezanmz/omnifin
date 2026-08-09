import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import {
  manualReleaseGrabIdempotencyKeySchema,
  manualReleaseGrabInputJsonSchema,
  manualReleaseGrabInputSchema,
  manualReleaseGrabResponseJsonSchema,
  manualReleaseGrabResponseSchema,
  manualReleaseSearchResponseJsonSchema,
  manualReleaseSearchResponseSchema,
  manualReleaseTargetInputJsonSchema,
  manualReleaseTargetInputSchema,
} from "@omnifin/contracts/acquisition";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  ManualReleaseError,
  ManualReleaseService,
  type ManualReleaseDependencies,
} from "./manual-release-service.js";

function readError(error: ManualReleaseError) {
  switch (error.reason) {
    case "connector_unconfigured":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_not_configured",
        message: "Manual release search has not been configured for this service.",
        statusCode: 503,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_identity_required",
        message: "An active operator account is required to search releases.",
        statusCode: 403,
      });
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "storage_failure":
    case "candidate_expired":
    case "configuration_unavailable":
    case "download_unavailable":
    case "idempotency_conflict":
    case "idempotency_in_progress":
    case "outcome_uncertain":
    case "override_required":
    case "rate_limited":
    case "response_invalid":
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_configuration_unavailable",
        message: "Manual release search configuration is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function grabError(error: ManualReleaseError, reply: FastifyReply) {
  switch (error.reason) {
    case "idempotency_conflict":
      return new SafeHttpError({
        cause: error,
        code: "idempotency_key_conflict",
        message: "The idempotency key was already used for a different release grab.",
        statusCode: 409,
      });
    case "idempotency_in_progress":
      reply.header("retry-after", "2");
      return new SafeHttpError({
        cause: error,
        code: "manual_release_grab_outcome_pending",
        message: "The outcome of this release grab is still being determined.",
        statusCode: 409,
      });
    case "outcome_uncertain":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_grab_outcome_uncertain",
        message:
          "The release grab may have been accepted. Verify acquisition history before acting again.",
        statusCode: 409,
      });
    case "candidate_expired":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_candidate_expired",
        message: "This release reference expired. Search again before grabbing it.",
        statusCode: 409,
      });
    case "override_required":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_override_required",
        message: "This rejected release requires explicit override confirmation.",
        statusCode: 409,
      });
    case "download_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_download_unavailable",
        message: "The selected release cannot be sent to a download client.",
        statusCode: 409,
      });
    case "identity_required":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_identity_required",
        message: "An active operator account is required to grab a release.",
        statusCode: 403,
      });
    case "rate_limited":
      reply.header("retry-after", "30");
      return new SafeHttpError({
        cause: error,
        code: "manual_release_rate_limited",
        message: "The acquisition service is cooling down before another grab.",
        statusCode: 429,
      });
    case "response_invalid":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_response_invalid",
        message: "The acquisition service returned an unexpected grab receipt.",
        statusCode: 502,
      });
    case "connector_unconfigured":
    case "connector_ambiguous":
    case "connector_integrity_failure":
    case "configuration_unavailable":
    case "storage_failure":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_configuration_unavailable",
        message: "Manual release grabbing is temporarily unavailable due to configuration.",
        statusCode: 503,
      });
    case "temporarily_unavailable":
      return new SafeHttpError({
        cause: error,
        code: "manual_release_temporarily_unavailable",
        message: "The release could not be safely sent to the download client.",
        statusCode: 503,
      });
  }
}

function upstreamError(error: SafeConnectorError, reply: FastifyReply) {
  if (error.code === "rate_limited") {
    if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
    return new SafeHttpError({
      cause: error,
      code: "manual_release_rate_limited",
      message: "Manual release search is temporarily rate limited.",
      statusCode: 429,
    });
  }
  if (error.code === "response_invalid" || error.code === "unsupported_version") {
    return new SafeHttpError({
      cause: error,
      code: "manual_release_response_invalid",
      message: "The acquisition service returned an unexpected release response.",
      statusCode: 502,
    });
  }
  if (
    error.code === "configuration_invalid" ||
    error.code === "destination_blocked" ||
    error.code === "invalid_credentials"
  ) {
    return new SafeHttpError({
      cause: error,
      code: "manual_release_configuration_unavailable",
      message: "Manual release search configuration is temporarily unavailable.",
      statusCode: 503,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "manual_release_temporarily_unavailable",
    message: "Manual release search is temporarily unavailable.",
    statusCode: 503,
  });
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

export interface ManualReleaseRoutesOptions {
  dependencies?: ManualReleaseDependencies;
}

export const manualReleaseRoutes: FastifyPluginAsync<ManualReleaseRoutesOptions> = async (
  app,
  options,
) => {
  const releases = new ManualReleaseService(app.database, app.appConfig, options.dependencies);

  app.get(
    "/v1/acquisitions/releases",
    {
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
      onSend: noStore,
      schema: {
        querystring: manualReleaseTargetInputJsonSchema,
        response: { 200: manualReleaseSearchResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const session = app.sessionService.resolveAndRefresh(
        request.cookies[sessionCookieName(app.appConfig)],
      );
      if (session?.rotatedSessionToken) {
        writeSessionCookie(
          reply,
          app.appConfig,
          session.rotatedSessionToken,
          session.absoluteExpiresAt,
        );
      }
      const principal = requirePermission(session?.principal, "acquisition.manage");
      try {
        return manualReleaseSearchResponseSchema.parse(
          await releases.search(
            manualReleaseTargetInputSchema.parse(request.query),
            { principal },
            request.operationSignal,
          ),
        );
      } catch (error) {
        if (error instanceof ManualReleaseError) throw readError(error);
        if (error instanceof SafeConnectorError) throw upstreamError(error, reply);
        throw error;
      }
    },
  );

  app.post(
    "/v1/acquisitions/releases/grabs",
    {
      bodyLimit: 2 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: manualReleaseGrabInputJsonSchema,
        response: {
          200: manualReleaseGrabResponseJsonSchema,
          201: manualReleaseGrabResponseJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "acquisition.manage",
      );
      const input = manualReleaseGrabInputSchema.parse(request.body);
      const idempotencyKey = manualReleaseGrabIdempotencyKeySchema.parse(
        request.headers["idempotency-key"],
      );
      try {
        const result = await releases.grab(
          input,
          idempotencyKey,
          { ipAddress: request.ip, principal, requestId: request.id },
          request.operationSignal,
        );
        reply.header("idempotency-replayed", String(result.replayed));
        reply.status(result.replayed ? 200 : 201);
        return manualReleaseGrabResponseSchema.parse(result.grab);
      } catch (error) {
        if (error instanceof ManualReleaseError) throw grabError(error, reply);
        throw error;
      }
    },
  );
};
