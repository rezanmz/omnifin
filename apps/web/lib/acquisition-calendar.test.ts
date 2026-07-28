import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAcquisitionCalendar } from "./acquisition-calendar-demo";
import {
  AcquisitionCalendarClientError,
  acquisitionCalendarClient,
  acquisitionCalendarOutcomeFromError,
} from "./acquisition-calendar";

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

const range = {
  endAt: demoAcquisitionCalendar.endAt,
  limit: 25,
  startAt: demoAcquisitionCalendar.startAt,
};

afterEach(() => vi.unstubAllGlobals());

describe("acquisition calendar client", () => {
  it("loads one bounded page with same-origin credentials and encoded range parameters", async () => {
    const fetchMock = vi.fn(() => json(demoAcquisitionCalendar));
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquisitionCalendarClient.load(range)).resolves.toEqual(demoAcquisitionCalendar);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requested = new URL(String(url), "https://omnifin.example");
    expect(requested.pathname).toBe("/api/acquisitions/calendar");
    expect(requested.searchParams.get("start")).toBe(range.startAt);
    expect(requested.searchParams.get("end")).toBe(range.endAt);
    expect(requested.searchParams.get("limit")).toBe("25");
    expect(options).toEqual(
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("forwards an opaque cursor without decoding it in the browser", async () => {
    const fetchMock = vi.fn(() => json(demoAcquisitionCalendar));
    vi.stubGlobal("fetch", fetchMock);

    await acquisitionCalendarClient.load({ ...range, cursor: "opaque.payload_signature" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requested = new URL(url, "https://omnifin.example");
    expect(requested.searchParams.get("cursor")).toBe("opaque.payload_signature");
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
  ] as const)("maps HTTP %s to the %s boundary", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({}, status)),
    );

    const error = await acquisitionCalendarClient.load(range).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcquisitionCalendarClientError);
    expect(error).toMatchObject({ kind });
  });

  it("uses a sanitized API error without trusting an invalid success payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json(
          {
            error: {
              code: "acquisition_calendar_configuration_unavailable",
              message: "The acquisition calendar configuration is temporarily unavailable.",
              requestId: "calendar-route-request",
            },
          },
          503,
        ),
      ),
    );
    await expect(acquisitionCalendarClient.load(range)).rejects.toMatchObject({
      code: "acquisition_calendar_configuration_unavailable",
      kind: "unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ privatePath: "/private/media", secret: "must-not-render" })),
    );
    const invalid = await acquisitionCalendarClient.load(range).catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ code: "invalid_response", kind: "invalid_response" });
    expect(JSON.stringify(invalid)).not.toContain("must-not-render");
    expect(JSON.stringify(invalid)).not.toContain("/private/media");
  });

  it("turns network failure into a safe unavailable state and preserves cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("private network details"))),
    );
    const unavailable = await acquisitionCalendarClient
      .load(range)
      .catch((caught: unknown) => caught);
    expect(unavailable).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("private network details");

    const abort = new DOMException("cancelled", "AbortError");
    const fetchMock = vi.fn(() => Promise.reject(abort));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);
    await expect(acquisitionCalendarClient.load(range, controller.signal)).rejects.toBe(abort);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("maps only authorization errors to entry boundaries", () => {
    expect(
      acquisitionCalendarOutcomeFromError(
        new AcquisitionCalendarClientError("forbidden", "denied", "Denied"),
      ),
    ).toBe("forbidden");
    expect(
      acquisitionCalendarOutcomeFromError(
        new AcquisitionCalendarClientError("signed_out", "expired", "Expired"),
      ),
    ).toBe("signed_out");
    expect(acquisitionCalendarOutcomeFromError(new Error("private failure"))).toBe("unavailable");
  });
});
