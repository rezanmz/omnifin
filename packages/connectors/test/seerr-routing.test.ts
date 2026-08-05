import type { SafeConnectorError } from "../src/http/safe-http-client.js";
import { describe, expect, it } from "vitest";

import { SeerrAdapter } from "../src/adapters/seerr.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
} from "./helpers/mock-fetch.js";

function adapterWithResponses(responses: Response[], apiKey = "fixture-api-key") {
  const mock = createMockTransport(responses);
  const adapter = new SeerrAdapter({
    apiKey,
    baseUrl: "https://seerr.example.test/",
    clock: fixedClock(),
    connectorId: "seerr-main",
    displayName: "Seerr",
    resolveHost: publicResolver,
    transport: mock.transport,
  });
  return { adapter, requests: mock.requests };
}

const standardServer = {
  activeDirectory: "/srv/media/movies",
  activeProfileId: 4,
  apiKey: "must-not-leave-seerr",
  id: 1,
  is4k: false,
  isDefault: true,
  name: "Cinema",
};

const ultraHdServer = {
  ...standardServer,
  activeDirectory: "/srv/media/movies-uhd",
  id: 2,
  is4k: true,
  isDefault: false,
  name: "Cinema 4K",
};

const standardDetails = {
  languageProfiles: null,
  profiles: [
    { id: 4, name: "1080p" },
    { id: 7, name: "Remux" },
  ],
  rootFolders: [
    {
      freeSpace: 800_000_000_000,
      id: 9,
      path: "/srv/media/movies",
      totalSpace: 2_000_000_000_000,
    },
  ],
  server: standardServer,
  tags: [],
};

describe("Seerr request routing", () => {
  it("loads only matching destinations and keeps upstream credentials out of the catalog", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse([standardServer, ultraHdServer]),
      jsonResponse(standardDetails),
    ]);

    const catalog = await adapter.listRequestRouting("movie", false);

    expect(catalog).toEqual({
      destinations: [
        {
          activeDirectory: "/srv/media/movies",
          activeLanguageProfileId: null,
          activeProfileId: 4,
          id: 1,
          isDefault: true,
          label: "Cinema",
          languageProfiles: [],
          profiles: [
            { id: 4, label: "1080p" },
            { id: 7, label: "Remux" },
          ],
          rootFolders: [
            {
              availableBytes: 800_000_000_000,
              capacityBytes: 2_000_000_000_000,
              path: "/srv/media/movies",
            },
          ],
        },
      ],
      failures: [],
      is4k: false,
      kind: "movie",
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/service/radarr",
      "/api/v1/service/radarr/1",
    ]);
    expect(
      requests.every((request) => request.init.headers.get("x-api-key") === "fixture-api-key"),
    ).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("must-not-leave-seerr");
  });

  it("returns sanitized partial failures when one matching destination is unavailable", async () => {
    const secondary = { ...standardServer, id: 3, isDefault: false, name: "Archive" };
    const { adapter } = adapterWithResponses([
      jsonResponse([standardServer, secondary]),
      jsonResponse(standardDetails),
      jsonResponse({ message: "private service failure" }, { status: 503 }),
    ]);

    const catalog = await adapter.listRequestRouting("movie", false);

    expect(catalog.destinations).toHaveLength(1);
    expect(catalog.failures).toHaveLength(1);
    expect(catalog.failures[0]).toMatchObject({
      code: "upstream_error",
      operation: "request.configure.destination",
      service: "seerr",
    });
    expect(JSON.stringify(catalog)).not.toContain("private service failure");
  });

  it("submits gateway-validated routing fields with the linked user context", async () => {
    const createdMovie = {
      createdAt: "2026-07-27T16:30:00.000Z",
      id: 91,
      is4k: false,
      languageProfileId: null,
      media: { mediaType: "movie", tmdbId: 550 },
      profileId: 4,
      rootFolder: "/srv/media/movies",
      seasons: [],
      serverId: 1,
      status: 2,
      type: "movie",
    };
    const { adapter, requests } = adapterWithResponses([
      jsonResponse(createdMovie, { status: 201 }),
    ]);

    await adapter.createMediaRequest({ is4k: false, kind: "movie", tmdbId: 550 }, 42, undefined, {
      profileId: 4,
      rootFolder: "/srv/media/movies",
      serverId: 1,
    });

    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual({
      is4k: false,
      mediaId: 550,
      mediaType: "movie",
      profileId: 4,
      rootFolder: "/srv/media/movies",
      serverId: 1,
    });
    expect(requests[0]?.init.headers.get("x-api-user")).toBe("42");
  });

  it("rejects an approved request when Seerr drops the selected destination", async () => {
    const { adapter } = adapterWithResponses([
      jsonResponse(
        {
          createdAt: "2026-07-27T16:30:00.000Z",
          id: 91,
          is4k: true,
          media: { mediaType: "movie", tmdbId: 550 },
          profileId: null,
          rootFolder: null,
          seasons: [],
          serverId: null,
          status: 2,
          type: "movie",
        },
        { status: 201 },
      ),
    ]);

    await expect(
      adapter.createMediaRequest({ is4k: true, kind: "movie", tmdbId: 550 }, 42, undefined, {
        profileId: 9,
        rootFolder: "/srv/media/movies-4k",
        serverId: 4,
      }),
    ).rejects.toMatchObject({ reason: "routing_unavailable" });
  });

  it("fails closed without configured credentials", async () => {
    const { adapter, requests } = adapterWithResponses([], "");
    await expect(adapter.listRequestRouting("series", false)).rejects.toMatchObject({
      code: "configuration_invalid",
    } satisfies Partial<SafeConnectorError>);
    expect(requests).toHaveLength(0);
  });
});
