import { describe, expect, it } from "vitest";

import { ConnectorHttpLane } from "../src/http/connector-http-lane.js";
import { JellyfinLibraryClient } from "../src/media/jellyfin-library-client.js";
import { JellyfinPlaybackClient } from "../src/media/jellyfin-playback-client.js";
import type { ConnectorTransport } from "../src/types.js";
import { publicResolver } from "./helpers/mock-fetch.js";

describe("Jellyfin connector HTTP lane propagation", () => {
  it("serializes requests from separate high-level consumers", async () => {
    const lane = new ConnectorHttpLane({ maxActive: 1, maxQueued: 1, service: "jellyfin" });
    const started: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport: ConnectorTransport = async (url) => {
      started.push(url.pathname);
      if (started.length === 1) {
        markFirstStarted();
        await firstRelease;
      }
      return new Response(null, { status: 204 });
    };
    const target = {
      baseUrl: "https://jellyfin.example.test/",
      connectorId: "jellyfin-home",
      displayName: "Home Jellyfin",
      lane,
      resolveHost: publicResolver,
      transport,
    };
    const library = new JellyfinLibraryClient({
      accessToken: "token",
      deviceId: "device",
      target,
    });
    const playback = new JellyfinPlaybackClient({
      accessToken: "token",
      deviceId: "device",
      target,
    });

    const first = library.scanLibrary();
    await firstStarted;
    const second = playback.reportPlaybackEvent({
      event: "progress",
      positionSeconds: 1,
      session: {
        audioStreamIndex: null,
        itemId: "item",
        mediaSourceId: "source",
        playMethod: "DirectPlay",
        playSessionId: "session",
        subtitleStreamIndex: null,
      },
    });
    await Promise.resolve();
    expect(started).toEqual(["/Library/Refresh"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["/Library/Refresh", "/Sessions/Playing/Progress"]);
    lane.close();
  });
});
