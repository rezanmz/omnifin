import type { SafeConnectorError } from "../src/http/safe-http-client.js";
import { describe, expect, it } from "vitest";

import { SeerrAdapter } from "../src/adapters/seerr.js";
import type { SeerrRequestError } from "../src/adapters/seerr.js";
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

const userList = {
  pageInfo: { page: 1, pageSize: 100, pages: 1, results: 2 },
  results: [
    {
      email: "not-forwarded@example.test",
      id: 18,
      jellyfinUserId: "another-jellyfin-user",
      jellyfinUsername: "another-user",
    },
    {
      email: "viewer@example.test",
      id: 42,
      jellyfinUserId: "jellyfin-user-1",
      jellyfinUsername: "viewer",
    },
  ],
};

const createdMovie = {
  createdAt: "2026-07-27T16:30:00.000Z",
  id: 91,
  is4k: false,
  media: { mediaType: "movie", tmdbId: 550 },
  requestedBy: { email: "viewer@example.test" },
  seasons: [],
  status: 2,
  type: "movie",
};

describe("Seerr media requests", () => {
  it("resolves the exact Jellyfin identity and delegates a minimal movie request", async () => {
    const { adapter, requests } = adapterWithResponses([
      jsonResponse(userList),
      jsonResponse(createdMovie, { status: 201 }),
    ]);

    const userId = await adapter.resolveUser({
      jellyfinUserId: "jellyfin-user-1",
      jellyfinUsername: "viewer",
    });
    const result = await adapter.createMediaRequest(
      { is4k: false, kind: "movie", tmdbId: 550 },
      userId,
    );

    expect(userId).toBe(42);
    expect(result).toEqual({
      createdAt: "2026-07-27T16:30:00.000Z",
      id: "request:91",
      is4k: false,
      kind: "movie",
      seasons: null,
      source: "seerr",
      status: "approved",
      tmdbId: 550,
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/user",
      "/api/v1/request",
    ]);
    expect(requests[0]?.url.searchParams.get("q")).toBe("viewer");
    expect(requests[1]?.init.headers.get("x-api-user")).toBe("42");
    expect(requests[1]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
    expect(JSON.parse(new TextDecoder().decode(requests[1]?.init.body))).toEqual({
      is4k: false,
      mediaId: 550,
      mediaType: "movie",
    });
  });

  it("submits canonical series fields without browser-controlled administration data", async () => {
    const createdSeries = {
      ...createdMovie,
      id: 92,
      is4k: true,
      media: { mediaType: "tv", tmdbId: 1399 },
      seasons: [{ seasonNumber: 3 }, { seasonNumber: 1 }],
      status: 1,
      type: "tv",
    };
    const { adapter, requests } = adapterWithResponses([
      jsonResponse(createdSeries, { status: 201 }),
    ]);

    const result = await adapter.createMediaRequest(
      { is4k: true, kind: "series", seasons: [3, 1], tmdbId: 1399 },
      42,
    );

    expect(result).toMatchObject({
      id: "request:92",
      kind: "series",
      seasons: [1, 3],
      status: "pending",
    });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.init.body))).toEqual({
      is4k: true,
      mediaId: 1399,
      mediaType: "tv",
      seasons: [3, 1],
    });
  });

  it.each([
    { reason: "no_seasons_available", status: 202 },
    { reason: "request_denied", status: 403 },
    { reason: "request_conflict", status: 409 },
  ] as const)("maps status $status to $reason without exposing the response", async (fixture) => {
    const privateMessage = "private upstream response";
    const { adapter } = adapterWithResponses([
      jsonResponse({ message: privateMessage }, { status: fixture.status }),
    ]);

    let failure: unknown;
    try {
      await adapter.createMediaRequest(
        { is4k: false, kind: "series", seasons: "all", tmdbId: 1399 },
        42,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject<Partial<SeerrRequestError>>({ reason: fixture.reason });
    expect(JSON.stringify(failure)).not.toContain(privateMessage);
  });

  it("fails closed when the linked Jellyfin identity is absent or ambiguous", async () => {
    const absent = adapterWithResponses([
      jsonResponse({ ...userList, results: [userList.results[0]] }),
    ]).adapter;
    await expect(
      absent.resolveUser({ jellyfinUserId: "jellyfin-user-1", jellyfinUsername: "viewer" }),
    ).rejects.toMatchObject({ reason: "identity_not_found" });

    const duplicate = adapterWithResponses([
      jsonResponse({ ...userList, results: [userList.results[1], userList.results[1]] }),
    ]).adapter;
    await expect(
      duplicate.resolveUser({ jellyfinUserId: "jellyfin-user-1", jellyfinUsername: "viewer" }),
    ).rejects.toMatchObject({ reason: "identity_ambiguous" });
  });

  it("requires an API key and rejects response drift without leaking raw fields", async () => {
    const unconfigured = adapterWithResponses([], "");
    await expect(
      unconfigured.adapter.resolveUser({
        jellyfinUserId: "jellyfin-user-1",
        jellyfinUsername: "viewer",
      }),
    ).rejects.toMatchObject({
      code: "configuration_invalid",
    } satisfies Partial<SafeConnectorError>);
    expect(unconfigured.requests).toHaveLength(0);

    const privateValue = "private-request-relation";
    const drifted = adapterWithResponses([
      jsonResponse({ payload: privateValue }, { status: 201 }),
    ]).adapter;
    let failure: unknown;
    try {
      await drifted.createMediaRequest({ is4k: false, kind: "movie", tmdbId: 550 }, 42);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "response_invalid" });
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });
});
