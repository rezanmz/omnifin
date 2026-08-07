import type { SavedMembershipSummary } from "@omnifin/contracts/saved";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { readySavedOutcome, savedListsDemoClient } from "../lib/saved-lists-demo";
import { SavedListsClientError, type SavedListsClient } from "../lib/saved-lists";
import { SavedTitleActions } from "./saved-title-actions";

const referenceId = `media_${"m".repeat(22)}`;
const targetReferenceId = `save_target_${"t".repeat(22)}`;
const catalogReferenceId = `catalog_${"c".repeat(22)}`;
const etag = `"saved_${"e".repeat(22)}"`;
const nextEtag = `"saved_${"n".repeat(22)}"`;
const now = "2026-08-04T11:00:00.000Z";

function summary(watchLater = false, customListIds: string[] = []): SavedMembershipSummary {
  return {
    catalogReferenceId: watchLater || customListIds.length > 0 ? catalogReferenceId : null,
    customListCount: customListIds.length,
    customListIds,
    expiresAt: "2026-08-04T11:15:00.000Z",
    favorite: { state: "synced", value: false },
    issuedAt: now,
    targetReferenceId,
    watchLater,
  };
}

function client(input: { customListIds?: string[]; watchLater?: boolean } = {}) {
  const issued = summary(input.watchLater, input.customListIds);
  return {
    ...savedListsDemoClient,
    addItem: vi.fn(async (listId, _input, _options) => ({
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
    issueDiscoveryTarget: vi.fn(async (_referenceId, _options) => issued),
    issueLibraryTarget: vi.fn(async (_referenceId, _options) => issued),
    load: vi.fn<SavedListsClient["load"]>(async () => readySavedOutcome),
    readList: vi.fn(async (_listId, _signal) => ({
      data: readySavedOutcome.snapshot.lists.watchLater,
      etag,
    })),
    removeItem: vi.fn(async (listId, catalogId, _options) => ({
      data: { catalogReferenceId: catalogId, listId, removed: true, revision: 2 },
      etag: nextEtag,
    })),
    updateFavorite: vi.fn(async (_target, input, _options) => ({
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
    expect(screen.getByRole("status")).toHaveTextContent("Added to Watch Later.");
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
    expect(screen.getByRole("status")).toHaveTextContent("Removed from Watch Later.");
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

  it("saves a requestable title without invoking its request workflow", async () => {
    const user = userEvent.setup();
    const actions = client();
    render(
      <SavedTitleActions
        client={actions}
        compact
        discovery={{ kind: "movie", language: "en-CA", tmdbId: 603 }}
        title="The Far Meridian"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Toggle The Far Meridian in Watch Later" }),
    );

    expect(actions.issueDiscoveryTarget).toHaveBeenCalledWith(
      { kind: "movie", language: "en-CA", tmdbId: 603 },
      { csrfToken: readySavedOutcome.snapshot.csrfToken },
    );
    expect(actions.issueLibraryTarget).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Added to Watch Later.");
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
      {
        csrfToken: readySavedOutcome.snapshot.csrfToken,
        idempotencyKey: expect.stringMatching(/^saved-/u),
      },
    );
  });

  it("reissues an expired target and rereads the list before retrying", async () => {
    const user = userEvent.setup();
    const actions = client();
    const successfulAdd = await client().addItem(
      readySavedOutcome.snapshot.lists.watchLater.id,
      { targetReferenceId },
      {
        csrfToken: readySavedOutcome.snapshot.csrfToken,
        etag,
        idempotencyKey: "saved-test-success",
      },
    );
    const refreshedTarget = `save_target_${"r".repeat(22)}`;
    actions.issueLibraryTarget
      .mockResolvedValueOnce(summary())
      .mockResolvedValueOnce({ ...summary(), targetReferenceId: refreshedTarget });
    actions.readList
      .mockResolvedValueOnce({ data: readySavedOutcome.snapshot.lists.watchLater, etag })
      .mockResolvedValueOnce({
        data: readySavedOutcome.snapshot.lists.watchLater,
        etag: nextEtag,
      });
    actions.addItem
      .mockRejectedValueOnce(
        new SavedListsClientError("expired", "saved_target_expired", "Refresh the title.", {
          retryMode: "refresh",
        }),
      )
      .mockResolvedValueOnce({ ...successfulAdd, etag: nextEtag });
    render(
      <SavedTitleActions client={actions} compact referenceId={referenceId} title="Ember Coast" />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle Ember Coast in Watch Later" }));

    await waitFor(() => expect(actions.addItem).toHaveBeenCalledTimes(2));
    expect(actions.issueLibraryTarget).toHaveBeenCalledTimes(2);
    expect(actions.readList).toHaveBeenCalledTimes(2);
    expect(actions.addItem.mock.calls[1]?.[1]).toEqual({ targetReferenceId: refreshedTarget });
    expect(actions.addItem.mock.calls[1]?.[2]).toMatchObject({ etag: nextEtag });
  });

  it("retains the favorite key while an unknown outcome is reconciled", async () => {
    const user = userEvent.setup();
    const actions = client();
    actions.updateFavorite
      .mockRejectedValueOnce(
        new SavedListsClientError(
          "unavailable",
          "saved_favorite_outcome_unknown",
          "The outcome is unknown.",
          { retryMode: "same_key" },
        ),
      )
      .mockResolvedValueOnce({
        favorite: true,
        synchronizedAt: now,
        targetReferenceId,
      });
    render(
      <SavedTitleActions client={actions} eager referenceId={referenceId} title="Ember Coast" />,
    );
    const favorite = await screen.findByRole("button", { name: "Favorite" });

    await user.click(favorite);
    expect(await screen.findByRole("status")).toHaveTextContent("may have changed");
    await user.click(favorite);

    await waitFor(() => expect(actions.updateFavorite).toHaveBeenCalledTimes(2));
    expect(actions.updateFavorite.mock.calls[0]?.[2].idempotencyKey).toBe(
      actions.updateFavorite.mock.calls[1]?.[2].idempotencyKey,
    );
  });

  it("adds and removes the title from a named personal list", async () => {
    const user = userEvent.setup();
    const customList = readySavedOutcome.snapshot.lists.lists[0]!;
    const actions = client();
    const view = render(
      <SavedTitleActions client={actions} eager referenceId={referenceId} title="Ember Coast" />,
    );

    await screen.findByRole("button", { name: "Favorite" });
    await user.click(screen.getByText("Personal lists"));
    const add = screen.getByRole("button", { name: `Add Ember Coast to ${customList.name}` });
    await user.click(add);

    await waitFor(() => expect(add).toHaveAttribute("aria-pressed", "true"));
    expect(actions.addItem).toHaveBeenLastCalledWith(
      customList.id,
      { targetReferenceId },
      expect.objectContaining({ csrfToken: readySavedOutcome.snapshot.csrfToken, etag }),
    );

    view.unmount();
    const removalActions = client({ customListIds: [customList.id] });
    render(
      <SavedTitleActions
        client={removalActions}
        eager
        referenceId={referenceId}
        title="Ember Coast"
      />,
    );
    await screen.findByRole("button", { name: "Favorite" });
    await user.click(screen.getByText("Personal lists"));
    const remove = screen.getByRole("button", {
      name: `Remove Ember Coast from ${customList.name}`,
    });
    await user.click(remove);

    await waitFor(() => expect(remove).toHaveAttribute("aria-pressed", "false"));
    expect(removalActions.removeItem).toHaveBeenCalledWith(customList.id, catalogReferenceId, {
      csrfToken: readySavedOutcome.snapshot.csrfToken,
      etag,
    });
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
