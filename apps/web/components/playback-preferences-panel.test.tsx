import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackPreferencesResponse,
} from "@omnifin/contracts/playback";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PlaybackPreferenceClientError,
  type PlaybackPreferenceClient,
} from "../lib/playback-preferences";
import { PlaybackPreferencesPanel } from "./playback-preferences-panel";

const initialResponse: PlaybackPreferencesResponse = {
  networkClass: "remote",
  preferences: structuredClone(DEFAULT_PLAYBACK_PREFERENCES),
  revision: 3,
  updatedAt: "2026-08-03T20:00:00.000Z",
};

function client(
  save: PlaybackPreferenceClient["save"] = vi.fn(async (request) => ({
    preferences: request.preferences,
    networkClass: "remote" as const,
    revision: 4,
    updatedAt: "2026-08-03T20:15:00.000Z",
  })),
): PlaybackPreferenceClient {
  return { load: vi.fn(async () => initialResponse), save };
}

describe("PlaybackPreferencesPanel", () => {
  it("saves ordered semantic preferences without title-specific stream identifiers", async () => {
    const user = userEvent.setup();
    const save = vi.fn<PlaybackPreferenceClient["save"]>(async (request) => ({
      preferences: request.preferences,
      networkClass: "remote",
      revision: 4,
      updatedAt: "2026-08-03T20:15:00.000Z",
    }));
    render(<PlaybackPreferencesPanel client={client(save)} initialResponse={initialResponse} />);

    expect(screen.getByRole("heading", { name: "Make every play feel familiar." })).toBeVisible();
    await user.type(screen.getByLabelText("Preferred audio languages"), "fa");
    await user.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    await user.selectOptions(screen.getByLabelText("Default subtitle behavior"), "always");
    await user.selectOptions(screen.getByLabelText("Remote maximum"), "4000000");
    await user.click(screen.getByRole("button", { name: "Save playback profile" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const request = save.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      expectedRevision: 3,
      preferences: {
        audio: { languages: ["fa"] },
        quality: { remoteMaxBitrate: 4_000_000 },
        subtitles: { mode: "always" },
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/media|streamIndex|device|ipAddress/iu);
    expect(screen.getByText("Playback profile is up to date")).toBeVisible();
  });

  it("keeps a dirty draft when another session saved first", async () => {
    const user = userEvent.setup();
    const save = vi.fn<PlaybackPreferenceClient["save"]>(async () => {
      throw new PlaybackPreferenceClientError(
        "conflict",
        "playback_preferences_conflict",
        "Refresh first; another session saved a newer profile.",
      );
    });
    render(<PlaybackPreferencesPanel client={client(save)} initialResponse={initialResponse} />);

    await user.click(screen.getByRole("switch", { name: "Prefer original-language audio" }));
    await user.click(screen.getByRole("button", { name: "Save playback profile" }));

    expect(await screen.findByText(/another session saved a newer profile/iu)).toBeVisible();
    expect(screen.getByText("Unsaved playback changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save playback profile" })).toBeEnabled();
  });

  it("offers a bounded retry state when the private profile cannot load", async () => {
    const load = vi
      .fn<PlaybackPreferenceClient["load"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(initialResponse);
    const user = userEvent.setup();
    render(<PlaybackPreferencesPanel client={{ load, save: vi.fn() }} />);

    expect(
      await screen.findByRole("heading", {
        name: "Playback defaults are temporarily out of reach.",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Make every play feel familiar." }),
    ).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
