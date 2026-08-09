import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewaySseWriter } from "../src/runtime/sse-writer.js";

class FakeRaw extends EventEmitter {
  readonly writes: string[] = [];
  readonly destroy = vi.fn();
  results: boolean[] = [];

  write(frame: string) {
    this.writes.push(frame);
    return this.results.shift() ?? true;
  }
}

function writer(raw: FakeRaw, options: ConstructorParameters<typeof GatewaySseWriter>[1]) {
  return new GatewaySseWriter(raw as unknown as ServerResponse, options);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway SSE writer", () => {
  it("coalesces snapshots and emits only the newest complete frame after drain", () => {
    const raw = new FakeRaw();
    raw.results = [false, true];
    const sse = writer(raw, { onStall: vi.fn() });

    expect(sse.writeSnapshot("A")).toBe(false);
    expect(sse.writeSnapshot("B")).toBe(false);
    expect(sse.writeSnapshot("C")).toBe(false);
    expect(raw.writes).toEqual(["A"]);

    raw.emit("drain");

    expect(raw.writes).toEqual(["A", "C"]);
    sse.close();
  });

  it("suppresses heartbeats while blocked and resets the stall deadline after a blocked drain write", () => {
    vi.useFakeTimers();
    const raw = new FakeRaw();
    raw.results = [false, false];
    const onStall = vi.fn();
    const sse = writer(raw, { onStall, stallTimeoutMs: 10_000 });

    expect(sse.writeSnapshot("A")).toBe(false);
    expect(sse.write(": keep-alive\n\n")).toBe(false);
    expect(sse.writeSnapshot("C")).toBe(false);
    vi.advanceTimersByTime(9_000);
    expect(onStall).not.toHaveBeenCalled();

    raw.emit("drain");
    expect(raw.writes).toEqual(["A", "C"]);
    vi.advanceTimersByTime(9_999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("forces a stalled writer closed and makes cleanup races harmless", () => {
    vi.useFakeTimers();
    const raw = new FakeRaw();
    raw.results = [false];
    raw.on("error", vi.fn());
    const onClose = vi.fn();
    const onStall = vi.fn();
    const sse = writer(raw, { onClose, onStall, stallTimeoutMs: 10_000 });

    sse.writeSnapshot("large-frame");
    vi.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledOnce();
    expect(sse.writeSnapshot("late-frame")).toBe(false);
    expect(raw.writes).toEqual(["large-frame"]);

    sse.close();
    raw.emit("drain");
    raw.emit("close");
    raw.emit("error", new Error("late transport error"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cleans up on a raw transport error and observes a large-frame false return", () => {
    const raw = new FakeRaw();
    raw.results = [false];
    const onClose = vi.fn();
    const sse = writer(raw, { onClose, onStall: vi.fn() });
    const largeFrame = "x".repeat(128_000);

    expect(sse.writeSnapshot(largeFrame)).toBe(false);
    expect(raw.writes).toEqual([largeFrame]);
    raw.emit("error", new Error("socket failed"));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error", true);
    expect(sse.write(": late\n\n")).toBe(false);
  });

  it("reports a blocked runtime-drain close so route cleanup destroys instead of ending", () => {
    const raw = new FakeRaw();
    raw.results = [false];
    const runtimeDrain = new EventEmitter();
    const unsubscribe = vi.fn();
    let closed = false;
    const state: { writer?: GatewaySseWriter } = {};
    const close = () => {
      if (closed) return;
      closed = true;
      const blocked = state.writer?.close() ?? false;
      unsubscribe();
      if (blocked) raw.destroy();
    };
    state.writer = writer(raw, {
      onClose: (_reason, blocked) => (blocked ? close() : undefined),
      onStall: vi.fn(),
    });
    runtimeDrain.once("drain", close);

    expect(state.writer.writeSnapshot("blocked snapshot")).toBe(false);
    runtimeDrain.emit("drain");
    runtimeDrain.emit("drain");

    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(state.writer.close()).toBe(true);
  });
});
