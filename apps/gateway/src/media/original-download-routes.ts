import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  libraryDownloadGrantIdSchema,
  libraryDownloadPrepareRequestJsonSchema,
  libraryDownloadPrepareRequestSchema,
  libraryDownloadPrepareResponseJsonSchema,
  libraryDownloadPrepareResponseSchema,
} from "@omnifin/contracts/library";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Readable, Transform } from "node:stream";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import { sessionCookieName, writeSessionCookie } from "../auth/session-cookie.js";
import { SafeHttpError } from "../http-error.js";
import {
  OriginalDownloadError,
  OriginalDownloadService,
  type OriginalDownloadContext,
  type OriginalDownloadDependencies,
  type OriginalDownloadTransfer,
} from "./original-download-service.js";

const prepareParamsSchema = z.strictObject({ referenceId: mediaReferenceIdSchema });
const grantParamsSchema = z.strictObject({ grantId: libraryDownloadGrantIdSchema });
const prepareParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["referenceId"],
  properties: { referenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" } },
} as const;
const grantParamsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["grantId"],
  properties: {
    grantId: { type: "string", pattern: "^media_download_[A-Za-z0-9_-]{22}$" },
  },
} as const;

function context(request: FastifyRequest, reply: FastifyReply): OriginalDownloadContext {
  const validatedPrincipal = request.server.sessionService.resolveValidatedSessionPrincipal(
    request.validatedSession,
  );
  const session = validatedPrincipal
    ? undefined
    : request.server.sessionService.resolveAndRefresh(
        request.cookies[sessionCookieName(request.server.appConfig)],
      );
  if (session?.rotatedSessionToken) {
    writeSessionCookie(
      reply,
      request.server.appConfig,
      session.rotatedSessionToken,
      session.absoluteExpiresAt,
    );
  }
  return {
    ipAddress: request.ip,
    principal: requirePermission(validatedPrincipal ?? session?.principal, "media.download"),
    requestId: request.id,
  };
}

async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  return payload;
}

function mappedError(error: OriginalDownloadError, reply: FastifyReply) {
  switch (error.reason) {
    case "busy":
      reply.header("retry-after", "10");
      return new SafeHttpError({
        cause: error,
        code: "original_download_busy",
        message: "Another original-file download is already active for this account.",
        statusCode: 429,
      });
    case "grant_expired":
      return new SafeHttpError({
        cause: error,
        code: "original_download_expired",
        message: "This download link expired. Prepare a new download and try again.",
        statusCode: 410,
      });
    case "grant_invalid":
      return new SafeHttpError({
        cause: error,
        code: "original_download_not_found",
        message: "This download link is not available to the current session.",
        statusCode: 404,
      });
    case "permission_denied":
      return new SafeHttpError({
        cause: error,
        code: "original_download_permission_denied",
        message: "The current Omnifin or Jellyfin account cannot download this original file.",
        statusCode: 403,
      });
    case "range_invalid":
      if (error.sizeBytes !== null) reply.header("content-range", `bytes */${error.sizeBytes}`);
      return new SafeHttpError({
        cause: error,
        code: "original_download_range_invalid",
        message: "The requested byte range is not available.",
        statusCode: 416,
      });
    case "source_changed":
      return new SafeHttpError({
        cause: error,
        code: "original_download_source_changed",
        message: "The source file changed. Prepare a new download and try again.",
        statusCode: 409,
      });
    case "storage_failure":
    case "unavailable":
      return new SafeHttpError({
        cause: error,
        code: "original_download_unavailable",
        message: "The original file is temporarily unavailable.",
        statusCode: 503,
      });
  }
}

