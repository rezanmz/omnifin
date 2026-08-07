import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { SavedListItemsResponse, SavedListsResponse } from "@omnifin/contracts/saved";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SavedListsClientError,
  savedListsClient,
  type SavedListsClient,
  type SavedWorkspaceLoadOutcome,
} from "../lib/saved-lists";
import { SavedLibrary } from "./saved-library";

const csrfToken = "saved_ui_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const watchLaterId = `saved_list_${"l".repeat(22)}`;
const customListId = `saved_list_${"u".repeat(22)}`;
const catalogId = `catalog_${"c".repeat(22)}`;
const itemId = `saved_item_${"i".repeat(22)}`;
const mediaId = `media_${"m".repeat(22)}`;
const etag = `"saved_${"e".repeat(22)}"`;
const now = "2026-08-04T11:00:00.000Z";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-09-04T11:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Mina",
  externalIdentity: null,
  inactivityExpiresAt: "2026-08-04T12:00:00.000Z",
  issuedAt: now,
  linkedServices: [
    {
      displayName: "Home Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: now,
      linkedAt: now,
      service: "jellyfin",
      username: "mina",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.viewer],
  role: "viewer",
  sessionId: "session-mina",
  userId: "user-mina",
};

const watchLater = {
  capabilities: { delete: false, rename: false, reorder: true as const },
  createdAt: now,
  description: null,
  id: watchLaterId,
  itemCount: 1,
  kind: "watch_later" as const,
  name: "Watch Later",
  revision: 1,
  updatedAt: now,
};

const customList = {
  capabilities: { delete: true, rename: true, reorder: true as const },
  createdAt: now,
  description: "Friday night picks",
  id: customListId,
  itemCount: 0,
  kind: "custom" as const,
  name: "Weekend",
  revision: 0,
  updatedAt: now,
};

const lists: SavedListsResponse = {
  generatedAt: now,
  lists: [customList],
  nextCursor: null,
  watchLater,
};

const page: SavedListItemsResponse = {
  generatedAt: now,
  items: [
    {
      addedAt: now,
      catalog: {
        artwork: {
          accentColor: "#336699",
          backdropPath: `/api/saved/catalog/${catalogId}/images/backdrop`,
          blurHash: null,
          posterPath: `/api/saved/catalog/${catalogId}/images/poster`,
        },
        availability: "owned",
        favorite: { state: "synced", value: true },
        id: catalogId,
        kind: "movie",
        libraryReferenceId: mediaId,
        overview: "A quiet signal crosses the horizon.",
        resolutionState: "current",
        title: "The Far Meridian",
        year: 2026,
      },
      id: itemId,
      position: 0,
    },
  ],
  list: watchLater,
  nextCursor: null,
  reconciliation: { failures: [], state: "current" },
};

const ready: Extract<SavedWorkspaceLoadOutcome, { status: "ready" }> = {
  snapshot: { csrfToken, lists, principal },
  status: "ready",
};

