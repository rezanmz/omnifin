import type { LibraryArtworkSearchResponse } from "@omnifin/contracts/library";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { LibraryCare } from "../components/library-care";
import { emptyLibraryOutcome, readyLibraryOutcome } from "../lib/library-care-demo";
import type { LibraryOperationsClient } from "../lib/library-operations";

const generatedAt = "2026-07-28T16:00:00.000Z";
const searchId = `library_artwork_search_${"s".repeat(22)}`;
const resultId = `library_artwork_result_${"r".repeat(22)}`;
const artwork: LibraryArtworkSearchResponse = {
  expiresAt: "2026-07-28T16:20:00.000Z",
  generatedAt,
  kind: "poster",
  referenceId: `media_${"b".repeat(22)}`,
  results: [
    {
      communityRating: 8.6,
      height: 3000,
      id: resultId,
      language: "English",
      previewPath: `/v1/library/artwork-searches/${searchId}/results/${resultId}/preview`,
      providerName: "TMDB",
      voteCount: 88,
      width: 2000,
    },
    {
      communityRating: 7.9,
      height: 2160,
      id: `library_artwork_result_${"q".repeat(22)}`,
      language: null,
      previewPath: `/v1/library/artwork-searches/${searchId}/results/library_artwork_result_${"q".repeat(22)}/preview`,
      providerName: "Fanart",
      voteCount: 31,
      width: 1440,
    },
  ],
  searchId,
};

function mutation(referenceId: string | null) {
  return {
    receipt: {
      acceptedAt: generatedAt,
      operationId: `library_operation_${"o".repeat(22)}`,
      referenceId,
      state: "accepted" as const,
    },
    replayed: false,
  };
}

const storyClient: LibraryOperationsClient = {
  applyArtwork: async () => mutation(artwork.referenceId),
  load: async () => readyLibraryOutcome,
  loadAttention: async () => readyLibraryOutcome.snapshot.attention,
  refresh: async (referenceId) => mutation(referenceId),
  scan: async () => mutation(null),
  searchArtwork: async () => artwork,
  updateMetadata: async (referenceId) => mutation(referenceId),
};

const meta = {
  args: { client: storyClient, initialOutcome: readyLibraryOutcome },
  argTypes: { client: { control: false }, initialOutcome: { control: false } },
  component: LibraryCare,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Library care",
} satisfies Meta<typeof LibraryCare>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const ArtworkFilter: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Artwork" }));
    await expect(canvas.getByRole("button", { name: "Inspect Northern Lights" })).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Inspect Ember Coast" }),
    ).not.toBeInTheDocument();
  },
};
export const Inspector: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Inspect Ember Coast" }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Close library inspector" })).toHaveFocus(),
    );
    await expect(canvas.getByRole("heading", { name: "Editorial details" })).toBeVisible();
  },
};
export const ArtworkPicker: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Inspect Northern Lights" }));
    await userEvent.click(canvas.getByRole("button", { name: "Find artwork" }));
    await expect(canvas.getByText("TMDB")).toBeVisible();
    await expect(canvas.getByText("Fanart")).toBeVisible();
  },
};
export const Empty: Story = { args: { initialOutcome: emptyLibraryOutcome } };
export const Loading: Story = {
  args: {
    client: {
      ...storyClient,
      load: () => new Promise(() => undefined),
    },
  },
  render: ({ client }) => <LibraryCare client={client ?? storyClient} />,
};
export const Offline: Story = { args: { initialOutcome: { status: "unavailable" } } };
export const PermissionDenied: Story = { args: { initialOutcome: { status: "forbidden" } } };
