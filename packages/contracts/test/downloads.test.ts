import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_QUEUE_MAX_ITEM_BYTES,
  downloadQueueActionInputJsonSchema,
  downloadQueueActionInputSchema,
  downloadQueueActionResponseJsonSchema,
  downloadQueueActionResponseSchema,
  downloadQueueRemovalInputJsonSchema,
  downloadQueueRemovalInputSchema,
  downloadQueueRemovalResponseJsonSchema,
  downloadQueueRemovalResponseSchema,
  downloadQueuePromotionInputJsonSchema,
  downloadQueuePromotionInputSchema,
  downloadQueuePromotionResponseJsonSchema,
  downloadQueuePromotionResponseSchema,
  downloadQueueResponseJsonSchema,
  downloadQueueResponseSchema,
  downloadQueueSnapshotEventJsonSchema,
  downloadQueueSnapshotEventSchema,
} from "../src/downloads.js";

const failure = {
  code: "timeout" as const,
  message: "SABnzbd did not respond before the deadline.",
  occurredAt: "2026-07-28T02:00:00.000Z",
  operation: "download.queue",
  retryable: true,
  service: "sabnzbd" as const,
};

const torrent = {
  addedAt: "2026-07-28T01:30:00.000Z",
  category: "movies",
  client: "qbittorrent" as const,
  clientName: "Main qBittorrent",
  connectorId: "qbittorrent-main",
  etaSeconds: 480,
  id: "download_ABCDEFGHIJKLMNOPQRSTUV",
  leechers: 3,
  progress: 0.75,
  protocol: "torrent" as const,
  rateBytesPerSecond: 12_000_000,
  remainingBytes: 5_000_000_000,
  seeders: 42,
  sizeBytes: 20_000_000_000,
  state: "downloading" as const,
  title: "The.Far.Meridian.2026.2160p.WEB-DL",
};

const response = {
  clients: [
    {
      connectorId: "qbittorrent-main",
      displayName: "Main qBittorrent",
      failure: null,
      itemCount: 1,
      rateBytesPerSecond: 12_000_000,
      service: "qbittorrent" as const,
      status: "healthy" as const,
    },
    {
      connectorId: "sabnzbd-main",
      displayName: "Main SABnzbd",
      failure,
      itemCount: 0,
      rateBytesPerSecond: 0,
      service: "sabnzbd" as const,
      status: "unavailable" as const,
    },
  ],
  failures: [failure],
  generatedAt: "2026-07-28T02:00:00.000Z",
  items: [torrent],
  state: "degraded" as const,
  summary: {
    attention: 0,
    downloading: 1,
    paused: 0,
    queued: 0,
    remainingBytes: 5_000_000_000,
    total: 1,
    totalRateBytesPerSecond: 12_000_000,
  },
  truncated: false,
};

