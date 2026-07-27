import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";

import {
  IndexerIntelligenceClientError,
  indexerIntelligenceClient,
  loadIndexerIntelligence,
} from "./indexer-intelligence";

const session = {
  csrfToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  principal: {
    absoluteExpiresAt: "2026-08-27T19:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Operator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-27T20:00:00.000Z",
    issuedAt: "2026-07-27T19:00:00.000Z",
    linkedServices: [
      {
        displayName: "Operator",
        externalUserId: "operator-external",
        health: "linked",
        id: "operator-link",
        lastVerifiedAt: "2026-07-27T19:00:00.000Z",
        linkedAt: "2026-07-27T19:00:00.000Z",
        service: "jellyfin",
        username: "operator",
      },
    ],
    permissions: [...ROLE_PERMISSIONS.operator],
    role: "operator",
    sessionId: "operator-session",
    userId: "operator-user",
  },
};

const indexers = {
  failures: [],
  generatedAt: "2026-07-27T19:00:00.000Z",
  items: [],
  nextCursor: null,
  periodEndedAt: "2026-07-27T19:00:00.000Z",
  periodStartedAt: "2026-07-26T19:00:00.000Z",
  state: "complete",
  summary: { attention: 0, disabled: 0, enabled: 0, failedQueries: 0, queries: 0, total: 0 },
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("indexer intelligence client", () => {
  it("loads the required indexers and preserves optional section degradation", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => json(session))
      .mockImplementationOnce(() => json(indexers))
      .mockImplementationOnce(() => json({ error: { code: "upstream", message: "offline" } }, 503))
      .mockImplementationOnce(() =>
        json({ generatedAt: "2026-07-27T19:00:00.000Z", items: [], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadIndexerIntelligence();

    expect(result).toMatchObject({
      snapshot: { applications: { status: "unavailable" }, failures: { status: "ready" } },
      status: "ready",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("distinguishes signed-out, forbidden, and unconfigured entry states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({}, 401)),
    );
    await expect(loadIndexerIntelligence()).resolves.toEqual({ status: "signed_out" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          ...session,
          principal: {
            ...session.principal,
            displayName: "Viewer",
            permissions: [...ROLE_PERMISSIONS.viewer],
            role: "viewer",
          },
        }),
      ),
    );
    await expect(loadIndexerIntelligence()).resolves.toEqual({ status: "forbidden" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => json(session))
        .mockImplementationOnce(() =>
          json(
            {
              error: {
                code: "indexer_intelligence_not_configured",
                message: "A Prowlarr connection is required.",
                requestId: "indexer-test-request",
              },
            },
            503,
          ),
        ),
    );
    await expect(loadIndexerIntelligence()).resolves.toEqual({ status: "not_configured" });
  });

  it("sends a no-body test action with same-origin credentials and CSRF proof", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ indexerId: 4, outcome: "passed", testedAt: "2026-07-27T19:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await indexerIntelligenceClient.test(4, "csrf-proof");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/indexers/4/tests",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-omnifin-csrf": "csrf-proof" },
        method: "POST",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("rejects an invalid public response instead of rendering raw data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ secret: "must-not-render" })),
    );
    await expect(indexerIntelligenceClient.loadIndexers("cursor")).rejects.toBeInstanceOf(
      IndexerIntelligenceClientError,
    );
  });
});
