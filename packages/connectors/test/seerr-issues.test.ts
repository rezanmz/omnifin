import type { SafeConnectorError } from "../src/http/safe-http-client.js";
import { describe, expect, it } from "vitest";

import { SeerrIssueClient, type SeerrIssueError } from "../src/issues/seerr-issue-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

function clientWithResponses(responses: Response[], apiKey = "fixture-api-key") {
  const mock = createMockTransport(responses);
  const client = new SeerrIssueClient({
    apiKey,
    baseUrl: "https://seerr.example.test/",
    connectorId: "seerr-main",
    displayName: "Seerr",
    resolveHost: publicResolver,
    transport: mock.transport,
  });
  return { client, requests: mock.requests };
}

const issue = {
  comments: [
    {
      id: 31,
      message: "Captions drift after the opening scene.",
      user: { email: "private@example.test", jellyfinAuthToken: "private-token" },
    },
  ],
  createdAt: "2026-07-28T11:00:00.000Z",
  createdBy: {
    displayName: "Mara Chen",
    email: "private@example.test",
    jellyfinAuthToken: "private-token",
  },
  id: 19,
  issueType: 3,
  media: { id: 71, mediaType: "tv", tmdbId: 1399 },
  problemEpisode: 3,
  problemSeason: 2,
  status: 1,
  updatedAt: "2026-07-28T11:05:00.000Z",
};

describe("Seerr issue management", () => {
  it("normalizes issue listings and strips private upstream identity fields", async () => {
    const { client, requests } = clientWithResponses([
      jsonResponse({
        pageInfo: { page: 1, pages: 1, pageSize: 20, results: 1 },
        results: [issue],
      }),
      jsonResponse({ firstAirDate: "2011-04-17", name: "Northern Lights" }),
    ]);

    const result = await client.listIssues({ limit: 20, status: "open" });

    expect(result).toEqual({
      items: [
        {
          category: "subtitles",
          createdAt: "2026-07-28T11:00:00.000Z",
          episodeNumber: 3,
          kind: "episode",
          positionSeconds: null,
          reportedBy: "Mara Chen",
          seasonNumber: 2,
          status: "open",
          summary: "Captions drift after the opening scene.",
          title: "Northern Lights",
          updatedAt: "2026-07-28T11:05:00.000Z",
          upstreamId: 19,
          year: 2011,
        },
      ],
      truncated: false,
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual(["/api/v1/issue", "/api/v1/tv/1399"]);
    expect(requests[0]?.url.searchParams.get("filter")).toBe("open");
    expect(requests[0]?.init.headers.get("x-api-key")).toBe("fixture-api-key");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("resolves an issue and verifies the returned identity and state", async () => {
    const resolved = { ...issue, status: 2, updatedAt: "2026-07-28T12:00:00.000Z" };
    const { client, requests } = clientWithResponses([
      jsonResponse(resolved),
      jsonResponse({ firstAirDate: "2011-04-17", name: "Northern Lights" }),
    ]);

    const result = await client.updateIssueStatus(19, { note: null, status: "resolved" });

    expect(result).toMatchObject({ status: "resolved", upstreamId: 19 });
    expect(requests[0]?.url.pathname).toBe("/api/v1/issue/19/resolved");
    expect(requests[0]?.init.method).toBe("POST");
  });

  it.each([
    { reason: "issue_not_found", status: 404 },
    { reason: "issue_conflict", status: 409 },
  ] as const)("maps status $status to $reason without decoding the body", async (fixture) => {
    const privateValue = "private upstream failure";
    const { client } = clientWithResponses([
      jsonResponse({ message: privateValue }, { status: fixture.status }),
    ]);
    let failure: unknown;
    try {
      await client.updateIssueStatus(19, { status: "resolved" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject<Partial<SeerrIssueError>>({ reason: fixture.reason });
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });

  it("falls back to safe presentation when optional metadata cannot be read", async () => {
    const { client } = clientWithResponses([
      jsonResponse({
        pageInfo: { page: 1, pages: 2, pageSize: 1, results: 2 },
        results: [
          {
            ...issue,
            comments: [],
            createdBy: {},
            media: { id: 22, mediaType: "movie", tmdbId: 550 },
          },
        ],
      }),
      jsonResponse({ payload: "schema drift" }),
    ]);

    await expect(client.listIssues({ limit: 1, status: "all" })).resolves.toEqual({
      items: [
        expect.objectContaining({
          kind: "movie",
          reportedBy: "Seerr user",
          summary: null,
          title: "Movie issue",
          year: null,
        }),
      ],
      truncated: true,
    });
  });

  it("requires credentials and rejects response drift without leaking it", async () => {
    expect(
      () =>
        new SeerrIssueClient({
          baseUrl: "https://seerr.example.test/",
          connectorId: "seerr-main",
          displayName: "Seerr",
        }),
    ).toThrow(expect.objectContaining({ code: "configuration_invalid" }));

    const privateValue = "private-issue-payload";
    const { client } = clientWithResponses([
      jsonResponse({
        pageInfo: { page: 1, pages: 1, pageSize: 20, results: 1 },
        results: [{ payload: privateValue }],
      }),
    ]);
    let failure: unknown;
    try {
      await client.listIssues({ limit: 20, status: "open" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject<Partial<SafeConnectorError>>({ code: "response_invalid" });
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });
});