describe("SavedLibrary", () => {
  it("presents Watch Later and personal lists as a private destination", () => {
    render(<SavedLibrary initialOutcome={ready} initialPage={{ data: page, etag }} live={false} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Keep the next story close." }),
    ).toBeVisible();
    const navigation = screen.getByRole("navigation");
    expect(within(navigation).getByRole("button", { name: /Watch Later/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).getByRole("button", { name: /Weekend/i })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "The Far Meridian" })).toBeVisible();
    expect(screen.getByText("Ready to play", { exact: false })).toBeVisible();
    expect(screen.getByText("Only you")).toBeVisible();
  });

  it("removes membership and refetches the first page with a fresh cursor", async () => {
    const user = userEvent.setup();
    const secondItem = {
      ...page.items[0]!,
      catalog: {
        ...page.items[0]!.catalog,
        id: `catalog_${"d".repeat(22)}`,
        title: "Second Signal",
      },
      id: `saved_item_${"d".repeat(22)}`,
      position: 0,
    };
    const removeItem = vi.fn(async () => ({
      data: { catalogReferenceId: catalogId, listId: watchLaterId, removed: true, revision: 2 },
      etag: `"saved_${"n".repeat(22)}"`,
    }));
    const listItems = vi.fn<SavedListsClient["listItems"]>(async () => ({
      data: {
        ...page,
        items: [secondItem],
        list: { ...watchLater, itemCount: 2, revision: 2 },
        nextCursor: "saved-cursor-fresh-after-remove-001",
      },
      etag: `"saved_${"f".repeat(22)}"`,
    }));
    render(
      <SavedLibrary
        client={{ ...savedListsClient, listItems, removeItem }}
        initialOutcome={ready}
        initialPage={{
          data: {
            ...page,
            list: { ...watchLater, itemCount: 3 },
            nextCursor: "saved-cursor-after-remove-001",
          },
          etag,
        }}
        live={false}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove The Far Meridian from this private list" }),
    );

    await waitFor(() =>
      expect(removeItem).toHaveBeenCalledWith(watchLaterId, catalogId, {
        csrfToken,
        etag,
      }),
    );
    expect(await screen.findByRole("heading", { name: "Second Signal" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "The Far Meridian" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Removed The Far Meridian from Watch Later.",
    );
    expect(
      within(screen.getByRole("navigation")).getByRole("button", { name: /Watch Later/i }),
    ).toHaveTextContent("2 titles");
    expect(screen.getByRole("button", { name: "Load more saved titles" })).toBeVisible();
    expect(listItems).toHaveBeenCalledWith(watchLaterId, {
      availability: "all",
      limit: 30,
      sort: "manual",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Watch Later" })),
    );
  });

  it("loads a non-null continuation cursor without replacing visible titles", async () => {
    const user = userEvent.setup();
    const secondItem = {
      ...page.items[0]!,
      catalog: {
        ...page.items[0]!.catalog,
        id: `catalog_${"d".repeat(22)}`,
        title: "Second Signal",
      },
      id: `saved_item_${"d".repeat(22)}`,
      position: 1,
    };
    const cursor = "saved-cursor-next-001";
    const listItems = vi.fn<SavedListsClient["listItems"]>(async (_listId, query) => ({
      data: {
        ...page,
        items: query.cursor ? [secondItem] : page.items,
        nextCursor: null,
      },
      etag,
    }));
    render(
      <SavedLibrary
        client={{ ...savedListsClient, listItems }}
        initialOutcome={ready}
        initialPage={{ data: { ...page, nextCursor: cursor }, etag }}
        live={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more saved titles" }));

    await waitFor(() => expect(screen.getByText("Second Signal")).toBeVisible());
    expect(screen.getByText("The Far Meridian")).toBeVisible();
    expect(listItems).toHaveBeenCalledWith(
      watchLaterId,
      expect.objectContaining({ cursor }),
      expect.any(AbortSignal),
    );
  });

  it("discards delayed pagination after switching lists", async () => {
    const user = userEvent.setup();
    const secondItem = {
      ...page.items[0]!,
      catalog: {
        ...page.items[0]!.catalog,
        id: `catalog_${"d".repeat(22)}`,
        title: "Second Signal",
      },
      id: `saved_item_${"d".repeat(22)}`,
      position: 1,
    };
    let releasePage!: (value: Awaited<ReturnType<SavedListsClient["listItems"]>>) => void;
    const delayedPage = new Promise<Awaited<ReturnType<SavedListsClient["listItems"]>>>(
      (resolve) => {
        releasePage = resolve;
      },
    );
    const listItems = vi.fn<SavedListsClient["listItems"]>((listId, query) => {
      if (query.cursor) return delayedPage;
      return Promise.resolve({
        data: {
          ...page,
          items: [],
          list: { ...customList, id: listId },
          nextCursor: null,
        },
        etag,
      });
    });
    render(
      <SavedLibrary
        client={{ ...savedListsClient, listItems }}
        initialOutcome={ready}
        initialPage={{ data: { ...page, nextCursor: "saved-cursor-delayed-001" }, etag }}
        live={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more saved titles" }));
    await waitFor(() => expect(listItems).toHaveBeenCalledOnce());
    const paginationSignal = listItems.mock.calls[0]?.[2];
    await user.click(
      within(screen.getByRole("navigation")).getByRole("button", { name: /Weekend/i }),
    );
    await screen.findByRole("heading", { name: "Weekend is empty." });

    releasePage({
      data: { ...page, items: [secondItem], nextCursor: null },
      etag,
    });

    await waitFor(() => expect(paginationSignal?.aborted).toBe(true));
    expect(screen.queryByRole("heading", { name: "Second Signal" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weekend" })).toBeVisible();
  });

  it("moves adjacent titles and refetches the first page with a fresh cursor", async () => {
    const user = userEvent.setup();
    const secondItem = {
      ...page.items[0]!,
      catalog: {
        ...page.items[0]!.catalog,
        id: `catalog_${"d".repeat(22)}`,
        title: "Second Signal",
      },
      id: `saved_item_${"d".repeat(22)}`,
      position: 1,
    };
    const reorderItems = vi.fn<SavedListsClient["reorderItems"]>(async (_listId, input) => ({
      data: { ...input, revision: 2 },
      etag: `"saved_${"r".repeat(22)}"`,
      replayed: false,
    }));
    const listItems = vi.fn<SavedListsClient["listItems"]>(async () => ({
      data: {
        ...page,
        items: [
          { ...secondItem, position: 0 },
          { ...page.items[0]!, position: 1 },
        ],
        list: { ...watchLater, itemCount: 3, revision: 2 },
        nextCursor: "saved-cursor-fresh-after-reorder-001",
      },
      etag: `"saved_${"f".repeat(22)}"`,
    }));
    render(
      <SavedLibrary
        client={{ ...savedListsClient, listItems, reorderItems }}
        initialOutcome={ready}
        initialPage={{
          data: {
            ...page,
            items: [page.items[0]!, secondItem],
            list: { ...watchLater, itemCount: 3 },
            nextCursor: "saved-cursor-after-reorder-001",
          },
          etag,
        }}
        live={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Move The Far Meridian later" }));

    await waitFor(() => expect(reorderItems).toHaveBeenCalledOnce());
    expect(reorderItems).toHaveBeenCalledWith(
      watchLaterId,
      { orderedItemIds: [secondItem.id, itemId], startPosition: 0 },
      expect.objectContaining({
        csrfToken,
        etag,
        idempotencyKey: expect.stringMatching(/^saved-/u),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
      ).toEqual(["Second Signal", "The Far Meridian"]),
    );
    expect(await screen.findByRole("button", { name: "Load more saved titles" })).toBeVisible();
    expect(listItems).toHaveBeenCalledWith(watchLaterId, {
      availability: "all",
      limit: 30,
      sort: "manual",
    });
  });

  it("creates a bounded personal list without exposing private input in the URL", async () => {
    const user = userEvent.setup();
    const createList = vi.fn<SavedListsClient["createList"]>(async () => ({
      data: {
        list: { ...customList, id: `saved_list_${"n".repeat(22)}`, name: "Family night" },
      },
      etag,
      replayed: false,
    }));
    render(
      <SavedLibrary
        client={{
          ...savedListsClient,
          createList,
          listItems: async (listId) => ({
            data: {
              ...page,
              items: [],
              list: {
                ...customList,
                id: listId,
                itemCount: 0,
                name: "Family night",
              },
            },
            etag,
          }),
        }}
        initialOutcome={ready}
        initialPage={{ data: page, etag }}
        live={false}
      />,
    );

    await user.type(screen.getByLabelText("New personal list"), "Family night");
    await user.click(screen.getByRole("button", { name: "Create private list" }));

    await waitFor(() => expect(createList).toHaveBeenCalledOnce());
    expect(createList.mock.calls[0]?.[0]).toEqual({ description: null, name: "Family night" });
    expect(createList.mock.calls[0]?.[1]).toMatchObject({ csrfToken });
    expect(createList.mock.calls[0]?.[1].idempotencyKey).toMatch(/^saved-/u);
    expect(screen.getByRole("status")).toHaveTextContent("Created Family night.");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Family night is empty." })).toBeVisible(),
    );
  });

  it("retains one create key while the same pending name has an ambiguous failure", async () => {
    const user = userEvent.setup();
    const ambiguous = new SavedListsClientError(
      "unavailable",
      "service_unavailable",
      "Try again.",
      { retryMode: "same_key" },
    );
    const createList = vi
      .fn<SavedListsClient["createList"]>()
      .mockRejectedValueOnce(ambiguous)
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        data: { list: { ...customList, id: `saved_list_${"n".repeat(22)}`, name: "Changed" } },
        etag,
        replayed: true,
      });
    render(
      <SavedLibrary
        client={{ ...savedListsClient, createList }}
        initialOutcome={ready}
        initialPage={{ data: page, etag }}
        live={false}
      />,
    );
    await user.type(screen.getByLabelText("New personal list"), "Retry me");
    const create = screen.getByRole("button", { name: "Create private list" });

    await user.click(create);
    await screen.findByRole("alert");
    const name = screen.getByLabelText("New personal list");
    await user.clear(name);
    await user.type(name, "Changed");
    await user.click(create);
    await waitFor(() => expect(createList).toHaveBeenCalledTimes(2));
    await user.click(create);

    await waitFor(() => expect(createList).toHaveBeenCalledTimes(3));
    expect(createList.mock.calls[0]?.[1].idempotencyKey).not.toBe(
      createList.mock.calls[1]?.[1].idempotencyKey,
    );
    expect(createList.mock.calls[1]?.[1].idempotencyKey).toBe(
      createList.mock.calls[2]?.[1].idempotencyKey,
    );
  });

  it.each([
    ["signed_out", "Sign in to see what you saved."],
    ["forbidden", "Saved lists are not available to this account."],
  ] as const)("renders the %s account boundary", (status, title) => {
    render(<SavedLibrary initialOutcome={{ status }} live={false} />);
    expect(screen.getByRole("heading", { name: title })).toBeVisible();
  });

  it("keeps private records untouched when the gateway is unavailable", () => {
    render(<SavedLibrary initialOutcome={{ status: "unavailable" }} live={false} />);
    expect(
      screen.getByRole("heading", { name: "Your saved titles are still safe." }),
    ).toBeVisible();
    expect(screen.getByText("Nothing was changed.", { exact: false })).toBeVisible();
  });
});
