import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionProvenanceClientError,
  acquisitionProvenanceClient,
  watchAcquisitionProvenanceEvents,
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

  it("accepts a strict target-bound SSE snapshot before reporting live", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    const factory = vi.fn((url: string) => {
      expect(url).toBe(
        "/api/acquisitions/provenance/events?mediaId=77&service=sonarr&seasonNumber=2",
      );
      return source;
    });
    const stop = watchAcquisitionProvenanceEvents(
      { mediaId: 77, seasonNumber: 2, service: "sonarr" },
      { onSnapshot, onStatus },
      factory,
    );
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    expect(onStatus).toHaveBeenCalledWith("connecting");
    source.onopen?.(new Event("open"));
    expect(onStatus).not.toHaveBeenCalledWith("live");
    const event = {
      cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
      kind: "snapshot",
      provenance: response,
    } as const;
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(event),
        lastEventId: event.cursor,
      }),
    );

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(event));
    expect(onStatus).toHaveBeenLastCalledWith("live");
    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the payload cursor or selected target is untrusted", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchAcquisitionProvenanceEvents(
      { mediaId: 77, seasonNumber: 2, service: "sonarr" },
      { onSnapshot, onStatus },
      () => source,
    );
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf("function"));
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
          kind: "snapshot",
          provenance: {
            ...response,
            target: { kind: "series", mediaId: 78, seasonNumber: 2, service: "sonarr" },
          },
        }),
        lastEventId: "provenance_event_ZYXWVUTSRQPONMLKJIHGFE",
      }),
    );

    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce());
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("rejects an oversized event before parsing it", async () => {
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchAcquisitionProvenanceEvents(
      { mediaId: 77, seasonNumber: 2, service: "sonarr" },
      { onSnapshot: vi.fn(), onStatus },
      () => source,
    );
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf("function"));
    source.onmessage?.(
      new MessageEvent("message", {
        data: "x".repeat(384_001),
        lastEventId: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
      }),
    );

    expect(source.close).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("rejects unreadable event JSON and invalid targets before they can update state", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchAcquisitionProvenanceEvents(
      { mediaId: 77, seasonNumber: 2, service: "sonarr" },
      { onSnapshot, onStatus },
      () => source,
    );
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf("function"));
    source.onmessage?.(
      new MessageEvent("message", {
        data: "not-json",
        lastEventId: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
      }),
    );
    expect(source.close).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();

    const invalidFactory = vi.fn(() => source);
    watchAcquisitionProvenanceEvents(
      { mediaId: 42, seasonNumber: 1, service: "radarr" },
      { onSnapshot, onStatus },
      invalidFactory,
    );
    await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("fallback"));
    expect(invalidFactory).not.toHaveBeenCalled();
  });

  it("allows native reconnect after a transient stream error", async () => {
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchAcquisitionProvenanceEvents(
      { mediaId: 77, seasonNumber: 2, service: "sonarr" },
      { onSnapshot: vi.fn(), onStatus },
      () => source,
    );
    await vi.waitFor(() => expect(source.onerror).toBeTypeOf("function"));
    source.onerror?.(new Event("error"));

    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    expect(source.close).not.toHaveBeenCalled();
  });
});
