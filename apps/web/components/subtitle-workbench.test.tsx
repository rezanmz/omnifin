import type { SubtitleSearchResponse } from "@omnifin/contracts/subtitles";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SubtitleClientError,
  type SubtitleClient,
  type SubtitleDownloadCreation,
} from "../lib/subtitles";
import { SubtitleWorkbench } from "./subtitle-workbench";

const csrfToken = "subtitle_workbench_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const mediaReferenceId = `media_${"m".repeat(22)}`;
const searchId = `subtitle_search_${"s".repeat(22)}`;
const englishResultId = `subtitle_result_${"e".repeat(22)}`;
const frenchResultId = `subtitle_result_${"f".repeat(22)}`;

const search: SubtitleSearchResponse = {
  expiresAt: "2026-07-28T12:20:00.000Z",
  generatedAt: "2026-07-28T12:00:00.000Z",
  media: {
    episodeNumber: 3,
    kind: "episode",
    seasonNumber: 2,
    title: "Northern Lights",
    year: 2026,
  },
  results: [
    {
      dontMatches: ["release_group"],
      forced: false,
      hearingImpaired: true,
      id: englishResultId,
      language: "English",
      matches: ["series", "season", "episode"],
      originalFormat: true,
      provider: "OpenSubtitles.com",
      releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
      score: 92.4,
      uploader: "Aurora",
    },
    {
      dontMatches: [],
      forced: true,
      hearingImpaired: false,
      id: frenchResultId,
      language: "French",
      matches: ["series", "episode"],
      originalFormat: false,
      provider: "Addic7ed",
      releaseNames: [],
      score: 84,
      uploader: null,
    },
  ],
  searchId,
};

function client(overrides: Partial<SubtitleClient> = {}) {
  const accepted: SubtitleDownloadCreation = {
    download: {
      acceptedAt: "2026-07-28T12:02:00.000Z",
      resultId: englishResultId,
      searchId,
      status: "accepted",
    },
    replayed: false,
  };
  return {
    download: vi.fn(async () => accepted),
    search: vi.fn(async () => search),
    ...overrides,
  } satisfies SubtitleClient;
}

function renderWorkbench(subtitleClient: SubtitleClient, onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <SubtitleWorkbench
        client={subtitleClient}
        csrfToken={csrfToken}
        mediaReferenceId={mediaReferenceId}
        mediaTitle="Northern Lights"
        onClose={onClose}
      />,
    ),
  };
}

describe("SubtitleWorkbench", () => {
  it("shows exact loading geometry while the provider search is running", () => {
    renderWorkbench(client({ search: () => new Promise(() => undefined) }));

    expect(screen.getByText("Looking for the best match")).toBeVisible();
    expect(
      screen.getByText("Comparing language, release, episode, and format signals."),
    ).toBeVisible();
    expect(screen.getByText("Searching Bazarr for Northern Lights.")).toBeInTheDocument();
  });

  it("presents ranked match evidence and submits an opaque idempotent download", async () => {
    const user = userEvent.setup();
    const subtitleClient = client();
    renderWorkbench(subtitleClient);

    expect(await screen.findByText("Northern Lights · S02E03 · 2026")).toBeVisible();
    expect(screen.getByRole("meter", { name: "English match score" })).toHaveAttribute(
      "aria-valuenow",
      "92",
    );
    expect(screen.getByText("SDH")).toBeVisible();
    expect(screen.getByText("Original")).toBeVisible();
    await user.click(screen.getByText("Match details"));
    expect(screen.getByText("Northern.Lights.S02E03.1080p.WEB-DL")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Add subtitle — English from OpenSubtitles.com",
      }),
    );
    await waitFor(() => expect(subtitleClient.download).toHaveBeenCalledOnce());
    expect(subtitleClient.download).toHaveBeenCalledWith(searchId, englishResultId, {
      csrfToken,
      idempotencyKey: expect.stringMatching(/^subtitle-download-[0-9a-f-]{36}$/u),
    });
    expect(await screen.findByText(/Bazarr accepted this subtitle/u)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Accepted — English from OpenSubtitles.com" }),
    ).toBeDisabled();
  });

  it("renders a deliberate empty result and can search again", async () => {
    const user = userEvent.setup();
    const subtitleClient = client({ search: vi.fn(async () => ({ ...search, results: [] })) });
    renderWorkbench(subtitleClient);

    expect(await screen.findByText("No close matches yet")).toBeVisible();
    expect(screen.getByText(/did not return a candidate/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Search again" }));
    await waitFor(() => expect(subtitleClient.search).toHaveBeenCalledTimes(2));
  });

  it("turns an expired download into a full-search recovery path", async () => {
    const user = userEvent.setup();
    const subtitleClient = client({
      download: vi.fn(async () => {
        throw new SubtitleClientError(
          "expired",
          "subtitle_search_expired",
          "This subtitle search expired. Search again before downloading.",
        );
      }),
    });
    renderWorkbench(subtitleClient);
    await screen.findByText("English");

    await user.click(
      screen.getByRole("button", {
        name: "Add subtitle — English from OpenSubtitles.com",
      }),
    );
    expect(await screen.findByText("Those results have expired")).toBeVisible();
    expect(screen.getByRole("button", { name: "Search again" })).toBeEnabled();
  });

  it("keeps provider failures safe and supports keyboard dismissal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWorkbench(
      client({
        search: vi.fn(async () => {
          throw new SubtitleClientError(
            "configuration",
            "subtitle_configuration_unavailable",
            "Subtitle operations are temporarily unavailable due to configuration.",
          );
        }),
      }),
      onClose,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