describe("download queue contracts", () => {
  it("accepts one useful client while preserving another client's safe failure", () => {
    expect(downloadQueueResponseSchema.parse(response)).toEqual(response);
  });

  it("defines a strict resumable snapshot event without upstream identifiers", () => {
    const event = {
      cursor: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
      kind: "snapshot" as const,
      queue: response,
    };

    expect(downloadQueueSnapshotEventSchema.parse(event)).toEqual(event);
    expect(downloadQueueSnapshotEventJsonSchema).not.toHaveProperty("$schema");
    expect(downloadQueueSnapshotEventJsonSchema).toMatchObject({ type: "object" });
    expect(
      downloadQueueSnapshotEventSchema.safeParse({
        ...event,
        cursor: "1",
      }).success,
    ).toBe(false);
    expect(
      downloadQueueSnapshotEventSchema.safeParse({
        ...event,
        nativeQueueId: "must-not-cross-the-browser-boundary",
      }).success,
    ).toBe(false);
  });

  it("preserves intentional punctuation in administrator-defined client names", () => {
    const renamed = {
      ...response,
      clients: response.clients.map((client, index) =>
        index === 0 ? { ...client, displayName: "Downloads / Main" } : client,
      ),
      items: [{ ...torrent, clientName: "Downloads / Main" }],
    };
    expect(downloadQueueResponseSchema.parse(renamed)).toEqual(renamed);
  });

  it("accepts an honest unconfigured queue", () => {
    expect(
      downloadQueueResponseSchema.parse({
        clients: [],
        failures: [],
        generatedAt: response.generatedAt,
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
      }).state,
    ).toBe("unconfigured");
  });

  it.each([
    { items: [{ ...torrent, id: "0123456789abcdef0123456789abcdef01234567" }] },
    { items: [{ ...torrent, title: "/private/media/The.Far.Meridian" }] },
    { items: [{ ...torrent, protocol: "usenet" }] },
    { items: [{ ...torrent, remainingBytes: torrent.sizeBytes + 1 }] },
    {
      items: [
        {
          ...torrent,
          remainingBytes: DOWNLOAD_QUEUE_MAX_ITEM_BYTES + 1,
          sizeBytes: DOWNLOAD_QUEUE_MAX_ITEM_BYTES + 1,
        },
      ],
    },
    { summary: { ...response.summary, totalRateBytesPerSecond: 1 } },
    { state: "complete" },
  ])("rejects inconsistent or upstream-revealing queue data", (change) => {
    expect(downloadQueueResponseSchema.safeParse({ ...response, ...change }).success).toBe(false);
  });

  it("requires items to reference a unique returned connector and identifier", () => {
    expect(
      downloadQueueResponseSchema.safeParse({
        ...response,
        items: [torrent, { ...torrent, connectorId: "missing-client" }],
        summary: {
          ...response.summary,
          downloading: 2,
          remainingBytes: torrent.remainingBytes * 2,
          total: 2,
          totalRateBytesPerSecond: torrent.rateBytesPerSecond * 2,
        },
      }).success,
    ).toBe(false);
  });

  it("exports Fastify-compatible JSON schema without a dialect field", () => {
    expect(downloadQueueResponseJsonSchema).not.toHaveProperty("$schema");
    expect(downloadQueueResponseJsonSchema).toMatchObject({ type: "object" });
    expect(downloadQueueActionInputJsonSchema).not.toHaveProperty("$schema");
    expect(downloadQueueActionResponseJsonSchema).not.toHaveProperty("$schema");
  });

  it("binds pause and resume actions to an exact connector, item, and observed state", () => {
    expect(
      downloadQueueActionInputSchema.parse({
        action: "pause",
        connectorId: torrent.connectorId,
        expectedState: "downloading",
        itemId: torrent.id,
      }),
    ).toEqual({
      action: "pause",
      connectorId: torrent.connectorId,
      expectedState: "downloading",
      itemId: torrent.id,
    });
    expect(
      downloadQueueActionInputSchema.safeParse({
        action: "resume",
        connectorId: torrent.connectorId,
        expectedState: "downloading",
        itemId: torrent.id,
      }).success,
    ).toBe(false);
    expect(
      downloadQueueActionInputSchema.safeParse({
        action: "pause",
        connectorId: torrent.connectorId,
        expectedState: "failed",
        itemId: torrent.id,
      }).success,
    ).toBe(false);
  });

  it("only accepts action responses that verify the requested state", () => {
    const paused = {
      action: "pause" as const,
      item: { ...torrent, rateBytesPerSecond: 0, state: "paused" as const },
      previousState: "downloading" as const,
      replayed: false,
      verifiedAt: response.generatedAt,
    };
    expect(downloadQueueActionResponseSchema.parse(paused)).toEqual(paused);
    expect(
      downloadQueueActionResponseSchema.safeParse({
        ...paused,
        item: torrent,
      }).success,
    ).toBe(false);
    expect(
      downloadQueueActionResponseSchema.safeParse({
        ...paused,
        previousState: "downloading",
        replayed: true,
      }).success,
    ).toBe(false);
    expect(
      downloadQueueActionResponseSchema.safeParse({
        ...paused,
        previousState: "paused",
      }).success,
    ).toBe(false);
    expect(
      downloadQueueActionResponseSchema.safeParse({
        ...paused,
        action: "resume",
        item: torrent,
      }).success,
    ).toBe(false);
  });

  it("binds a content-preserving removal to the exact observed queue item", () => {
    const input = {
      connectorId: torrent.connectorId,
      expectedState: torrent.state,
      itemId: torrent.id,
    };
    const removal = {
      contentDisposition: "preserved" as const,
      item: torrent,
      operationId: "download_removal_ABCDEFGHIJKLMNOPQRSTUV",
      removedAt: response.generatedAt,
      replayed: false,
    };

    expect(downloadQueueRemovalInputSchema.parse(input)).toEqual(input);
    expect(downloadQueueRemovalResponseSchema.parse(removal)).toEqual(removal);
    expect(downloadQueueRemovalInputJsonSchema).not.toHaveProperty("$schema");
    expect(downloadQueueRemovalResponseJsonSchema).not.toHaveProperty("$schema");
  });

  it("binds front-of-queue promotion to the exact observed transfer", () => {
    const input = {
      connectorId: torrent.connectorId,
      expectedState: torrent.state,
      itemId: torrent.id,
    };
    const promotion = {
      item: torrent,
      position: 0 as const,
      previousPosition: 1,
      promotedAt: response.generatedAt,
      replayed: false,
    };

    expect(downloadQueuePromotionInputSchema.parse(input)).toEqual(input);
    expect(downloadQueuePromotionResponseSchema.parse(promotion)).toEqual(promotion);
    expect(downloadQueuePromotionInputJsonSchema).not.toHaveProperty("$schema");
    expect(downloadQueuePromotionResponseJsonSchema).not.toHaveProperty("$schema");
    expect(
      downloadQueuePromotionInputSchema.safeParse({ ...input, expectedState: "completed" }).success,
    ).toBe(false);
    expect(
      downloadQueuePromotionResponseSchema.safeParse({
        ...promotion,
        item: { ...torrent, id: "all" },
      }).success,
    ).toBe(false);
    expect(
      downloadQueuePromotionResponseSchema.safeParse({
        ...promotion,
        previousPosition: 0,
        replayed: false,
      }).success,
    ).toBe(false);
    expect(
      downloadQueuePromotionResponseSchema.safeParse({
        ...promotion,
        previousPosition: 1,
        replayed: true,
      }).success,
    ).toBe(false);
  });
});
