import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import {
  acquisitionProvenanceSnapshotEventSchema,
  type AcquisitionProvenanceResponse,
  type AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import { describe, expect, it, vi } from "vitest";

import { AcquisitionProvenanceEventBroker } from "../src/acquisitions/provenance-events.js";

const now = new Date("2026-07-29T13:30:00.000Z");
const movieTarget = { mediaId: 42, service: "radarr" } as const;
const seriesTarget = { mediaId: 77, seasonNumber: 2, service: "sonarr" } as const;

function provenance(target: AcquisitionTargetInput): AcquisitionProvenanceResponse {
  return {
    events: [],
    failures: [],
    generatedAt: now.toISOString(),
    state: "complete",
    target: {
      kind: target.service === "radarr" ? "movie" : "series",
      mediaId: target.mediaId,
      seasonNumber: target.seasonNumber ?? null,
      service: target.service,
    },
  };
}

function principal(sessionId = "provenance-events-session"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-28T13:30:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Acquisition operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-29T14:30:00.000Z",
    issuedAt: now.toISOString(),
    linkedServices: [
      {
        displayName: "Acquisition operator",
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

describe("acquisition provenance event broker", () => {
  it("coalesces readers of one target while keeping different targets isolated", async () => {
    const read = vi.fn(async (target: AcquisitionTargetInput) => provenance(target));
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const seriesEvents: unknown[] = [];
    const broker = new AcquisitionProvenanceEventBroker(
      { read },
      {
        createCursor: () => "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        wait: waitUntilAbort,
      },
    );

    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
      target: movieTarget,
    });
    const second = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => secondEvents.push(event),
      principal: principal("second-session"),
      target: movieTarget,
    });
    const series = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => seriesEvents.push(event),
      principal: principal("series-session"),
      target: seriesTarget,
    });

    await vi.waitFor(() => {
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);
      expect(seriesEvents).toHaveLength(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(acquisitionProvenanceSnapshotEventSchema.parse(firstEvents[0])).toEqual(firstEvents[0]);
    expect(secondEvents).toEqual(firstEvents);
    expect(seriesEvents[0]).toMatchObject({ provenance: { target: { service: "sonarr" } } });

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    if (series.accepted) series.unsubscribe();
    broker.close();
  });

  it("replays a recent target snapshot unless the reconnect presents its exact cursor", async () => {
    const never = new Promise<AcquisitionProvenanceResponse>(() => undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce(provenance(movieTarget))
      .mockImplementation(() => never);
    const firstEvents: { cursor: string }[] = [];
    const replayedEvents: { cursor: string }[] = [];
    const resumedEvents: { cursor: string }[] = [];
    const broker = new AcquisitionProvenanceEventBroker(
      { read },
      {
        createCursor: () => "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        wait: waitUntilAbort,
      },
    );
    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
      target: movieTarget,
    });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    if (first.accepted) first.unsubscribe();

    const resumed = broker.subscribe({
      lastEventId: firstEvents[0]!.cursor,
      onClose: vi.fn(),
      onEvent: (event) => resumedEvents.push(event),
      principal: principal("resumed-session"),
      target: movieTarget,
    });
    await Promise.resolve();
    expect(resumedEvents).toEqual([]);
    if (resumed.accepted) resumed.unsubscribe();

    const replayed = broker.subscribe({
      lastEventId: "provenance_event_ZYXWVUTSRQPONMLKJIHGFE",
      onClose: vi.fn(),
      onEvent: (event) => replayedEvents.push(event),
      principal: principal("replayed-session"),
      target: movieTarget,
    });
    await vi.waitFor(() => expect(replayedEvents).toEqual(firstEvents));

    if (replayed.accepted) replayed.unsubscribe();
    broker.close();
  });

  it("does not replay a target snapshot after the bounded reconnect window", async () => {
    let clock = 1_000;
    const never = new Promise<AcquisitionProvenanceResponse>(() => undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce(provenance(movieTarget))
      .mockImplementation(() => never);
    const firstEvents: { cursor: string }[] = [];
    const laterEvents: { cursor: string }[] = [];
    const broker = new AcquisitionProvenanceEventBroker(
      { read },
      {
        clock: () => clock,
        createCursor: () => "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        replayWindowMs: 30_000,
        wait: waitUntilAbort,
      },
    );
    const first = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => firstEvents.push(event),
      principal: principal("first-session"),
      target: movieTarget,
    });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    if (first.accepted) first.unsubscribe();

    clock += 30_001;
    const later = broker.subscribe({
      onClose: vi.fn(),
      onEvent: (event) => laterEvents.push(event),
      principal: principal("later-session"),
      target: movieTarget,
    });
    await Promise.resolve();
    expect(laterEvents).toEqual([]);

    if (later.accepted) later.unsubscribe();
    broker.close();
  });

  it("enforces per-session and global connection bounds", () => {
    const broker = new AcquisitionProvenanceEventBroker(
      {
        read: vi.fn(() => new Promise<AcquisitionProvenanceResponse>(() => undefined)),
      },
      { maxConnections: 2, maxConnectionsPerSession: 1, wait: waitUntilAbort },
    );
    const subscriber = (sessionId: string, target: AcquisitionTargetInput = movieTarget) =>
      broker.subscribe({
        onClose: vi.fn(),
        onEvent: vi.fn(),
        principal: principal(sessionId),
        target,
      });

    const first = subscriber("first-session");
    expect(subscriber("first-session", seriesTarget)).toEqual({
      accepted: false,
      reason: "session_limit",
    });
    const second = subscriber("second-session", seriesTarget);
    expect(subscriber("third-session")).toEqual({
      accepted: false,
      reason: "global_limit",
    });

    if (first.accepted) first.unsubscribe();
    if (second.accepted) second.unsubscribe();
    broker.close();
  });

  it("closes only the target whose normalized refresh fails", async () => {
    const movieClose = vi.fn();
    const seriesClose = vi.fn();
    const seriesEvents: unknown[] = [];
    const failure = new Error("private upstream failure");
    const onFailure = vi.fn();
    const broker = new AcquisitionProvenanceEventBroker(
      {
        read: vi.fn(async (target: AcquisitionTargetInput) => {
          if (target.service === "radarr") throw failure;
          return provenance(target);
        }),
      },
      { onFailure, wait: waitUntilAbort },
    );

    const movie = broker.subscribe({
      onClose: movieClose,
      onEvent: vi.fn(),
      principal: principal("movie-session"),
      target: movieTarget,
    });
    const series = broker.subscribe({
      onClose: seriesClose,
      onEvent: (event) => seriesEvents.push(event),
      principal: principal("series-session"),
      target: seriesTarget,
    });

    await vi.waitFor(() => expect(movieClose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(seriesEvents).toHaveLength(1));
    expect(seriesClose).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(failure);

    if (movie.accepted) movie.unsubscribe();
    if (series.accepted) series.unsubscribe();
    broker.close();
  });
});
