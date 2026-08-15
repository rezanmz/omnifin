import type {
  DiscoveryMediaDetailResponse,
  DiscoveryMovieResult,
} from "@omnifin/contracts/discovery";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor, within } from "storybook/test";

import { mediaLibraryDemoClient, mediaLibraryDemoItems } from "../lib/media-library-demo";
import { DiscoveryTitleDrawer } from "./discovery-title-drawer";

const owned = mediaLibraryDemoItems.find(({ media }) => media.kind === "movie")!;
const media: DiscoveryMovieResult = {
  availability: "available",
  id: "movie:603",
  kind: "movie",
  mediaRecordState: "present",
  originalTitle: "The Far Meridian",
  overview: "A discovery result resolved to the current Jellyfin user.",
  source: "seerr",
  title: "The Far Meridian",
  tmdbId: 603,
  voteAverage: 8.8,
  year: 2026,
};
const detail: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-08-15T00:00:00.000Z",
  item: {
    artwork: { backdropPath: null, posterPath: null },
    availability: "available",
    cast: [],
    crew: [],
    genres: [],
    id: media.id,
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
    kind: "movie",
    libraryReferenceId: owned.media.id,
    mediaRecordState: "present",
    originalTitle: media.originalTitle,
    overview: media.overview,
    productionStatus: "Released",
    runtimeMinutes: 128,
    source: "seerr",
    tagline: null,
    title: media.title,
    tmdbId: media.tmdbId,
    voteAverage: media.voteAverage,
    voteCount: 4_200,
    year: media.year,
  },
};

const meta = {
  args: {
    client: { load: async () => detail },
    libraryClient: mediaLibraryDemoClient,
    media,
    onOpenChange: fn(),
    open: true,
  },
  component: DiscoveryTitleDrawer,
  parameters: { layout: "fullscreen" },
  title: "Components/Discovery title drawer",
} satisfies Meta<typeof DiscoveryTitleDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OwnedMovie: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: owned.media.title })).toBeVisible(),
    );
    expect(canvas.getByRole("button", { name: "Resume movie" })).toBeVisible();
  },
};
