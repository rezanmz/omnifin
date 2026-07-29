import {
  playbackIssueCreateRequestJsonSchema,
  playbackIssueCreateRequestSchema,
  playbackIssueJsonSchema,
  playbackIssueSchema,
} from "@omnifin/contracts/issues";
import { playbackSessionIdSchema } from "@omnifin/contracts/playback";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { SafeHttpError } from "../http-error.js";
import {
  PlaybackIssueError,
  PlaybackIssueService,
  type PlaybackIssueDependencies,
} from "./issue-service.js";

const paramsSchema = z.strictObject({ sessionId: playbackSessionIdSchema });
const paramsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: { sessionId: { type: "string", pattern: "^playback_[A-Za-z0-9_-]{22}$" } },
} as const;

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function issueError(error: PlaybackIssueError) {
  if (error.reason === "not_found") {
    return new SafeHttpError({
      cause: error,
      code: "playback_session_not_found",
      message: "The playback session is no longer available.",
      statusCode: 404,
    });
  }
  if (error.reason === "limit_reached") {
    return new SafeHttpError({
      cause: error,
      code: "playback_issue_limit_reached",
      message: "Resolve an existing issue before reporting another one.",
      statusCode: 409,
    });
  }
  return new SafeHttpError({
    cause: error,
    code: "playback_issue_unavailable",
    message: "Issue reporting is temporarily unavailable.",
    statusCode: 503,
  });
}

export interface PlaybackIssueRoutesOptions {
  dependencies?: PlaybackIssueDependencies;
}

export const playbackIssueRoutes: FastifyPluginAsync<PlaybackIssueRoutesOptions> = async (
  app,
  options,
) => {
  const issues = new PlaybackIssueService(app.database, app.appConfig, options.dependencies);

  app.post(
    "/v1/playback/:sessionId/issues",
    {
      bodyLimit: 4 * 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: playbackIssueCreateRequestJsonSchema,
        params: paramsJsonSchema,
        response: { 201: playbackIssueJsonSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePermission(
        app.sessionService.resolveValidatedSessionPrincipal(request.validatedSession),
        "playback.use",
      );
      const params = paramsSchema.parse(request.params);
      const input = playbackIssueCreateRequestSchema.parse(request.body);
      try {
        const issue = issues.create(
          { ipAddress: request.ip, principal, requestId: request.id },
          params.sessionId,
          input,
        );
        reply.status(201);
        return playbackIssueSchema.parse(issue);
      } catch (error) {
        if (error instanceof PlaybackIssueError) throw issueError(error);
        throw error;
      }
    },
  );
};
