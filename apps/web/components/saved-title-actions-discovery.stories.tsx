import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { SavedMembershipSummary } from "@omnifin/contracts/saved";
import { expect, fn, userEvent, within } from "storybook/test";

import { readySavedOutcome, savedListsDemoClient } from "../lib/saved-lists-demo";
import type { SavedListsClient } from "../lib/saved-lists";
import { SavedTitleActions } from "./saved-title-actions";

const issued: SavedMembershipSummary = {
  catalogReferenceId: null,
  customListCount: 0,
  customListIds: [],
  expiresAt: "2026-08-04T11:15:00.000Z",
  favorite: { state: "not_applicable", value: null },
  issuedAt: "2026-08-04T11:00:00.000Z",
  targetReferenceId: `save_target_${"d".repeat(22)}`,
  watchLater: false,
};

const client: SavedListsClient = {
  ...savedListsDemoClient,
  addItem: fn(async (listId) => ({
    data: {
      created: true,
      item: {
        addedAt: issued.issuedAt,
        catalog: {
          artwork: {
            accentColor: null,
            backdropPath: null,
            blurHash: null,
            posterPath: null,
          },
          availability: "requestable" as const,
          favorite: { state: "not_applicable" as const, value: null },
          id: `catalog_${"d".repeat(22)}`,
          kind: "movie" as const,
          libraryReferenceId: null,
          overview: "A verified requestable title.",
          resolutionState: "current" as const,
          title: "The Far Meridian",
          year: 2026,
        },
        id: `saved_item_${"d".repeat(22)}`,
        position: 0,
      },
      listId,
      revision: 2,
    },
    etag: `"saved_${"d".repeat(22)}"`,
    replayed: false,
  })),
  issueDiscoveryTarget: fn(async () => issued),
  load: fn(async () => readySavedOutcome),
  readList: fn(async () => ({
    data: readySavedOutcome.snapshot.lists.watchLater,
    etag: `"saved_${"e".repeat(22)}"`,
  })),
};

const meta = {
  args: {
    client,
    discovery: { kind: "movie", language: "en", tmdbId: 603 },
    eager: true,
    title: "The Far Meridian",
  },
  component: SavedTitleActions,
  parameters: { layout: "centered" },
  title: "Discovery/Saved title actions",
} satisfies Meta<typeof SavedTitleActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Requestable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const watchLater = await canvas.findByRole("button", { name: "Watch Later" });
    await expect(canvas.queryByRole("button", { name: "Favorite" })).not.toBeInTheDocument();
    await userEvent.click(watchLater);
    await expect(watchLater).toHaveAttribute("aria-pressed", "true");
  },
};
