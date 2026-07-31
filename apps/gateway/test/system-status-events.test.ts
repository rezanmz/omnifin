import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import {
  systemStatusSnapshotEventSchema,
  type SystemStatusResponse,
} from "@omnifin/contracts/system";
import { describe, expect, it, vi } from "vitest";

import { SystemStatusEventBroker } from "../src/system/status-events.js";

const now = "2026-07-31T11:00:00.000Z";
const status: SystemStatusResponse = {
  generatedAt: now,
  sources: [],
  state: "unconfigured",
  summary: {
    attentionSources: 0,
    criticalStorage: 0,
    errorSignals: 0,
    healthySources: 0,
    noticeSignals: 0,
    sources: 0,
    unavailableSources: 0,
    warningSignals: 0,
    warningStorage: 0,
  },
};

function principal(sessionId = "system-events-session"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-30T11:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Health operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-31T12:00:00.000Z",
    issuedAt: now,
    linkedServices: [
      {
        displayName: "Health operator",
        externalUserId: "jellyfin-operator",
        health: "linked",
        id: "jellyfin-operator-link",
        lastVerifiedAt: now,
        linkedAt: now,
        service: "jellyfin",
        username: "operator",
      },
    ],
    permissions: ROLE_PERMISSIONS.operator,
    role: "operator",
    sessionId,
    userId: "operator-user",
  });
}

function waitUntilAbort(_milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("system status event broker", () => {
  it("shares one upstream read and emits one strict snapshot to every subscriber", async () => {
    const read = vi.fn(async () => status);
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const broker = new SystemStatusEventBroker(
      { read },
      {
        createCursor: () => "system_event_ABCDEFGHIJKLMNOPQRSTUV",
        wait: waitUntilAbort,
      },
    );

    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
    });
    const second = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => secondEvents.push(event),
      principal: principal("second-session"),
    });

    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(systemStatusSnapshotEventSchema.parse(firstEvents[0])).toEqual(firstEvents[0]);
    expect(secondEvents).toEqual(firstEvents);

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    broker.close();
  });

  it("replays only a recent snapshot that differs from the resume cursor", async () => {
    let clock = 1_000;
    const initial: { cursor: string }[] = [];
    const replayed: { cursor: string }[] = [];
    const duplicate: { cursor: string }[] = [];
    const expired: { cursor: string }[] = [];
    const broker = new SystemStatusEventBroker(
      { read: vi.fn(async () => status) },
      {
        clock: () => clock,
        createCursor: () => "system_event_ABCDEFGHIJKLMNOPQRSTUV",
        replayWindowMs: 30_000,
        wait: waitUntilAbort,
      },
    );
    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => initial.push(event),
      principal: principal("initial-session"),
    });
    await vi.waitFor(() => expect(initial).toHaveLength(1));

    const replay = broker.subscribe({
      lastEventId: "system_event_ZYXWVUTSRQPONMLKJIHGFE",
      onClose: vi.fn(),
      onEvent: (event) => replayed.push(event),
      principal: principal("replay-session"),
    });
    const same = broker.subscribe({
      lastEventId: initial[0]!.cursor,
      onClose: vi.fn(),
      onEvent: (event) => duplicate.push(event),
      principal: principal("duplicate-session"),
    });
    await vi.waitFor(() => expect(replayed).toEqual(initial));
    expect(duplicate).toEqual([]);

    clock += 30_001;
    const late = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => expired.push(event),
      principal: principal("late-session"),
    });
    expect(expired).toEqual([]);

    for (const subscription of [first, replay, same, late]) {
      if (subscription.accepted) subscription.unsubscribe();
    }
    broker.close();
  });

  it("enforces per-session and global connection bounds", () => {
    const broker = new SystemStatusEventBroker(
      { read: vi.fn(() => new Promise<SystemStatusResponse>(() => undefined)) },
      {
        maxConnections: 2,
        maxConnectionsPerSession: 1,
        wait: waitUntilAbort,
      },
    );
    const subscribe = (sessionId: string) =>
      broker.subscribe({
        onClose: vi.fn(),
        onEvent: vi.fn(),
        principal: principal(sessionId),
      });

    const first = subscribe("first-session");
    expect(subscribe("first-session")).toEqual({ accepted: false, reason: "session_limit" });
    const second = subscribe("second-session");
    expect(subscribe("third-session")).toEqual({ accepted: false, reason: "global_limit" });

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    broker.close();
  });

  it("closes every stream safely when the shared refresh fails", async () => {
    const onClose = vi.fn();
    const onFailure = vi.fn();
    const failure = new Error("private upstream failure");
    const broker = new SystemStatusEventBroker(
      { read: vi.fn(async () => Promise.reject(failure)) },
      { onFailure, wait: waitUntilAbort },
    );

    const subscription = broker.subscribe({
      onClose,
      onEvent: vi.fn(),
      principal: principal(),
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(subscription.accepted).toBe(true);
    expect(onFailure).toHaveBeenCalledWith(failure);

    if (subscription.accepted) subscription.unsubscribe();
    broker.close();
  });
});
