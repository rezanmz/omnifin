import type {
  DiscoveryMediaDetailResponse,
  DiscoveryMovieResult,
  DiscoveryPersonDetailResponse,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  MediaDetailClientError,
  type DiscoveryMediaDetailClient,
  type DiscoveryPersonDetailClient,
} from "../lib/media-details";
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
      { character: "Neo", name: "Keanu Reeves", personId: 6384 },
      { character: "Morpheus", name: "Laurence Fishburne", personId: 2975 },
    ],
    crew: [
      { name: "Lana Wachowski", personId: 9340, role: "Director" },
      { name: "Lilly Wachowski", personId: 9341, role: "Writer" },
    ],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    intelligence: {
      ratings: [
        {
          audience: "community",
          label: "TMDB",
          scale: 10,
          sentiment: null,
          source: "tmdb",
          value: 8.2,
          voteCount: 27_000,
        },
        {
          audience: "critics",
          label: "Tomatometer",
          scale: 100,
          sentiment: "Certified Fresh",
          source: "rotten_tomatoes",
          value: 83,
          voteCount: null,
        },
      ],
      ratingsState: "ready",
      recommendations: [
        {
          availability: "requested",
          id: "movie:604",
          kind: "movie",
          originalTitle: "The Matrix Reloaded",
          overview: "The signal continues.",
          source: "seerr",
          title: "The Matrix Reloaded",
          tmdbId: 604,
          voteAverage: 7.1,
          year: 2003,
        },
      ],
      recommendationsState: "ready",
      trailers: [
        {
          id: "youtube:m8e-FF8MsqU",
          provider: "youtube",
          resolution: 1080,
          title: "Official trailer",
          type: "trailer",
        },
      ],
    },
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

const recommendedResponse: DiscoveryMediaDetailResponse = {
  ...movieResponse,
  item: {
    ...movieResponse.item,
    availability: "requested",
    cast: [],
    crew: [],
    id: "movie:604",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    originalTitle: "The Matrix Reloaded",
    title: "The Matrix Reloaded",
    tmdbId: 604,
    voteAverage: 7.1,
    year: 2003,
  },
};

const personResponse: DiscoveryPersonDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    biography: "An actor known for exacting genre work.",
    birthday: "1964-09-02",
    birthplace: "Beirut, Lebanon",
    credits: [
      {
        availability: "available",
        kind: "movie",
        role: "Neo",
        title: "The Matrix",
        tmdbId: 603,
        voteAverage: 8.2,
        year: 1999,
      },
    ],
    creditsState: "ready",
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    source: "seerr",
    tmdbId: 6384,
  },
};
const seriesResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "partial",
    cast: [],
    crew: [{ name: "Vince Gilligan", personId: 66633, role: "Creator" }],
    episodeCount: 62,
    genres: ["Drama"],
    id: "series:1396",
    kind: "series",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
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

function personClient(load: DiscoveryPersonDetailClient["load"] = async () => personResponse) {
  return { load } satisfies DiscoveryPersonDetailClient;
}

describe("media detail drawer", () => {
  it("loads and presents bounded editorial detail in a modal sheet", async () => {
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(async () => movieResponse);
    render(<MediaDetailDrawer client={client(load)} media={movie} onOpenChange={vi.fn()} open />);

    expect(await screen.findByRole("heading", { name: "The Matrix" })).toBeVisible();
    expect(screen.getByText("Free your mind.")).toBeVisible();
    expect(screen.getByText("2h 16m")).toBeVisible();
    expect(screen.getAllByText("27K ratings")).toHaveLength(2);
    expect(screen.getByText("Keanu Reeves")).toBeVisible();
    expect(screen.getByText("Lana Wachowski")).toBeVisible();
    expect(screen.getByText("83%")).toBeVisible();
    expect(screen.getByRole("link", { name: /Official trailer/iu })).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=m8e-FF8MsqU",
    );
    expect(screen.getByRole("button", { name: /The Matrix Reloaded/iu })).toBeVisible();
    expect(screen.queryByText(/raw-|jellyfin|serviceUrl/iu)).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(
      { kind: "movie", tmdbId: 603 },
      { language: expect.stringMatching(/^[a-z]{2}(?:-[A-Z]{2})?$/u) },
      expect.any(AbortSignal),
    );
  });

  it("moves between recommendations and person context without closing the drawer", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<DiscoveryMediaDetailClient["load"]>()
      .mockResolvedValueOnce(movieResponse)
      .mockResolvedValueOnce(movieResponse)
      .mockResolvedValueOnce(recommendedResponse);
    const loadPerson = vi.fn<DiscoveryPersonDetailClient["load"]>(async () => personResponse);
    render(
      <MediaDetailDrawer
        client={client(load)}
        media={movie}
        onOpenChange={vi.fn()}
        open
        personClient={personClient(loadPerson)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Keanu Reeves/iu }));
    expect(await screen.findByRole("heading", { name: "Keanu Reeves" })).toBeVisible();
    expect(screen.getByText("An actor known for exacting genre work.")).toBeVisible();
    expect(loadPerson).toHaveBeenCalledWith(
      { tmdbId: 6384 },
      { language: expect.any(String) },
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole("button", { name: /The Matrix.*Neo/iu }));
    expect(await screen.findByRole("heading", { name: "The Matrix" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /The Matrix Reloaded/iu }));
    expect(await screen.findByRole("heading", { name: "The Matrix Reloaded" })).toBeVisible();
    expect(load).toHaveBeenLastCalledWith(
      { kind: "movie", tmdbId: 604 },
      { language: expect.any(String) },
      expect.any(AbortSignal),
    );
  });

  it("keeps explicit degraded intelligence states calm and useful", async () => {
    render(
      <MediaDetailDrawer
        client={client(async () => ({
          ...movieResponse,
          item: {
            ...movieResponse.item,
            intelligence: {
              ratings: [movieResponse.item.intelligence.ratings[0]!],
              ratingsState: "unavailable",
              recommendations: [],
              recommendationsState: "unavailable",
              trailers: [],
            },
          },
        }))}
        media={movie}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(await screen.findByText("Extended sources are temporarily offline")).toBeVisible();
    expect(screen.getByText("Recommendations are temporarily offline")).toBeVisible();
    expect(
      screen.getByText("The current title remains available while this source reconnects."),
    ).toBeVisible();
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
