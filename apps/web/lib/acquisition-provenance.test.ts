import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionProvenanceClientError,
  acquisitionProvenanceClient,
} from "./acquisition-provenance";

const response: AcquisitionProvenanceResponse = {
  events: [],
  failures: [],
  generatedAt: "2026-07-27T19:30:00.000Z",
  state: "complete",
  target: { kind: "series", mediaId: 77, seasonNumber: 2, service: "sonarr" },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("acquisition provenance client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests one validated title target and parses the normalized response", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(response),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionProvenanceClient.read({ mediaId: 77, seasonNumber: 2, service: "sonarr" }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/acquisitions/provenance?mediaId=77&service=sonarr&seasonNumber=2",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("distinguishes permission, configuration, and rate-limit failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "permission_denied",
              message: "This action is not permitted.",
              requestId: "error-1",
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "acquisition_not_configured",
              message: "Acquisition history is not configured.",
              requestId: "error-2",
            },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "acquisition_rate_limited",
              message: "Acquisition history is cooling down.",
              requestId: "error-3",
            },
          },
          429,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionProvenanceClient.read({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      acquisitionProvenanceClient.read({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ kind: "not_configured" });
    await expect(
      acquisitionProvenanceClient.read({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("rejects malformed success data and redacts network error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ rawPath: "/private/media" })),
    );
    await expect(
      acquisitionProvenanceClient.read({ mediaId: 42, service: "radarr" }),
    ).rejects.toBeInstanceOf(AcquisitionProvenanceClientError);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network details")));
    let failure: unknown;
    try {
      await acquisitionProvenanceClient.read({ mediaId: 42, service: "radarr" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(failure)).not.toContain("private network details");
  });
});
