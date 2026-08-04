import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { SavedMembershipSummary } from "@omnifin/contracts/saved";
import { expect, fn, userEvent, within } from "storybook/test";

import { readySavedOutcome, savedListsDemoClient } from "../lib/saved-lists-demo";
import type { SavedListsClient } from "../lib/saved-lists";
import { SavedTitleActions } from "./saved-title-actions";

const referenceId = `media_${"m".repeat(22)}`;
const targetReferenceId = `save_target_${"t".repeat(22)}`;
const catalogReferenceId = `catalog_${"c".repeat(22)}`;
const etag = `"saved_${"e".repeat(22)}"`;
const now = "2026-08-04T11:00:00.000Z";

function storyClient(watchLater = false): SavedListsClient {
  const issued: SavedMembershipSummary = {
    catalogReferenceId: watchLater ? catalogReferenceId : null,
    customListCount: 0,
    expiresAt: "2026-08-04T11:15:00.000Z",
    favorite: { state: "synced", value: true },
    issuedAt: now,
    targetReferenceId,
    watchLater,
  };
  return {
    ...savedListsDemoClient,
    addItem: fn(async (listId) => ({
      data: {
        created: true,
        item: {
          addedAt: now,
          catalog: {
            artwork: {
              accentColor: null,
              backdropPath: null,
              blurHash: null,
              posterPath: null,
            },
            availability: "owned" as const,
            favorite: { state: "synced" as const, value: true },
            id: catalogReferenceId,
            kind: "movie" as const,
            libraryReferenceId: referenceId,
            overview: null,
            resolutionState: "current" as const,
            title: "Ember Coast",
            year: 2026,
          },
          id: `saved_item_${"i".repeat(22)}`,
          position: 0,
        },
        listId,
        revision: 2,
      },
      etag,
      replayed: false,
    })),
    issueLibraryTarget: fn(async () => issued),
    load: fn(async () => readySavedOutcome),
    readList: fn(async () => ({ data: readySavedOutcome.snapshot.lists.watchLater, etag })),
    removeItem: fn(async (listId, selectedCatalogId) => ({
      data: {
        catalogReferenceId: selectedCatalogId,
        listId,
        removed: true,
        revision: 2,
      },
      etag,
    })),
    updateFavorite: fn(async (_target, input) => ({
      favorite: input.favorite,
      synchronizedAt: now,
      targetReferenceId,
    })),
  };
}

const meta = {
  args: {
    client: storyClient(),
    eager: true,
    referenceId,
    title: "Ember Coast",
  },
  component: SavedTitleActions,
  parameters: { layout: "centered" },
  title: "Library/Saved title actions",
} satisfies Meta<typeof SavedTitleActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Favorite" })).toBeEnabled();
  },
};

export const Saved: Story = {
  args: { client: storyClient(true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "In Watch Later" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const CompactInteraction: Story = {
  args: { client: storyClient(), compact: true, eager: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Toggle Ember Coast in Watch Later" });
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-pressed", "true");
  },
};
