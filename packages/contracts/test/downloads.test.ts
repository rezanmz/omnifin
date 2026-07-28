import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_QUEUE_MAX_ITEM_BYTES,
  downloadQueueResponseJsonSchema,
  downloadQueueResponseSchema,
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
  });
});
