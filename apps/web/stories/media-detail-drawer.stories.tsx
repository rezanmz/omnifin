import type {
  DiscoveryMediaDetailResponse,
  DiscoveryMovieResult,
  DiscoveryPersonCreditsResponse,
  DiscoveryPersonDetailResponse,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { MediaDetailDrawer } from "../components/media-detail-drawer";
import {
  MediaDetailClientError,
  type DiscoveryMediaDetailClient,
  type DiscoveryPersonCreditsClient,
  type DiscoveryPersonDetailClient,
} from "../lib/media-details";

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
    artwork: { backdropPath: null, posterPath: null },
    availability: "unavailable",
    cast: [
      { character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null },
      {
        character: "Morpheus",
        name: "Laurence Fishburne",
        personId: 2975,
        profilePath: null,
      },
      { character: "Trinity", name: "Carrie-Anne Moss", personId: 530, profilePath: null },
      {
        character: "Agent Smith",
        name: "Hugo Weaving",
        personId: 1331,
        profilePath: null,
      },
    ],
    crew: [
      { name: "Lana Wachowski", personId: 9340, role: "Director" },
      { name: "Lilly Wachowski", personId: 9341, role: "Writer" },
      { name: "Bill Pope", personId: 13302, role: "Director of Photography" },
      { name: "Don Davis", personId: 1262, role: "Original Music Composer" },
    ],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    intelligence: {
      ratings: [
        {
          audience: "community",
          label: "TMDB",
          providerReference: { identifier: 603, mediaKind: "movie", provider: "tmdb" },
          scale: 10,
          sentiment: null,
          source: "tmdb",
          value: 8.2,
          voteCount: 27_000,
        },
        {
          audience: "community",
          label: "IMDb",
          providerReference: { identifier: "tt0133093", mediaKind: "movie", provider: "imdb" },
          scale: 10,
          sentiment: null,
          source: "imdb",
          value: 8.7,
          voteCount: 2_100_000,
        },
        {
          audience: "critics",
          label: "Tomatometer",
          providerReference: {
            identifier: "the_matrix",
            mediaKind: "movie",
            provider: "rotten_tomatoes",
          },
          scale: 100,
          sentiment: "Certified Fresh",
          source: "rotten_tomatoes",
          value: 83,
          voteCount: null,
        },
        {
          audience: "audience",
          label: "RT audience",
          providerReference: {
            identifier: "the_matrix",
            mediaKind: "movie",
            provider: "rotten_tomatoes",
          },
          scale: 100,
          sentiment: "Upright",
          source: "rotten_tomatoes",
          value: 85,
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
        {
          availability: "available",
          id: "movie:157336",
          kind: "movie",
          originalTitle: "Interstellar",
          overview: "Explorers cross a new frontier.",
          source: "seerr",
          title: "Interstellar",
          tmdbId: 157336,
          voteAverage: 8.5,
          year: 2014,
        },
      ],
      recommendationsState: "ready",
      trailers: [
        {
          id: "youtube:m8e-FF8MsqU",
          provider: "youtube",
          resolution: 1080,
          title: "The Matrix — official trailer",
          type: "trailer",
        },
        {
          id: "youtube:f7MiaSr-0ug",
          provider: "youtube",
          resolution: 1080,
          title: "Behind the simulation",
          type: "behind_the_scenes",
        },
      ],
    },
    originalTitle: "The Matrix",
    overview:
      "A hacker discovers that the world he knows is a constructed reality and joins a rebellion fighting to free humanity from its hidden machinery.",
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

const personResponse: DiscoveryPersonDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    biography:
      "An actor and producer whose work spans independent drama, action cinema, and landmark science fiction.",
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
      {
        availability: "requested",
        kind: "movie",
        role: "John Wick",
        title: "John Wick",
        tmdbId: 245891,
        voteAverage: 7.4,
        year: 2014,
      },
    ],
    creditsState: "ready",
    creditsTotal: 2,
    deathday: null,
    department: "Acting",
    id: "person:6384",
    name: "Keanu Reeves",
    profilePath: null,
    source: "seerr",
    tmdbId: 6384,
  },
};
const paginatedPersonResponse: DiscoveryPersonDetailResponse = {
  ...personResponse,
  item: {
    ...personResponse.item,
    credits: Array.from({ length: 24 }, (_, index) => ({
      availability: index < 8 ? ("available" as const) : ("unavailable" as const),
      kind: index % 3 === 0 ? ("series" as const) : ("movie" as const),
      role: `Role ${index + 1}`,
      title: `Selected work ${index + 1}`,
      tmdbId: 10_000 + index,
      voteAverage: 7.8,
      year: 2000 + index,
    })),
    creditsTotal: 30,
  },
};
const personCreditsResponse: DiscoveryPersonCreditsResponse = {
  generatedAt: "2026-07-28T20:01:00.000Z",
  items: Array.from({ length: 6 }, (_, index) => ({
    availability: "requested",
    kind: "movie",
    role: `Role ${index + 25}`,
    title: `Selected work ${index + 25}`,
    tmdbId: 20_000 + index,
    voteAverage: 7.2,
    year: 2024,
  })),
  page: 2,
  pageSize: 24,
  totalPages: 2,
  totalResults: 30,
};
const seriesResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    artwork: { backdropPath: null, posterPath: null },
    availability: "partial",
    cast: [
      {
        character: "Walter White",
        name: "Bryan Cranston",
        personId: 17419,
        profilePath: null,
      },
      {
        character: "Jesse Pinkman",
        name: "Aaron Paul",
        personId: 84497,
        profilePath: null,
      },
    ],
    crew: [{ name: "Vince Gilligan", personId: 66633, role: "Creator" }],
    episodeCount: 62,
    genres: ["Drama", "Crime"],
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
    overview:
      "A chemistry teacher facing a life-changing diagnosis enters the drug trade to secure his family’s future.",
    productionStatus: "Ended",
    runtimeMinutes: 48,
    seasonCount: 5,
    seasons: [
      { episodeCount: 7, number: 0, title: "Specials", year: 2009 },
      { episodeCount: 7, number: 1, title: "Season 1", year: 2008 },
      { episodeCount: 13, number: 2, title: "Season 2", year: 2009 },
      { episodeCount: 13, number: 3, title: "Season 3", year: 2010 },
      { episodeCount: 13, number: 4, title: "Season 4", year: 2011 },
      { episodeCount: 16, number: 5, title: "Season 5", year: 2012 },
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

function client(
  load: DiscoveryMediaDetailClient["load"],
  loadConnectedActions: DiscoveryMediaDetailClient["loadConnectedActions"] = async () => ({
    actions: [],
    generatedAt: "2026-07-28T20:00:00.000Z",
    kind: "movie",
    tmdbId: 603,
  }),
): DiscoveryMediaDetailClient {
  return { load, loadConnectedActions };
}

function personClient(load: DiscoveryPersonDetailClient["load"]): DiscoveryPersonDetailClient {
  return { load };
}

function personCreditsClient(
  load: DiscoveryPersonCreditsClient["load"],
): DiscoveryPersonCreditsClient {
  return { load };
}

const meta = {
  args: {
    client: client(async () => movieResponse),
    media: movie,
    onOpenChange: fn(),
    onRequest: fn(),
    open: true,
    personCreditsClient: personCreditsClient(async () => personCreditsResponse),
    personClient: personClient(async () => personResponse),
  },
  component: MediaDetailDrawer,
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100vh", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Media detail drawer",
} satisfies Meta<typeof MediaDetailDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Movie: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The Matrix" })).toBeVisible());
    expect(canvas.getByText("Free your mind.")).toBeVisible();
  },
};

