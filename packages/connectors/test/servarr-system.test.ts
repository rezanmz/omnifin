import { describe, expect, it } from "vitest";

import { ProwlarrAdapter } from "../src/adapters/prowlarr.js";
import { RadarrAdapter } from "../src/adapters/radarr.js";
import { SonarrAdapter } from "../src/adapters/sonarr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

function radarrWithResponses(responses: Response[]) {
  const mock = createMockTransport(responses);
  return {
    adapter: new RadarrAdapter({
      apiKey: "radarr-sensitive-key",
      baseUrl: "https://radarr.example.test/",
      clock: fixedClock(),
      connectorId: "radarr-main",
      displayName: "Cinema",
      resolveHost: publicResolver,
      transport: mock.transport,
    }),
    requests: mock.requests,
  };
}

describe("Servarr system telemetry", () => {
  it("normalizes Radarr health signals and removes credentials, URLs, and filesystem paths", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          id: 1,
          message: "Everything is operating normally.",
          source: "HealthyCheck",
          type: "ok",
          wikiUrl: "https://wiki.servarr.com/radarr/system",
        },
        {
          id: 2,
          message:
            "Root folder /srv/media/movies is missing; see https://private.example.test/help and radarr-sensitive-key",
          source: "RootFolderCheck",
          type: "warning",
        },
        {
          id: "release",
          message: "A newer release is available.",
          source: "UpdateHealthCheck",
          type: 1,
        },
      ]),
    ]);

    const signals = await adapter.readSystemHealth();

    expect(signals).toEqual([
      {
        externalId: "2:RootFolderCheck",
        message:
          "Root folder configured path is missing; see documentation and configured credential",
        severity: "warning",
        sourceLabel: "Root Folder",
      },
      {
        externalId: "release:UpdateHealthCheck",
        message: "A newer release is available.",
        severity: "notice",
        sourceLabel: "Update",
      },
    ]);
    expect(JSON.stringify(signals)).not.toMatch(/srv|private\.example|sensitive-key|wikiUrl/u);
    expect(requests[0]?.url.pathname).toBe("/api/v3/health");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("radarr-sensitive-key");
  });

  it("reads bounded Radarr storage while keeping upstream paths inside the connector boundary", async () => {
    const { adapter, requests } = radarrWithResponses([
      jsonResponse([
        {
          freeSpace: 80_000_000_000,
          label: "Media pool",
          path: "/srv/media",
          totalSpace: 1_000_000_000_000,
        },
        {
          freeSpace: 500_000_000_000,
          label: null,
          path: "/config",
          totalSpace: 600_000_000_000,
        },
      ]),
    ]);

    await expect(adapter.readStorageCapacity()).resolves.toEqual([
      { externalId: "/config", freeBytes: 500_000_000_000, totalBytes: 600_000_000_000 },
      { externalId: "/srv/media", freeBytes: 80_000_000_000, totalBytes: 1_000_000_000_000 },
    ]);
    expect(requests[0]?.url.pathname).toBe("/api/v3/diskspace");
  });

  it("uses the service-specific health path for Sonarr and Prowlarr", async () => {
    const sonarrMock = createMockTransport([jsonResponse([])]);
    const sonarr = new SonarrAdapter({
      apiKey: "sonarr-key",
      baseUrl: "https://sonarr.example.test/",
      connectorId: "sonarr-main",
      displayName: "Television",
      resolveHost: publicResolver,
      transport: sonarrMock.transport,
    });
    const prowlarrMock = createMockTransport([jsonResponse([])]);
    const prowlarr = new ProwlarrAdapter({
      apiKey: "prowlarr-key",
      baseUrl: "https://prowlarr.example.test/",
      connectorId: "prowlarr-main",
      displayName: "Indexers",
      resolveHost: publicResolver,
      transport: prowlarrMock.transport,
    });

    await expect(sonarr.readSystemHealth()).resolves.toEqual([]);
    await expect(prowlarr.readSystemHealth()).resolves.toEqual([]);
    expect(sonarrMock.requests[0]?.url.pathname).toBe("/api/v3/health");
    expect(prowlarrMock.requests[0]?.url.pathname).toBe("/api/v1/health");
    expect(prowlarr.capabilities).toContain("system.health");
    expect(prowlarr.capabilities).not.toContain("storage.read");
  });

  it("rejects contradictory disk capacity instead of publishing misleading telemetry", async () => {
    const { adapter } = radarrWithResponses([
      jsonResponse([{ freeSpace: 200, path: "/srv/media", totalSpace: 100 }]),
    ]);

    await expect(adapter.readStorageCapacity()).rejects.toMatchObject({
      code: "response_invalid",
      operation: "storage.read",
    });
  });
});