function contentDisposition(filename: string) {
  const fallback =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/gu, "")
      .replace(/["\\]/gu, "")
      .trim() || "Media";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createOriginalDownloadResponseBody(
  transfer: OriginalDownloadTransfer,
  onFinalizeError: () => void,
) {
  let bytesTransferred = 0;
  let completed = false;
  let cancelled = false;
  const finish = (outcome: "cancelled" | "failure" | "success") => {
    if (completed) return;
    completed = true;
    void transfer.finish(outcome, bytesTransferred).catch(onFinalizeError);
  };
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesTransferred += chunk.byteLength;
      callback(null, chunk);
    },
  });
  meter.once("end", () => finish("success"));
  meter.once("error", () => finish(cancelled ? "cancelled" : "failure"));
  meter.once("close", () => {
    if (completed) return;
    cancelled = true;
    source.destroy();
    finish("cancelled");
  });
  const source = Readable.from(
    (async function* () {
      const reader = transfer.body.getReader();
      let sourceEnded = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            sourceEnded = true;
            return;
          }
          yield Buffer.from(chunk.value);
        }
      } finally {
        if (!sourceEnded) {
          try {
            await reader.cancel("The downstream original-file transfer closed.");
          } catch {
            // Finalization below is the stable, redaction-safe record of the cancelled transfer.
          }
        }
        reader.releaseLock();
      }
    })(),
  );
  source.once("error", (error) => meter.destroy(error));
  const body = source.pipe(meter);
  return {
    body,
    cancel() {
      if (completed) return;
      cancelled = true;
      source.destroy();
      meter.destroy();
      finish("cancelled");
    },
  };
}

function sendTransfer(
  transfer: OriginalDownloadTransfer,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const response = createOriginalDownloadResponseBody(transfer, () => {
    request.log.error(
      { operation: "media.original_download.finalize", requestId: request.id },
      "Original download finalization failed",
    );
  });
  const cancel = () => response.cancel();
  const cleanup = () => {
    reply.raw.off("close", cancel);
    request.operationSignal.removeEventListener("abort", cancel);
  };
  reply.raw.once("close", cancel);
  request.operationSignal.addEventListener("abort", cancel, { once: true });
  response.body.once("close", cleanup);
  if (request.operationSignal.aborted) cancel();

  reply.status(transfer.status);
  reply.header("accept-ranges", transfer.acceptRanges ? "bytes" : "none");
  reply.header("cache-control", "private, no-store");
  reply.header("content-disposition", contentDisposition(transfer.filename));
  reply.header("content-type", transfer.contentType ?? "application/octet-stream");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  if (transfer.contentLength !== null) reply.header("content-length", transfer.contentLength);
  if (transfer.contentRange !== null) reply.header("content-range", transfer.contentRange);
  return reply.send(response.body);
}

export interface OriginalDownloadRoutesOptions {
  dependencies?: OriginalDownloadDependencies;
}

export const originalDownloadRoutes: FastifyPluginAsync<OriginalDownloadRoutesOptions> = async (
  app,
  options,
) => {
  const downloads = new OriginalDownloadService(app.database, app.appConfig, options.dependencies);

  app.post(
    "/v1/media/library/:referenceId/downloads",
    {
      bodyLimit: 1_024,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 6, timeWindow: "1 minute" },
      },
      onSend: noStore,
      schema: {
        body: libraryDownloadPrepareRequestJsonSchema,
        params: prepareParamsJsonSchema,
        response: { 201: libraryDownloadPrepareResponseJsonSchema },
      },
    },
    async (request, reply) => {
      const params = prepareParamsSchema.parse(request.params);
      libraryDownloadPrepareRequestSchema.parse(request.body);
      try {
        const prepared = await downloads.prepare(
          params.referenceId,
          context(request, reply),
          request.operationSignal,
        );
        return reply.status(201).send(libraryDownloadPrepareResponseSchema.parse(prepared));
      } catch (error) {
        if (error instanceof OriginalDownloadError) throw mappedError(error, reply);
        throw error;
      }
    },
  );

  app.get(
    "/v1/media/library/downloads/:grantId",
    {
      exposeHeadRoute: false,
      config: {
        omnifinSecurity: { kind: "session" },
        rateLimit: { max: 12, timeWindow: "1 minute" },
      },
      schema: { params: grantParamsJsonSchema },
    },
    async (request, reply) => {
      const params = grantParamsSchema.parse(request.params);
      const rangeHeader = request.headers.range;
      const range = Array.isArray(rangeHeader) ? rangeHeader.join(",") : rangeHeader;
      try {
        const transfer = await downloads.open(
          params.grantId,
          range,
          context(request, reply),
          request.operationSignal,
        );
        return sendTransfer(transfer, request, reply);
      } catch (error) {
        if (error instanceof OriginalDownloadError) throw mappedError(error, reply);
        throw error;
      }
    },
  );
};
