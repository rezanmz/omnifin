import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackPreferencesResponse,
} from "@omnifin/contracts/playback";
import { afterEach, describe, expect, it, vi } from "vitest";

import { libraryDemoPrincipal } from "./library-care-demo";
import { PlaybackPreferenceClientError, playbackPreferenceClient } from "./playback-preferences";

const response: PlaybackPreferencesResponse = {
  networkClass: "remote",
  preferences: DEFAULT_PLAYBACK_PREFERENCES,
  revision: 0,
  updatedAt: null,
};
const csrfToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

afterEach(() => vi.unstubAllGlobals());

describe("playback preference client", () => {
  it("loads the current private profile through the same-origin proxy", async () => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(playbackPreferenceClient.load()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/playback/preferences",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("saves a revision-checked profile with the active session CSRF proof", async () => {
    const saved = { ...response, revision: 1, updatedAt: "2026-08-03T20:00:00.000Z" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          csrfToken,
          principal: libraryDemoPrincipal,
        }),
      )
      .mockResolvedValueOnce(Response.json(saved));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      playbackPreferenceClient.save({
        expectedRevision: 0,
        preferences: DEFAULT_PLAYBACK_PREFERENCES,
      }),
    ).resolves.toEqual(saved);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/playback/preferences");
    const request = fetchMock.mock.calls[1]?.[1];
    expect(request?.method).toBe("PUT");
    expect(new Headers(request?.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(JSON.parse(String(request?.body))).toEqual({
      expectedRevision: 0,
      preferences: DEFAULT_PLAYBACK_PREFERENCES,
    });
    expect(String(fetchMock.mock.calls)).not.toMatch(/viewer-external|streamIndex/iu);
  });

  it("classifies concurrent edits without retrying or overwriting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          csrfToken,
          principal: libraryDemoPrincipal,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "playback_preferences_conflict",
              message: "Refresh first.",
              requestId: "request-preferences-conflict",
            },
          },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await playbackPreferenceClient
      .save({
        expectedRevision: 2,
        preferences: DEFAULT_PLAYBACK_PREFERENCES,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlaybackPreferenceClientError);
    expect(error).toMatchObject({
      code: "playback_preferences_conflict",
      kind: "conflict",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
