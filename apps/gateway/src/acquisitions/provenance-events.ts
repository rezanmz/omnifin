import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  acquisitionProvenanceSnapshotEventSchema,
  acquisitionTargetInputSchema,
  type AcquisitionProvenanceResponse,
  type AcquisitionProvenanceSnapshotEvent,
  type AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import { performance } from "node:perf_hooks";

import { randomToken } from "../security/crypto.js";
import type { AcquisitionProvenanceContext } from "./provenance-service.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_CONNECTIONS_PER_SESSION = 2;
const DEFAULT_MAX_REPLAY_TARGETS = 128;
const DEFAULT_REPLAY_WINDOW_MS = 30_000;

interface AcquisitionProvenanceEventReader {
  read(
    target: AcquisitionTargetInput,
    context: AcquisitionProvenanceContext,
    signal?: AbortSignal,
  ): Promise<AcquisitionProvenanceResponse>;
}

export interface AcquisitionProvenanceEventBrokerDependencies {
  clock?: () => number;
  createCursor?: () => string;
  maxConnections?: number;
  maxConnectionsPerSession?: number;
  maxReplayTargets?: number;
  onFailure?: (error: unknown) => void;
  pollIntervalMs?: number;
  replayWindowMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface AcquisitionProvenanceEventSubscriber {
  lastEventId?: string;
  onClose(): void;
  onEvent(event: AcquisitionProvenanceSnapshotEvent): void;
  principal: SessionPrincipal;
  target: AcquisitionTargetInput;
}

export type AcquisitionProvenanceEventSubscription =
  | { accepted: false; reason: "global_limit" | "session_limit" }
  | { accepted: true; unsubscribe(): void };

interface RetainedSubscriber extends AcquisitionProvenanceEventSubscriber {
  id: number;
  target: AcquisitionTargetInput;
  targetKey: string;
}

interface TargetGroup {
  controller: AbortController | undefined;
  key: string;
  subscribers: Map<number, RetainedSubscriber>;
  target: AcquisitionTargetInput;
}

interface ReplayEntry {
  event: AcquisitionProvenanceSnapshotEvent;
  retainedAt: number;
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

function targetKey(target: AcquisitionTargetInput, principal: SessionPrincipal) {
  const identityKey = principal.userId
    ? `user:${principal.userId}`
    : `session:${principal.sessionId}`;
  return `${identityKey}:${target.service}:${target.mediaId}:${target.seasonNumber ?? "all"}`;
}

function responseMatchesTarget(
  response: AcquisitionProvenanceResponse,
  target: AcquisitionTargetInput,
) {
  return (
    response.target.service === target.service &&
    response.target.mediaId === target.mediaId &&
    response.target.seasonNumber === (target.seasonNumber ?? null)
  );
}

export class AcquisitionProvenanceEventBroker {
  readonly #clock: () => number;
  readonly #createCursor: () => string;
  readonly #groups = new Map<string, TargetGroup>();
  readonly #maxConnections: number;
  readonly #maxConnectionsPerSession: number;
  readonly #maxReplayTargets: number;
  readonly #onFailure: (error: unknown) => void;
  readonly #pollIntervalMs: number;
  readonly #reader: AcquisitionProvenanceEventReader;
  readonly #replay = new Map<string, ReplayEntry>();
  readonly #replayWindowMs: number;
  readonly #subscribers = new Map<number, RetainedSubscriber>();
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #nextSubscriberId = 0;

  public constructor(
    reader: AcquisitionProvenanceEventReader,
    dependencies: AcquisitionProvenanceEventBrokerDependencies = {},
  ) {
    this.#reader = reader;
    this.#clock = dependencies.clock ?? (() => performance.now());
    this.#createCursor = dependencies.createCursor ?? (() => `provenance_event_${randomToken(16)}`);
    this.#maxConnections = boundedPositiveInteger(
      dependencies.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
    );
    this.#maxConnectionsPerSession = boundedPositiveInteger(
      dependencies.maxConnectionsPerSession,
      DEFAULT_MAX_CONNECTIONS_PER_SESSION,
    );
    this.#maxReplayTargets = boundedPositiveInteger(
      dependencies.maxReplayTargets,
      DEFAULT_MAX_REPLAY_TARGETS,
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
  }

