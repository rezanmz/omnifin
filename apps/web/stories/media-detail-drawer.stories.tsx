import type {
  DiscoveryMediaDetailResponse,
  DiscoveryMovieResult,
  DiscoverySeriesResult,
} from "@omnifin/contracts/discovery";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor, within } from "storybook/test";

import { MediaDetailDrawer } from "../components/media-detail-drawer";
import { MediaDetailClientError, type DiscoveryMediaDetailClient } from "../lib/media-details";

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
      { character: "Trinity", name: "Carrie-Anne Moss" },
      { character: "Agent Smith", name: "Hugo Weaving" },
    ],
    crew: [
      { name: "Lana Wachowski", role: "Director" },
      { name: "Lilly Wachowski", role: "Writer" },
      { name: "Bill Pope", role: "Director of Photography" },
      { name: "Don Davis", role: "Original Music Composer" },
    ],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
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
const seriesResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "partial",
    cast: [
      { character: "Walter White", name: "Bryan Cranston" },
      { character: "Jesse Pinkman", name: "Aaron Paul" },
    ],
    crew: [{ name: "Vince Gilligan", role: "Creator" }],
    episodeCount: 62,
    genres: ["Drama", "Crime"],
    id: "series:1396",
    kind: "series",
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

function client(load: DiscoveryMediaDetailClient["load"]): DiscoveryMediaDetailClient {
  return { load };
}

const meta = {
  args: {
    client: client(async () => movieResponse),
    media: movie,
    onOpenChange: fn(),
    onRequest: fn(),
    open: true,
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
