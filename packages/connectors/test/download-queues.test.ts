import { describe, expect, it } from "vitest";

import { QBittorrentAdapter } from "../src/adapters/qbittorrent.js";
import { SabnzbdAdapter } from "../src/adapters/sabnzbd.js";
import type { SafeConnectorError } from "../src/http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../src/types.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

const API_KEY = "fixture-api-key";
const PASSWORD = "fixture-password";

function target(
  service: string,
  transport: NonNullable<ConnectorTargetConfig["transport"]>,
): ConnectorTargetConfig {
  return {
    baseUrl: `https://${service}.example.test/`,
    clock: fixedClock(),
    connectorId: `${service}-main`,
    displayName: `Main ${service}`,
    resolveHost: publicResolver,
    transport,
  };
}

describe("qBittorrent download queue", () => {
  it("authenticates and normalizes active downloads without returning upstream hashes", async () => {
    const mock = createMockTransport([
      new Response("Ok.", { headers: { "set-cookie": "SID=fixture-session; Path=/; HttpOnly" } }),
      jsonResponse([
        {
          added_on: 1_774_648_200,
          amount_left: 256,
          category: "movies",
          dlspeed: 4_096,
          eta: 120,
          hash: "0123456789abcdef0123456789abcdef01234567",
          name: "/private/media/The.Far.Meridian.2160p",
          num_leechs: 2,
          num_seeds: 31,
          progress: 0.75,
          size: 1_024,
          state: "downloading",
        },
        {
          hash: "abcdef0123456789abcdef0123456789abcdef01",
          name: "Completed.Release",
          progress: 1,
          size: 2_048,
          state: "uploading",
        },
      ]),
    ]);
    const adapter = new QBittorrentAdapter({
      ...target("qbittorrent", mock.transport),
      password: PASSWORD,
      username: "operator",
    });

    const result = await adapter.readDownloadQueue();

    expect(result).toEqual({
      generatedAt: "2026-07-25T12:00:00.000Z",
      items: [
        {
          addedAt: "2026-03-27T21:50:00.000Z",
          category: "movies",
          etaSeconds: 120,
          externalId: "0123456789abcdef0123456789abcdef01234567",
          leechers: 2,
          progress: 0.75,
          rateBytesPerSecond: 4_096,
          remainingBytes: 256,
          seeders: 31,
          sizeBytes: 1_024,
          state: "downloading",
          title: "The.Far.Meridian.2160p",
        },
      ],
      truncated: false,
    });
    expect(mock.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v2/auth/login",
      "/api/v2/torrents/info",
    ]);
    expect(mock.requests[1]?.url.searchParams.get("limit")).toBe("201");
    expect(mock.requests[1]?.init.headers.get("cookie")).toBe("SID=fixture-session");
    expect(mock.requests[1]?.init.headers.get("origin")).toBe("https://qbittorrent.example.test");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain("fixture-session");
  });

  it("maps qBittorrent's operational states and unknown ETA sentinel", async () => {
    const states = ["queuedDL", "pausedDL", "checkingDL", "moving", "stalledDL", "error"];
    const mock = createMockTransport([
      new Response("Ok.", { headers: { "set-cookie": "SID=session; Path=/" } }),
      jsonResponse(
        states.map((state, index) => ({
          eta: 8_640_000,
          hash: index.toString(16).padStart(40, "0"),
          name: `Release ${index}`,
          progress: 0.5,
          size: 100,
          state,
        })),
      ),
    ]);
    const adapter = new QBittorrentAdapter({
      ...target("qbittorrent", mock.transport),
      password: PASSWORD,
      username: "operator",
    });

    const result = await adapter.readDownloadQueue();

    expect(result.items.map(({ state }) => state)).toEqual([
      "queued",
      "paused",
      "checking",
      "moving",
      "stalled",
      "failed",
    ]);
    expect(result.items.every(({ etaSeconds }) => etaSeconds === null)).toBe(true);
  });
});

describe("SABnzbd download queue", () => {
  it("uses the full API key and normalizes queue telemetry with bounded rate allocation", async () => {
    const mock = createMockTransport([
      jsonResponse({
        queue: {
          kbpersec: "1024",
          slots: [
            {
              cat: "series",
              filename: "Signal.S01E07.1080p.WEB-DL",
              mb: "1000",
              mbleft: "250",
              nzo_id: "SABnzbd_nzo_fixture-one",
              percentage: "75",
              status: "Downloading",
              timeleft: "00:04:00",
            },
            {
              cat: "movies",
              filename: "The.Far.Meridian.2160p",
              mb: "2000",
              mbleft: "1000",
              nzo_id: "SABnzbd_nzo_fixture-two",
              percentage: "50",
              status: "Paused",
              timeleft: "00:10:00",
            },
          ],
        },
      }),
    ]);
    const adapter = new SabnzbdAdapter({
      ...target("sabnzbd", mock.transport),
      apiKey: API_KEY,
    });

    const result = await adapter.readDownloadQueue();

    expect(result.items).toEqual([
      expect.objectContaining({
        category: "series",
        etaSeconds: 240,
        externalId: "SABnzbd_nzo_fixture-one",
        progress: 0.75,
        rateBytesPerSecond: 1_048_576,
        remainingBytes: 262_144_000,
        sizeBytes: 1_048_576_000,
        state: "downloading",
      }),
      expect.objectContaining({
        etaSeconds: 600,
        progress: 0.5,
        rateBytesPerSecond: 0,
        state: "paused",
      }),
    ]);
    expect(mock.requests[0]?.url.searchParams.get("mode")).toBe("queue");
    expect(mock.requests[0]?.url.searchParams.get("apikey")).toBe(API_KEY);
    expect(mock.requests[0]?.url.searchParams.get("limit")).toBe("201");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("fails closed when queue-capable credentials are not configured", async () => {
    const mock = createMockTransport([]);
    const adapter = new SabnzbdAdapter(target("sabnzbd", mock.transport));

    await expect(adapter.readDownloadQueue()).rejects.toMatchObject({
      code: "configuration_invalid",
      operation: "download.queue",
    } satisfies Partial<SafeConnectorError>);
    expect(adapter.capabilities).not.toContain("download.queue.read");
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects schema drift without reflecting an upstream payload", async () => {
    const privatePayload = "private-upstream-queue-value";
    const mock = createMockTransport([jsonResponse({ queue: { slots: [{ privatePayload }] } })]);
    const adapter = new SabnzbdAdapter({
      ...target("sabnzbd", mock.transport),
      apiKey: API_KEY,
    });

    const error = await adapter.readDownloadQueue().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "response_invalid", operation: "download.queue" });
    expect(JSON.stringify(error)).not.toContain(privatePayload);
  });
});
