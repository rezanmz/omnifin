import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  downloadQueueSnapshotEventSchema,
  type DownloadQueueResponse,
  type DownloadQueueSnapshotEvent,
} from "@omnifin/contracts/downloads";
import { performance } from "node:perf_hooks";

import { randomToken } from "../security/crypto.js";
import type { DownloadQueueContext } from "./queue-service.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_CONNECTIONS_PER_SESSION = 2;
const DEFAULT_REPLAY_WINDOW_MS = 30_000;

interface DownloadQueueEventReader {
  read(context: DownloadQueueContext, signal?: AbortSignal): Promise<DownloadQueueResponse>;
}

export interface DownloadQueueEventBrokerDependencies {
  clock?: () => number;
  createCursor?: () => string;
  drainSignal?: AbortSignal;
  maxConnections?: number;
  maxConnectionsPerSession?: number;
  onFailure?: (error: unknown) => void;
  pollIntervalMs?: number;
  replayWindowMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface DownloadQueueEventSubscriber {
  lastEventId?: string;
  onClose(): void;
  onEvent(event: DownloadQueueSnapshotEvent): void;
  principal: SessionPrincipal;
}

export type DownloadQueueEventSubscription =
  | { accepted: false; reason: "closed" | "global_limit" | "session_limit" }
  | { accepted: true; unsubscribe(): void };

interface RetainedSubscriber extends DownloadQueueEventSubscriber {
  id: number;
}

function defaultWait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref();
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function boundedPositiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

export class DownloadQueueEventBroker {
  readonly #clock: () => number;
  readonly #createCursor: () => string;
  readonly #drainSignal: AbortSignal | undefined;
  readonly #maxConnections: number;
  readonly #maxConnectionsPerSession: number;
  readonly #onFailure: (error: unknown) => void;
  readonly #pollIntervalMs: number;
  readonly #reader: DownloadQueueEventReader;
  readonly #replayWindowMs: number;
  readonly #subscribers = new Map<number, RetainedSubscriber>();
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #controller: AbortController | undefined;
  #latest: DownloadQueueSnapshotEvent | undefined;
  #latestAt = 0;
  #nextSubscriberId = 0;
  #closed: boolean;
  readonly #onDrain = () => this.close();

  public constructor(
    reader: DownloadQueueEventReader,
    dependencies: DownloadQueueEventBrokerDependencies = {},
  ) {
    this.#reader = reader;
    this.#clock = dependencies.clock ?? (() => performance.now());
    this.#createCursor = dependencies.createCursor ?? (() => `download_event_${randomToken(16)}`);
    this.#drainSignal = dependencies.drainSignal;
    this.#maxConnections = boundedPositiveInteger(
      dependencies.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
    );
    this.#maxConnectionsPerSession = boundedPositiveInteger(
      dependencies.maxConnectionsPerSession,
      DEFAULT_MAX_CONNECTIONS_PER_SESSION,
    );
    this.#onFailure = dependencies.onFailure ?? (() => undefined);
    this.#pollIntervalMs = boundedPositiveInteger(
      dependencies.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.#replayWindowMs = boundedPositiveInteger(
      dependencies.replayWindowMs,
      DEFAULT_REPLAY_WINDOW_MS,
    );
    this.#wait = dependencies.wait ?? defaultWait;
    this.#closed = this.#drainSignal?.aborted ?? false;
    if (!this.#closed) {
      this.#drainSignal?.addEventListener("abort", this.#onDrain, { once: true });
    }
  }

  public subscribe(subscriber: DownloadQueueEventSubscriber): DownloadQueueEventSubscription {
    if (this.#closed) return { accepted: false, reason: "closed" };
    if (this.#subscribers.size >= this.#maxConnections) {
      return { accepted: false, reason: "global_limit" };
    }
    const sessionConnections = [...this.#subscribers.values()].filter(
      (candidate) => candidate.principal.sessionId === subscriber.principal.sessionId,
    ).length;
    if (sessionConnections >= this.#maxConnectionsPerSession) {
      return { accepted: false, reason: "session_limit" };
    }

    const id = ++this.#nextSubscriberId;
    const retained = { ...subscriber, id };
    this.#subscribers.set(id, retained);
    if (
      this.#latest &&
      this.#clock() - this.#latestAt <= this.#replayWindowMs &&
      subscriber.lastEventId !== this.#latest.cursor
    ) {
      const latest = this.#latest;
      queueMicrotask(() => {
        if (this.#subscribers.has(id)) this.#deliver(retained, latest);
      });
    }
    this.#start();

    let active = true;
    return {
      accepted: true,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.#subscribers.delete(id);
        this.#stopWhenEmpty();
      },
    };
  }

  public close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#drainSignal?.removeEventListener("abort", this.#onDrain);
    const subscribers = [...this.#subscribers.values()];
    this.#subscribers.clear();
    this.#controller?.abort();
    this.#controller = undefined;
    for (const subscriber of subscribers) this.#safeClose(subscriber);
  }

  #broadcast(event: DownloadQueueSnapshotEvent) {
    for (const subscriber of [...this.#subscribers.values()]) {
      this.#deliver(subscriber, event);
    }
    this.#stopWhenEmpty();
  }

  #deliver(subscriber: RetainedSubscriber, event: DownloadQueueSnapshotEvent) {
    try {
      subscriber.onEvent(event);
    } catch {
      this.#subscribers.delete(subscriber.id);
      this.#safeClose(subscriber);
    }
  }

  #fail() {
    const subscribers = [...this.#subscribers.values()];
    this.#subscribers.clear();
    this.#controller?.abort();
    this.#controller = undefined;
    for (const subscriber of subscribers) this.#safeClose(subscriber);
  }

  async #run(controller: AbortController) {
    try {
      while (!controller.signal.aborted && this.#subscribers.size > 0) {
        const principal = this.#subscribers.values().next().value?.principal;
        if (!principal) return;
        const queue = await this.#reader.read({ principal }, controller.signal);
        if (controller.signal.aborted) return;
        const event = downloadQueueSnapshotEventSchema.parse({
          cursor: this.#createCursor(),
          kind: "snapshot",
          queue,
        });
        this.#latest = event;
        this.#latestAt = this.#clock();
        this.#broadcast(event);
        if (this.#subscribers.size === 0) return;
        await this.#wait(this.#pollIntervalMs, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          this.#onFailure(error);
        } catch {
          // Observability cannot keep a failed shared stream open.
        }
        this.#fail();
      }
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  #safeClose(subscriber: RetainedSubscriber) {
    try {
      subscriber.onClose();
    } catch {
      // A disconnected transport is already closed; no caller detail is retained.
    }
  }

  #start() {
    if (this.#closed || this.#drainSignal?.aborted || this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#run(controller);
  }

  #stopWhenEmpty() {
    if (this.#subscribers.size > 0) return;
    this.#controller?.abort();
    this.#controller = undefined;
  }
}