export const ConnectedService: Story = {
  args: {
    client: client(
      async () => movieResponse,
      async () => ({
        actions: [
          {
            href: "/api/discovery/details/movie/603/actions/radarr",
            kind: "service_navigation",
            label: "Open in Radarr",
            service: "radarr",
          },
        ],
        generatedAt: "2026-07-28T20:00:00.000Z",
        kind: "movie",
        tmdbId: 603,
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Open in Radarr in a new tab" })).toBeVisible(),
    );
  },
};

export const Series: Story = {
  args: { client: client(async () => seriesResponse), media: series },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Breaking Bad" })).toBeVisible(),
    );
    expect(canvas.getByRole("heading", { name: "Season guide" })).toBeVisible();
  },
};

export const PersonContext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The Matrix" })).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: /Keanu Reeves/iu }));
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Keanu Reeves" })).toBeVisible(),
    );
    expect(canvas.getByRole("heading", { name: "Biography" })).toBeVisible();
  },
};

export const PaginatedFilmography: Story = {
  args: {
    media: null,
    person: { name: "Keanu Reeves", tmdbId: 6384 },
    personClient: personClient(async () => paginatedPersonResponse),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByText("Showing 24 of 30 credits")).toBeVisible());
    await userEvent.click(
      canvas.getByRole("button", { name: "Load more credits for Keanu Reeves" }),
    );
    await waitFor(() => expect(canvas.getByText("Showing 30 of 30 credits")).toBeVisible());
    expect(canvas.getByText("Complete filmography loaded")).toBeVisible();
  },
};

export const IntelligenceDegraded: Story = {
  args: {
    client: client(async () => ({
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
    })),
  },
};

export const Loading: Story = {
  args: { client: client(async () => new Promise<DiscoveryMediaDetailResponse>(() => undefined)) },
};

export const Offline: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new MediaDetailClientError(
          "unavailable",
          "service_unavailable",
          "Media details are offline.",
        ),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Details are temporarily offline" }),
      ).toBeVisible(),
    );
  },
};

export const SignedOut: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new MediaDetailClientError("signed_out", "authentication_required", "Sign in."),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Sign in to continue" })).toBeVisible(),
    );
    expect(canvas.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  },
};
