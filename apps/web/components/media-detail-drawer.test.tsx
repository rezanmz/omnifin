import type {
  DiscoveryMediaDetailResponse,
  DiscoveryMovieResult,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MediaDetailClientError, type DiscoveryMediaDetailClient } from "../lib/media-details";
import { MediaDetailDrawer } from "./media-detail-drawer";

const movie: DiscoveryMovieResult = {
  availability: "unavailable",
  id: "movie:603",
  kind: "movie",
  originalTitle: "The Matrix",
  overview: "A hacker discovers the nature of reality.",
  source: "seerr",
  title: "The Matrix",
  tmdbId: 603,
  voteAverage: 8.2,
  year: 1999,
};
const series: DiscoverySeriesResult = {
  availability: "partial",
  id: "series:1396",
  kind: "series",
  originalTitle: "Breaking Bad",
  overview: "A chemistry teacher turns to manufacturing.",
  source: "seerr",
  title: "Breaking Bad",
  tmdbId: 1396,
  voteAverage: 8.9,
  year: 2008,
};
const movieResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "unavailable",
    cast: [
      { character: "Neo", name: "Keanu Reeves" },
      { character: "Morpheus", name: "Laurence Fishburne" },
    ],
    crew: [
      { name: "Lana Wachowski", role: "Director" },
      { name: "Lilly Wachowski", role: "Writer" },
    ],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    originalTitle: "The Matrix",
    overview: "A hacker discovers that the world he knows is a constructed reality.",
    productionStatus: "Released",
    runtimeMinutes: 136,
    source: "seerr",
    tagline: "Free your mind.",
    title: "The Matrix",
    tmdbId: 603,
    voteAverage: 8.2,
    voteCount: 27_000,
    year: 1999,
  },
};
const seriesResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "partial",
    cast: [],
    crew: [{ name: "Vince Gilligan", role: "Creator" }],
    episodeCount: 62,
    genres: ["Drama"],
    id: "series:1396",
    kind: "series",
    originalTitle: "Breaking Bad",
    overview: "A chemistry teacher turns to manufacturing.",
    productionStatus: "Ended",
    runtimeMinutes: 48,
    seasonCount: 5,
    seasons: [
      { episodeCount: 7, number: 0, title: "Specials", year: 2009 },
      { episodeCount: 7, number: 1, title: "Season 1", year: 2008 },
    ],
    source: "seerr",
    tagline: "All bad things must come to an end.",
    title: "Breaking Bad",
    tmdbId: 1396,
    voteAverage: 8.9,
    voteCount: 15_000,
    year: 2008,
  },
};

function client(load: DiscoveryMediaDetailClient["load"] = async () => movieResponse) {
  return { load } satisfies DiscoveryMediaDetailClient;
}

describe("media detail drawer", () => {
  it("loads and presents bounded editorial detail in a modal sheet", async () => {
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(async () => movieResponse);
    render(<MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open />);

    expect(await screen.findByRole("heading", { name: "The Matrix" })).toBeVisible();
    expect(screen.getByText("Free your mind.")).toBeVisible();
    expect(screen.getByText("2h 16m")).toBeVisible();
    expect(screen.getByText("27K ratings")).toBeVisible();
    expect(screen.getByText("Keanu Reeves")).toBeVisible();
    expect(screen.getByText("Lana Wachowski")).toBeVisible();
    expect(screen.queryByText(/raw-|jellyfin|serviceUrl/iu)).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(
      { kind: "movie", tmdbId: 603 },
      { language: expect.stringMatching(/^[a-z]{2}(?:-[A-Z]{2})?$/u) },
      expect.any(AbortSignal),
    );
  });

  it("presents series season summaries without pretending specials are a numbered season", async () => {
    render(
      <MediaDetailDrawer
        client={client(async () => seriesResponse)}
        media={series}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(await screen.findByText("5 seasons · 62 episodes")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Season guide" })).toBeVisible();
    expect(screen.getByText("Specials")).toBeVisible();
    expect(screen.getAllByText(/7 episodes/iu)).toHaveLength(2);
  });

  it("recovers from an offline state without closing the current context", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<DiscoveryMediaDetailClient["load"]>()
      .mockRejectedValueOnce(
        new MediaDetailClientError(
          "unavailable",
          "service_unavailable",
          "Media details are offline.",
        ),
      )
      .mockResolvedValueOnce(movieResponse);
    render(<MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open />);

    expect(
      await screen.findByRole("heading", { name: "Details are temporarily offline" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "The Matrix" })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hands requestable media to the guarded request flow and closes accessibly", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onRequest = vi.fn();
    render(
      <MediaDetailDrawer
        client={client()}
        media={movie}
        onOpenChange={onOpenChange}
        onRequest={onRequest}
        open
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Request The Matrix" }));
    expect(onRequest).toHaveBeenCalledWith(movie);
    await user.click(screen.getByRole("button", { name: "Close media details" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const dialog = screen.getByRole("dialog", { hidden: true });
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("does not load hidden details and aborts an in-flight request when closed", async () => {
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(
      async (_params, _query, signal) =>
        new Promise<DiscoveryMediaDetailResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { rerender } = render(
      <MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open={false} />,
    );
    expect(load).not.toHaveBeenCalled();

    rerender(<MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open />);
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    const signal = load.mock.calls[0]?.[2];
    rerender(
      <MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open={false} />,
    );
    expect(signal?.aborted).toBe(true);
  });
});
