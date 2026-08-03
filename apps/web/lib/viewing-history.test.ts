import { afterEach, describe, expect, it, vi } from "vitest";

import { demoViewingHistory } from "./viewing-history-demo";
import {
  ViewingHistoryClientError,
  viewingHistoryClient,
  viewingHistoryOutcomeFromError,
} from "./viewing-history";

afterEach(() => vi.unstubAllGlobals());

describe("viewing history client", () => {
  it("loads a bounded filter-bound page through the same-origin gateway", async () => {
    const fetchMock = vi.fn(async () => Response.json(demoViewingHistory));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      viewingHistoryClient.load({
        cursor: "aGlzdG9yeQ.c2lnbmF0dXJl",
        kind: "episodes",
        limit: 20,
        range: "90_days",
        state: "in_progress",
      }),
    ).resolves.toEqual(demoViewingHistory);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/history?kind=episodes&limit=20&range=90_days&state=in_progress&cursor=aGlzdG9yeQ.c2lnbmF0dXJl",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
    expect(String(fetchMock.mock.calls)).not.toMatch(/jellyfin|externalUserId|api_key/iu);
  });

  it("fails closed on malformed history and classifies access boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...demoViewingHistory, items: [{ upstreamId: "raw" }] })),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ kind: "signed_out" });
    expect(
      viewingHistoryOutcomeFromError(
        new ViewingHistoryClientError("forbidden", "permission_denied", "Restricted"),
      ),
    ).toBe("forbidden");
    expect(viewingHistoryOutcomeFromError(new Error("offline"))).toBe("unavailable");
  });

  it("normalizes HTTP, unreadable, network, and abort failures without leaking responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ kind: "forbidden" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "viewing_history_unavailable",
              message: "Viewing history is temporarily unavailable.",
              requestId: "request-history-1",
            },
          },
          { status: 503 },
        ),
      ),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ code: "viewing_history_unavailable", kind: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502 })),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("private network detail");
      }),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });

    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(
      viewingHistoryClient.load({ kind: "all", limit: 24, range: "30_days", state: "all" }),
    ).rejects.toBe(abort);
  });
});
