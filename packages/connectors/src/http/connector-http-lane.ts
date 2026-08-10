import type { ConnectorService } from "@omnifin/contracts/connectors";

import type { ConnectorTransport } from "../types.js";
import { SafeConnectorError } from "./safe-http-client.js";
import {
  createPinnedTransportPool,
  pinnedNodeTransport,
  type PinnedTransportPool,
} from "./pinned-transport.js";

const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_MAX_QUEUED = 32;
const MAX_ACTIVE = 128;
const MAX_QUEUED = 1_024;
const DEFAULT_MAX_AGENT_CACHE = 8;
const MAX_AGENT_CACHE = 64;

export interface ConnectorHttpLaneOptions {
  service: ConnectorService;
  maxActive?: number;
  maxQueued?: number;
  /** Opt in to agents owned by this lane for the default pinned Node transport. */
  keepAlive?: boolean;
  maxSockets?: number;
  maxTotalSockets?: number;
  maxFreeSockets?: number;
  maxAgentCache?: number;
}

export interface ConnectorHttpLaneAcquireOptions {
  operation?: string;
  signal?: AbortSignal;
  /** Applies while waiting in the queue. SafeHttpClient supplies its own absolute deadline. */
  timeoutMs?: number;
}

export interface ConnectorHttpPermit {
  readonly signal: AbortSignal;
  release(): void;
}

interface QueueEntry {
  readonly controller: AbortController;
  readonly operation: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (permit: ConnectorHttpPermit) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: (() => void) | undefined;
}

interface ActiveEntry {
  readonly controller: AbortController;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
  released: boolean;
}

function validBound(
  service: ConnectorService,
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SafeConnectorError({
      service,
      operation: "configuration",
      code: "configuration_invalid",
      message: `The connector HTTP ${name} must be between ${minimum} and ${maximum}.`,
      retryable: false,
    });
  }
  return value;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export class ConnectorHttpLane {
  readonly service: ConnectorService;
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly #transport: ConnectorTransport;
  readonly #pool: PinnedTransportPool | undefined;
  readonly #queue: QueueEntry[] = [];
  readonly #active = new Set<ActiveEntry>();
  #closed = false;

  constructor(options: ConnectorHttpLaneOptions) {
    this.service = options.service;
    this.maxActive = validBound(
      options.service,
      "active request bound",
      options.maxActive ?? DEFAULT_MAX_ACTIVE,
      1,
      MAX_ACTIVE,
    );
    this.maxQueued = validBound(
      options.service,
      "queued request bound",
      options.maxQueued ?? DEFAULT_MAX_QUEUED,
      0,
      MAX_QUEUED,
    );

    const maxSockets = validBound(
      options.service,
      "transport socket bound",
      options.maxSockets ?? 8,
      1,
      128,
    );
    const maxTotalSockets = validBound(
      options.service,
      "total transport socket bound",
      options.maxTotalSockets ?? maxSockets,
      1,
      256,
    );
    const maxFreeSockets = validBound(
      options.service,
      "free transport socket bound",
      options.maxFreeSockets ?? Math.min(4, maxSockets),
      0,
      maxSockets,
    );
    const maxAgentCache = validBound(
      options.service,
      "pinned transport agent cache bound",
      options.maxAgentCache ?? DEFAULT_MAX_AGENT_CACHE,
      1,
      MAX_AGENT_CACHE,
    );
    if (maxTotalSockets < maxSockets) {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "The total transport socket bound cannot be below the per-host bound.",
        retryable: false,
      });
    }

    if (options.keepAlive === true) {
      this.#pool = createPinnedTransportPool({
        maxSockets,
        maxTotalSockets,
        maxFreeSockets,
        maxAgents: maxAgentCache,
      });
      this.#transport = this.#pool.transport;
    } else {
      this.#transport = pinnedNodeTransport;
    }
  }

  /** The lane's default transport. Injected SafeHttpClient transports bypass this value. */
  get transport(): ConnectorTransport {
    return this.#transport;
  }

  acquire(options: ConnectorHttpLaneAcquireOptions = {}): Promise<ConnectorHttpPermit> {
    const operation = options.operation ?? "http.request";
    if (this.#closed) return Promise.reject(this.unreachable(operation));
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
    ) {
      return Promise.reject(
        new SafeConnectorError({
          service: this.service,
          operation,
          code: "configuration_invalid",
          message: "The connector queue timeout must be between 1 ms and 120 seconds.",
          retryable: false,
        }),
      );
    }

    const controller = new AbortController();
    if (this.#active.size < this.maxActive) {
      return Promise.resolve(this.activate(controller, options.signal));
    }
    if (this.#queue.length >= this.maxQueued) {
      return Promise.reject(this.unreachable(operation));
    }

    return new Promise<ConnectorHttpPermit>((resolve, reject) => {
      const entry: QueueEntry = {
        controller,
        operation,
        signal: options.signal,
        resolve,
        reject,
        timer: undefined,
        abort: undefined,
      };
      entry.abort = () => {
        this.removeQueued(entry);
        reject(abortError());
      };
      options.signal?.addEventListener("abort", entry.abort, { once: true });
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.removeQueued(entry);
          reject(
            new SafeConnectorError({
              service: this.service,
              operation,
              code: "timeout",
              message: `${this.service} did not respond before the deadline.`,
              retryable: true,
            }),
          );
        }, options.timeoutMs);
      }
      this.#queue.push(entry);
    });
  }

  async run<T>(
    work: (permit: ConnectorHttpPermit) => Promise<T>,
    options: ConnectorHttpLaneAcquireOptions = {},
  ): Promise<T> {
    const permit = await this.acquire(options);
    try {
      return await work(permit);
    } finally {
      permit.release();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const queued = this.#queue.splice(0);
    for (const entry of queued) {
      this.clearQueueEntry(entry);
      entry.reject(this.unreachable(entry.operation));
    }
    for (const active of [...this.#active]) {
      active.controller.abort();
      this.releaseActive(active);
    }
    this.#pool?.close();
  }

  private activate(
    controller: AbortController,
    signal: AbortSignal | undefined,
  ): ConnectorHttpPermit {
    const abort = signal ? () => controller.abort(signal.reason) : undefined;
    if (signal && abort) signal.addEventListener("abort", abort, { once: true });
    const active: ActiveEntry = { controller, signal, abort, released: false };
    this.#active.add(active);
    return {
      signal: controller.signal,
      release: () => this.releaseActive(active),
    };
  }

  private releaseActive(active: ActiveEntry): void {
    if (active.released) return;
    active.released = true;
    if (active.signal && active.abort) active.signal.removeEventListener("abort", active.abort);
    this.#active.delete(active);
    this.pump();
  }

  private pump(): void {
    while (!this.#closed && this.#active.size < this.maxActive && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (!entry) return;
      this.clearQueueEntry(entry);
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      entry.resolve(this.activate(entry.controller, entry.signal));
    }
  }

  private removeQueued(entry: QueueEntry): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) this.#queue.splice(index, 1);
    this.clearQueueEntry(entry);
  }

  private clearQueueEntry(entry: QueueEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    entry.abort = undefined;
  }

  private unreachable(operation: string): SafeConnectorError {
    return new SafeConnectorError({
      service: this.service,
      operation,
      code: "unreachable",
      message: `${this.service} could not be reached.`,
      retryable: true,
    });
  }
}
