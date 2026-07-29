import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import {
  downloadQueueSnapshotEventSchema,
  type DownloadQueueResponse,
} from "@omnifin/contracts/downloads";
import { describe, expect, it, vi } from "vitest";

import { DownloadQueueEventBroker } from "../src/downloads/queue-events.js";

const now = new Date("2026-07-29T13:30:00.000Z");
const queue: DownloadQueueResponse = {
  clients: [],
  failures: [],
  generatedAt: now.toISOString(),
  items: [],
  state: "unconfigured",
  summary: {
    attention: 0,
    downloading: 0,
    paused: 0,
    queued: 0,
    remainingBytes: 0,
    total: 0,
    totalRateBytesPerSecond: 0,
  },
  truncated: false,
};

function principal(sessionId = "download-events-session"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-28T13:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Queue operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-29T14:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Queue operator",
        externalUserId: "jellyfin-operator",
        health: "linked",
        id: "jellyfin-operator-link",
        lastVerifiedAt: now.toISOString(),
        linkedAt: now.toISOString(),
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

describe("download queue event broker", () => {
  it("shares one upstream read and emits one strictly normalized snapshot to every subscriber", async () => {
    const read = vi.fn(async () => queue);
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const broker = new DownloadQueueEventBroker(
      { read },
      {
        createCursor: () => "download_event_ABCDEFGHIJKLMNOPQRSTUV",
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

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(1);
    expect(downloadQueueSnapshotEventSchema.parse(firstEvents[0])).toEqual(firstEvents[0]);
    expect(secondEvents).toEqual(firstEvents);

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    broker.close();
  });

  it("does not replay the latest snapshot when a reconnect presents its exact cursor", async () => {
    const firstEvents: { cursor: string }[] = [];
    const resumedEvents: { cursor: string }[] = [];
    const broker = new DownloadQueueEventBroker(
      { read: vi.fn(async () => queue) },
      {
        createCursor: () => "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        wait: waitUntilAbort,
      },
    );
    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
    });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));

    const resumed = broker.subscribe({
      lastEventId: firstEvents[0]!.cursor,
      onClose: vi.fn(),
      onEvent: (event) => resumedEvents.push(event),
      principal: principal("resumed-session"),
    });
    expect(resumed.accepted).toBe(true);
    expect(resumedEvents).toEqual([]);

    if (first.accepted) first.unsubscribe();
    if (resumed.accepted) resumed.unsubscribe();
    broker.close();
  });

  it("does not replay a retained snapshot after the bounded reconnect window", async () => {
    let clock = 1_000;
    const firstEvents: { cursor: string }[] = [];
    const laterEvents: { cursor: string }[] = [];
    const broker = new DownloadQueueEventBroker(
      { read: vi.fn(async () => queue) },
      {
        clock: () => clock,
        createCursor: () => "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        replayWindowMs: 30_000,
        wait: waitUntilAbort,
      },
    );
    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
    });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    if (first.accepted) first.unsubscribe();

    clock += 30_001;
    const later = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => laterEvents.push(event),
      principal: principal("later-session"),
    });
    expect(laterEvents).toEqual([]);

    if (later.accepted) later.unsubscribe();
    broker.close();
  });

  it("enforces per-session and global stream bounds before retaining a subscriber", () => {
    const broker = new DownloadQueueEventBroker(
      { read: vi.fn(() => new Promise<DownloadQueueResponse>(() => undefined)) },
      {
        maxConnections: 2,
        maxConnectionsPerSession: 1,
        wait: waitUntilAbort,
      },
    );
    const subscriber = (sessionId: string) =>
      broker.subscribe({
        onClose: vi.fn(),
        onEvent: vi.fn(),
        principal: principal(sessionId),
      });

    const first = subscriber("first-session");
    expect(subscriber("first-session")).toEqual({
      accepted: false,
      reason: "session_limit",
    });
    const second = subscriber("second-session");
    expect(subscriber("third-session")).toEqual({
      accepted: false,
      reason: "global_limit",
    });

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    broker.close();
  });

  it("closes every stream safely when a shared refresh fails", async () => {
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const onFailure = vi.fn();
    const failure = new Error("private upstream failure");
    const broker = new DownloadQueueEventBroker(
      { read: vi.fn(async () => Promise.reject(failure)) },
      { onFailure, wait: waitUntilAbort },
    );

    const subscription = broker.subscribe({
      onClose,
      onEvent,
      principal: principal(),
    });
    expect(subscription.accepted).toBe(true);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onEvent).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(failure);

    if (subscription.accepted) subscription.unsubscribe();
    broker.close();
  });
});