  public subscribe(
    subscriber: AcquisitionProvenanceEventSubscriber,
  ): AcquisitionProvenanceEventSubscription {
    if (this.#subscribers.size >= this.#maxConnections) {
      return { accepted: false, reason: "global_limit" };
    }
    const sessionConnections = [...this.#subscribers.values()].filter(
      (candidate) => candidate.principal.sessionId === subscriber.principal.sessionId,
    ).length;
    if (sessionConnections >= this.#maxConnectionsPerSession) {
      return { accepted: false, reason: "session_limit" };
    }

    const target = acquisitionTargetInputSchema.parse(subscriber.target);
    const key = targetKey(target, subscriber.principal);
    const id = ++this.#nextSubscriberId;
    const retained: RetainedSubscriber = { ...subscriber, id, target, targetKey: key };
    const group = this.#groups.get(key) ?? {
      controller: undefined,
      key,
      subscribers: new Map<number, RetainedSubscriber>(),
      target,
    };
    group.subscribers.set(id, retained);
    this.#groups.set(key, group);
    this.#subscribers.set(id, retained);

    this.#pruneReplay();
    const replay = this.#replay.get(key);
    if (replay && subscriber.lastEventId !== replay.event.cursor) {
      queueMicrotask(() => {
        if (this.#subscribers.has(id)) this.#deliver(group, retained, replay.event);
      });
    }
    this.#start(group);

    let active = true;
    return {
      accepted: true,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.#removeSubscriber(group, retained);
      },
    };
  }

  public close() {
    const subscribers = [...this.#subscribers.values()];
    this.#subscribers.clear();
    for (const group of this.#groups.values()) {
      group.subscribers.clear();
      group.controller?.abort();
    }
    this.#groups.clear();
    this.#replay.clear();
    for (const subscriber of subscribers) this.#safeClose(subscriber);
  }

  #broadcast(group: TargetGroup, event: AcquisitionProvenanceSnapshotEvent) {
    for (const subscriber of [...group.subscribers.values()]) {
      this.#deliver(group, subscriber, event);
    }
    this.#stopWhenEmpty(group);
  }

  #deliver(
    group: TargetGroup,
    subscriber: RetainedSubscriber,
    event: AcquisitionProvenanceSnapshotEvent,
  ) {
    try {
      subscriber.onEvent(event);
    } catch {
      this.#removeSubscriber(group, subscriber);
      this.#safeClose(subscriber);
    }
  }

  #fail(group: TargetGroup) {
    const subscribers = [...group.subscribers.values()];
    for (const subscriber of subscribers) this.#subscribers.delete(subscriber.id);
    group.subscribers.clear();
    group.controller?.abort();
    group.controller = undefined;
    if (this.#groups.get(group.key) === group) this.#groups.delete(group.key);
    for (const subscriber of subscribers) this.#safeClose(subscriber);
  }

  async #run(group: TargetGroup, controller: AbortController) {
    try {
      while (!controller.signal.aborted && group.subscribers.size > 0) {
        const principal = group.subscribers.values().next().value?.principal;
        if (!principal) return;
        const provenance = await this.#reader.read(group.target, { principal }, controller.signal);
        if (controller.signal.aborted) return;
        if (!responseMatchesTarget(provenance, group.target)) {
          throw new Error("The normalized acquisition target did not match the subscription.");
        }
        const event = acquisitionProvenanceSnapshotEventSchema.parse({
          cursor: this.#createCursor(),
          kind: "snapshot",
          provenance,
        });
        this.#retainReplay(group.key, event);
        this.#broadcast(group, event);
        if (group.subscribers.size === 0) return;
        await this.#wait(this.#pollIntervalMs, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          this.#onFailure(error);
        } catch {
          // Observability cannot keep a failed target stream open.
        }
        this.#fail(group);
      }
    } finally {
      if (group.controller === controller) group.controller = undefined;
    }
  }

  #pruneReplay() {
    const now = this.#clock();
    for (const [key, entry] of this.#replay) {
      if (now - entry.retainedAt > this.#replayWindowMs) this.#replay.delete(key);
    }
    while (this.#replay.size > this.#maxReplayTargets) {
      const oldest = this.#replay.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#replay.delete(oldest);
    }
  }

  #removeSubscriber(group: TargetGroup, subscriber: RetainedSubscriber) {
    this.#subscribers.delete(subscriber.id);
    group.subscribers.delete(subscriber.id);
    this.#stopWhenEmpty(group);
  }

  #retainReplay(key: string, event: AcquisitionProvenanceSnapshotEvent) {
    this.#replay.delete(key);
    this.#replay.set(key, { event, retainedAt: this.#clock() });
    this.#pruneReplay();
  }

  #safeClose(subscriber: RetainedSubscriber) {
    try {
      subscriber.onClose();
    } catch {
      // A disconnected transport is already closed; no caller detail is retained.
    }
  }

  #start(group: TargetGroup) {
    if (group.controller) return;
    const controller = new AbortController();
    group.controller = controller;
    void this.#run(group, controller);
  }

  #stopWhenEmpty(group: TargetGroup) {
    if (group.subscribers.size > 0) return;
    group.controller?.abort();
    group.controller = undefined;
    if (this.#groups.get(group.key) === group) this.#groups.delete(group.key);
  }
}
