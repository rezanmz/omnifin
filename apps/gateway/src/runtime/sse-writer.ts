import type { ServerResponse } from "node:http";

const DEFAULT_STALL_TIMEOUT_MS = 10_000;

export type GatewaySseWriterCloseReason = "close" | "error";

export interface GatewaySseWriterOptions {
  onClose?: (reason: GatewaySseWriterCloseReason, blocked: boolean) => void;
  onStall: () => void;
  stallTimeoutMs?: number;
}

function boundedStallTimeout(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_STALL_TIMEOUT_MS;
}

/** Serializes SSE writes and coalesces complete snapshots while a response is backpressured. */
export class GatewaySseWriter {
  readonly #onClose: ((reason: GatewaySseWriterCloseReason, blocked: boolean) => void) | undefined;
  readonly #onStall: () => void;
  readonly #raw: ServerResponse;
  readonly #stallTimeoutMs: number;
  #blocked = false;
  #closed = false;
  #closedWhileBlocked = false;
  #pendingSnapshot: string | undefined;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;

  readonly #onDrain = () => this.#flushPendingSnapshot();
  readonly #onRawClose = () => this.#transportClosed("close");
  readonly #onRawError = () => this.#transportClosed("error");

  public constructor(raw: ServerResponse, options: GatewaySseWriterOptions) {
    this.#onClose = options.onClose;
    this.#onStall = options.onStall;
    this.#raw = raw;
    this.#stallTimeoutMs = boundedStallTimeout(options.stallTimeoutMs);
    this.#raw.on("drain", this.#onDrain);
    this.#raw.once("close", this.#onRawClose);
    this.#raw.once("error", this.#onRawError);
  }

  public close(): boolean {
    if (this.#closed) return this.#closedWhileBlocked;
    this.#closedWhileBlocked = this.#blocked;
    this.#closed = true;
    this.#blocked = false;
    this.#pendingSnapshot = undefined;
    if (this.#stallTimer !== undefined) clearTimeout(this.#stallTimer);
    this.#stallTimer = undefined;
    this.#raw.off("drain", this.#onDrain);
    this.#raw.off("close", this.#onRawClose);
    this.#raw.off("error", this.#onRawError);
    return this.#closedWhileBlocked;
  }

  /** Writes a control frame such as the reconnect hint or heartbeat. */
  public write(frame: string): boolean {
    if (this.#closed || this.#blocked) return false;
    return this.#writeRaw(frame);
  }

  /** Writes a snapshot or retains only its newest complete frame while blocked. */
  public writeSnapshot(frame: string): boolean {
    if (this.#closed) return false;
    if (this.#blocked) {
      this.#pendingSnapshot = frame;
      return false;
    }
    return this.#writeRaw(frame);
  }

  #clearStallTimer() {
    if (this.#stallTimer !== undefined) clearTimeout(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  #flushPendingSnapshot() {
    if (this.#closed || !this.#blocked) return;
    this.#blocked = false;
    this.#clearStallTimer();
    const pendingSnapshot = this.#pendingSnapshot;
    this.#pendingSnapshot = undefined;
    if (pendingSnapshot !== undefined) this.#writeRaw(pendingSnapshot);
  }

  #restartStallTimer() {
    this.#clearStallTimer();
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = undefined;
      if (this.#closed || !this.#blocked) return;
      this.close();
      this.#onStall();
    }, this.#stallTimeoutMs);
    this.#stallTimer.unref();
  }

  #transportClosed(reason: GatewaySseWriterCloseReason) {
    if (this.#closed) return;
    const blocked = this.close();
    this.#onClose?.(reason, blocked);
  }

  #writeRaw(frame: string): boolean {
    if (this.#closed) return false;
    let accepted: boolean;
    try {
      accepted = this.#raw.write(frame);
    } catch {
      this.#transportClosed("error");
      return false;
    }
    if (!accepted) {
      this.#blocked = true;
      this.#restartStallTimer();
    }
    return accepted;
  }
}
