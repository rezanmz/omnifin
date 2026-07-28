import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDownloadQueue } from "./download-queue-demo";
import { DownloadQueueClientError, downloadQueueClient } from "./download-queue";

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("download queue client", () => {
  it("loads one bounded public queue with same-origin credentials", async () => {
    const fetchMock = vi.fn(() => json(demoDownloadQueue));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadQueueClient.load()).resolves.toEqual(demoDownloadQueue);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
  ] as const)("maps HTTP %s to the %s boundary", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({}, status)),
    );

    const error = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DownloadQueueClientError);
    expect(error).toMatchObject({ kind });
  });

  it("uses a sanitized API error without trusting an invalid success payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json(
          {
            error: {
              code: "download_queue_configuration_unavailable",
              message: "The download queue configuration is temporarily unavailable.",
              requestId: "download-route-request",
            },
          },
          503,
        ),
      ),
    );
    await expect(downloadQueueClient.load()).rejects.toMatchObject({
      code: "download_queue_configuration_unavailable",
      kind: "unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ privatePath: "/private/media", secret: "must-not-render" })),
    );
    const invalid = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ code: "invalid_response", kind: "invalid_response" });
    expect(JSON.stringify(invalid)).not.toContain("must-not-render");
    expect(JSON.stringify(invalid)).not.toContain("/private/media");
  });

  it("turns a network failure into one stable unavailable state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("private network details"))),
    );

    const error = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(error)).not.toContain("private network details");
  });
});
