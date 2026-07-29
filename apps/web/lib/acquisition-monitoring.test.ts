import type { AcquisitionMonitoringState } from "@omnifin/contracts/acquisition";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionMonitoringClientError,
  acquisitionMonitoringClient,
} from "./acquisition-monitoring";

const csrfToken = "acquisition_monitoring_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const state: AcquisitionMonitoringState = {
  monitored: true,
  target: { kind: "series", mediaId: 77, service: "sonarr" },
  verifiedAt: "2026-07-28T12:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("acquisition monitoring client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads one exact whole-title target with same-origin credentials", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(state),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionMonitoringClient.read({ mediaId: 77, service: "sonarr" }),
    ).resolves.toEqual(state);

    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/acquisitions/monitoring?mediaId=77&service=sonarr");
    expect(request).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("sets only monitoring state with the current CSRF token", async () => {
    const updated = { ...state, monitored: false };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(updated),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionMonitoringClient.update(
        {
          expectedMonitored: true,
          mediaId: 77,
          monitored: false,
          service: "sonarr",
        },
        { csrfToken },
      ),
    ).resolves.toEqual(updated);

    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/acquisitions/monitoring");
    expect(request?.method).toBe("PUT");
    expect(new Headers(request?.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(JSON.parse(String(request?.body))).toEqual({
      expectedMonitored: true,
      mediaId: 77,
      monitored: false,
      service: "sonarr",
    });
  });

  it("rejects malformed success payloads and redacts transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ monitored: true, path: "/private/series" }))
        .mockRejectedValueOnce(new Error("private network detail")),
    );

    await expect(
      acquisitionMonitoringClient.read({ mediaId: 77, service: "sonarr" }),
    ).rejects.toBeInstanceOf(AcquisitionMonitoringClientError);
    await expect(
      acquisitionMonitoringClient.read({ mediaId: 77, service: "sonarr" }),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });
  });

  it.each([
    { code: "session_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "acquisition_monitoring_rate_limited", expected: "rate_limited", status: 429 },
    {
      code: "acquisition_monitoring_response_invalid",
      expected: "invalid_response",
      status: 502,
    },
    {
      code: "acquisition_monitoring_configuration_unavailable",
      expected: "configuration",
      status: 503,
    },
    {
      code: "acquisition_monitoring_temporarily_unavailable",
      expected: "unavailable",
      status: 503,
    },
  ])("maps the bounded gateway failure $code", async ({ code, expected, status }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code, message: "Safe public message.", requestId: "monitoring-error" } },
          status,
        ),
      ),
    );

    await expect(
      acquisitionMonitoringClient.read({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ kind: expected });
  });
});
