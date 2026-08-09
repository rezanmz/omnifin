import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeDrainCoordinator } from "./drain.js";

interface RequestOperation {
  abort: (reason: DOMException) => void;
  cleanup: () => void;
}

const requestOperations = new WeakMap<FastifyRequest, RequestOperation>();

function abortReason(message: string) {
  return new DOMException(message, "AbortError");
}

function preserveAbortError(reason: unknown, fallbackMessage: string) {
  return reason instanceof DOMException && reason.name === "AbortError"
    ? reason
    : abortReason(fallbackMessage);
}

function installRequestSignal(
  request: FastifyRequest,
  reply: FastifyReply,
  coordinator: RuntimeDrainCoordinator,
) {
  const controller = new AbortController();
  let cleaned = false;

  const onRequestSignal = () =>
    abort(preserveAbortError(request.signal.reason, "The request was aborted."));
  const onRequestAborted = () => abort(abortReason("The request was aborted."));
  const onReplyFinished = () => cleanup();
  const onReplyClosed = () => {
    if (!reply.raw.writableFinished) {
      abort(abortReason("The response was closed before completion."));
      return;
    }
    cleanup();
  };
  const onReplyError = () => abort(abortReason("The response failed before completion."));
  const onDrain = () =>
    abort(preserveAbortError(coordinator.signal.reason, "The gateway is draining."));

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.signal.removeEventListener("abort", onRequestSignal);
    request.raw.off("aborted", onRequestAborted);
    reply.raw.off("finish", onReplyFinished);
    reply.raw.off("close", onReplyClosed);
    reply.raw.off("error", onReplyError);
    coordinator.signal.removeEventListener("abort", onDrain);
    requestOperations.delete(request);
  };

  function abort(reason: DOMException) {
    if (!controller.signal.aborted) controller.abort(reason);
    cleanup();
  }

  const operation = { abort, cleanup };
  requestOperations.set(request, operation);
  request.operationSignal = controller.signal;

  if (request.signal.aborted) {
    onRequestSignal();
    return;
  }
  if (request.raw.aborted) {
    onRequestAborted();
    return;
  }
  if (coordinator.signal.aborted) {
    onDrain();
    return;
  }

  request.signal.addEventListener("abort", onRequestSignal, { once: true });
  request.raw.once("aborted", onRequestAborted);
  reply.raw.once("finish", onReplyFinished);
  reply.raw.once("close", onReplyClosed);
  reply.raw.once("error", onReplyError);
  coordinator.signal.addEventListener("abort", onDrain, { once: true });
}

function abortRequest(request: FastifyRequest, reason: DOMException) {
  requestOperations.get(request)?.abort(reason);
}

function cleanupRequest(request: FastifyRequest) {
  requestOperations.get(request)?.cleanup();
}

/** Adds the single request operation signal used by later route adoption. */
export function installRequestOperationSignal(
  app: FastifyInstance,
  coordinator: RuntimeDrainCoordinator,
) {
  app.decorateRequest("operationSignal");
  app.addHook("onRequest", async (request, reply) => {
    installRequestSignal(request, reply, coordinator);
  });
  app.addHook("onRequestAbort", async (request) => {
    abortRequest(request, abortReason("The request was aborted."));
  });
  app.addHook("onTimeout", async (request) => {
    abortRequest(request, abortReason("The request timed out."));
  });
  app.addHook("onResponse", async (request) => {
    cleanupRequest(request);
  });
}
