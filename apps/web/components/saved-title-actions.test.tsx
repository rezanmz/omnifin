import type { SavedMembershipSummary } from "@omnifin/contracts/saved";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { readySavedOutcome, savedListsDemoClient } from "../lib/saved-lists-demo";
import type { SavedListsClient } from "../lib/saved-lists";
import { SavedTitleActions } from "./saved-title-actions";

const referenceId = `media_${"m".repeat(22)}`;
const targetReferenceId = `save_target_${"t".repeat(22)}`;
const catalogReferenceId = `catalog_${"c".repeat(22)}`;
const etag = `"saved_${"e".repeat(22)}"`;
const nextEtag = `"saved_${"n".repeat(22)}"`;
const now = "2026-08-04T11:00:00.000Z";

function summary(watchLater = false): SavedMembershipSummary {
  return {
    catalogReferenceId: watchLater ? catalogReferenceId : null,
    customListCount: 0,
    expiresAt: "2026-08-04T11:15:00.000Z",
    favorite: { state: "synced", value: false },
    issuedAt: now,
    targetReferenceId,
    watchLater,
  };
}

function client(input: { watchLater?: boolean } = {}) {
  const issued = summary(input.watchLater);
  return {
    ...savedListsDemoClient,
    addItem: vi.fn(async (listId) => ({
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
            favorite: { state: "synced" as const, value: false },
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
      etag: nextEtag,
      replayed: false,
    })),
    issueLibraryTarget: vi.fn(async () => issued),
    load: vi.fn<SavedListsClient["load"]>(async () => readySavedOutcome),
    readList: vi.fn(async () => ({ data: readySavedOutcome.snapshot.lists.watchLater, etag })),
    removeItem: vi.fn(async (listId, catalogId) => ({
      data: { catalogReferenceId: catalogId, listId, removed: true, revision: 2 },
      etag: nextEtag,
    })),
    updateFavorite: vi.fn(async (_target, input) => ({
      favorite: input.favorite,
      synchronizedAt: now,
      targetReferenceId,
    })),
  } satisfies SavedListsClient;
}

describe("SavedTitleActions", () => {
  it("adds an owned title to Watch Later with opaque target and revision proofs", async () => {
    const user = userEvent.setup();
    const actions = client();
    render(
      <SavedTitleActions client={actions} compact referenceId={referenceId} title="Ember Coast" />,
    );

    const toggle = screen.getByRole("button", { name: "Toggle Ember Coast in Watch Later" });
    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(actions.issueLibraryTarget).toHaveBeenCalledWith(referenceId, {
      csrfToken: readySavedOutcome.snapshot.csrfToken,
    });
    expect(actions.addItem).toHaveBeenCalledWith(
      readySavedOutcome.snapshot.lists.watchLater.id,
      { targetReferenceId },
      expect.objectContaining({
        csrfToken: readySavedOutcome.snapshot.csrfToken,
        etag,
        idempotencyKey: expect.stringMatching(/^saved-/u),
      }),
    );
  });

  it("removes an existing Watch Later membership without touching media", async () => {
    const user = userEvent.setup();
    const actions = client({ watchLater: true });
    render(
      <SavedTitleActions client={actions} compact referenceId={referenceId} title="Ember Coast" />,
    );

    const toggle = screen.getByRole("button", { name: "Toggle Ember Coast in Watch Later" });
    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(actions.removeItem).toHaveBeenCalledWith(
      readySavedOutcome.snapshot.lists.watchLater.id,
      catalogReferenceId,
      {
        csrfToken: readySavedOutcome.snapshot.csrfToken,
        etag,
      },
    );
    expect(actions.addItem).not.toHaveBeenCalled();
  });

  it("loads detail controls and synchronizes Favorite distinctly through Jellyfin", async () => {
    const user = userEvent.setup();
    const actions = client();
    render(
      <SavedTitleActions client={actions} eager referenceId={referenceId} title="Ember Coast" />,
    );

    const favorite = await screen.findByRole("button", { name: "Favorite" });
    expect(favorite).toBeEnabled();
    await user.click(favorite);

    await waitFor(() => expect(favorite).toHaveAttribute("aria-pressed", "true"));
    expect(favorite).toHaveTextContent("Jellyfin Favorite");
    expect(actions.updateFavorite).toHaveBeenCalledWith(
      targetReferenceId,
      { favorite: true },
      { csrfToken: readySavedOutcome.snapshot.csrfToken },
    );
  });

  it("keeps a recoverable message when saved services are unavailable", async () => {
    const actions = client();
    actions.load.mockResolvedValueOnce({ status: "unavailable" });
    render(
      <SavedTitleActions client={actions} eager referenceId={referenceId} title="Ember Coast" />,
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "saved-title change could not be confirmed",
    );
    expect(screen.getByRole("button", { name: "Favorite" })).toBeDisabled();
  });
});
