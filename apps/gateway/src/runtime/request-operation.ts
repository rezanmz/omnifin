import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeDrainCoordinator } from "./drain.js";

interface RequestOperation {
  abort: (reason: DOMException, source: CancellationSource) => void;
  cleanup: () => void;
}

export type CancellationSource =
  "client_abort" | "response_closed" | "response_error" | "timeout" | "runtime_drain";

const requestOperations = new WeakMap<FastifyRequest, RequestOperation>();

function addCancellationSource(reason: DOMException, source: CancellationSource) {
  if ("cancellationSource" in reason) return reason;
  Object.defineProperty(reason, "cancellationSource", {
    configurable: false,
    enumerable: false,
    value: source,
    writable: false,
  });
  return reason;
}

function abortReason(message: string, source: CancellationSource) {
  return addCancellationSource(new DOMException(message, "AbortError"), source);
}

function preserveAbortError(reason: unknown, fallbackMessage: string, source: CancellationSource) {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return addCancellationSource(reason, source);
  }
  return abortReason(fallbackMessage, source);
}

function installRequestSignal(
  request: FastifyRequest,
  reply: FastifyReply,
  coordinator: RuntimeDrainCoordinator,
) {
  const controller = new AbortController();
  let cleaned = false;

  const onRequestAborted = () =>
    abort(abortReason("The request was aborted.", "client_abort"), "client_abort");
  const onReplyFinished = () => cleanup();
  const onReplyClosed = () => {
    if (!reply.raw.writableFinished) {
      abort(
        abortReason("The response was closed before completion.", "response_closed"),
        "response_closed",
      );
      return;
    }
    cleanup();
  };
  const onReplyError = () =>
    abort(
      abortReason("The response failed before completion.", "response_error"),
      "response_error",
    );
  const onDrain = () =>
    abort(
      preserveAbortError(coordinator.signal.reason, "The gateway is draining.", "runtime_drain"),
      "runtime_drain",
    );

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.raw.off("aborted", onRequestAborted);
    reply.raw.off("finish", onReplyFinished);
    reply.raw.off("close", onReplyClosed);
    reply.raw.off("error", onReplyError);
    coordinator.signal.removeEventListener("abort", onDrain);
    requestOperations.delete(request);
  };

  function abort(reason: DOMException, source: CancellationSource) {
    addCancellationSource(reason, source);
    if (!controller.signal.aborted) controller.abort(reason);
    cleanup();
  }

  const operation = { abort, cleanup };
  requestOperations.set(request, operation);
  request.operationSignal = controller.signal;

  if (request.raw.aborted) {
    onRequestAborted();
    return;
  }
  if (coordinator.signal.aborted) {
    onDrain();
    return;
  }

  request.raw.once("aborted", onRequestAborted);
  reply.raw.once("finish", onReplyFinished);
  reply.raw.once("close", onReplyClosed);
  reply.raw.once("error", onReplyError);
  coordinator.signal.addEventListener("abort", onDrain, { once: true });
}

function abortRequest(request: FastifyRequest, reason: DOMException, source: CancellationSource) {
  requestOperations.get(request)?.abort(reason, source);
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
    abortRequest(request, abortReason("The request was aborted.", "client_abort"), "client_abort");
  });
  app.addHook("onTimeout", async (request) => {
    abortRequest(request, abortReason("The request timed out.", "timeout"), "timeout");
  });
  app.addHook("onResponse", async (request) => {
    cleanupRequest(request);
  });
}
