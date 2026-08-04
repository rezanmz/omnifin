import { describe, expect, it } from "vitest";

import {
  SAVED_LIST_MAX_ITEMS,
  SAVED_LIST_PAGE_MAX_ITEMS,
  SAVED_LIST_REORDER_MAX_ITEMS,
  savedCatalogItemSchema,
  savedFavoriteMutationRequestJsonSchema,
  savedFavoriteMutationRequestSchema,
  savedFavoriteMutationResponseSchema,
  savedListCreateRequestSchema,
  savedListDeleteResponseSchema,
  savedListItemsQuerySchema,
  savedListItemsResponseJsonSchema,
  savedListItemsResponseSchema,
  savedListMembershipDeleteResponseSchema,
  savedListMembershipRequestSchema,
  savedListMembershipResponseSchema,
  savedListReorderRequestSchema,
  savedListReorderResponseSchema,
  savedListUpdateRequestSchema,
  savedListsQuerySchema,
  savedListsResponseSchema,
  savedMembershipSummarySchema,
} from "../src/saved.js";

const generatedAt = "2026-08-04T08:00:00.000Z";
const listId = "saved_list_abcdefghijklmnopqrstuv";
const customListId = "saved_list_zyxwvutsrqponmlkjihgfe";
const catalogId = "catalog_abcdefghijklmnopqrstuv";
const listItemId = "saved_item_abcdefghijklmnopqrstuv";
const mediaId = "media_abcdefghijklmnopqrstuv";
const targetId = "save_target_abcdefghijklmnopqrstuv";

const watchLater = {
  capabilities: { delete: false, rename: false, reorder: true as const },
  createdAt: generatedAt,
  description: null,
  id: listId,
  itemCount: 1,
  kind: "watch_later" as const,
  name: "Watch Later",
  revision: 3,
  updatedAt: generatedAt,
};

const customList = {
  capabilities: { delete: true, rename: true, reorder: true as const },
  createdAt: generatedAt,
  description: "A quiet Friday-night queue.",
  id: customListId,
  itemCount: 1,
  kind: "custom" as const,
  name: "Weekend",
  revision: 7,
  updatedAt: generatedAt,
};

const ownedCatalogItem = {
  artwork: {
    accentColor: "#315a72",
    backdropPath: `/v1/saved/catalog/${catalogId}/images/backdrop`,
    blurHash: null,
    posterPath: `/v1/saved/catalog/${catalogId}/images/poster`,
  },
  availability: "owned" as const,
  favorite: { state: "synced" as const, value: true },
  id: catalogId,
  kind: "movie" as const,
  libraryReferenceId: mediaId,
  overview: "A bounded normalized snapshot retained for a private saved item.",
  resolutionState: "current" as const,
  title: "Northern Lights",
  year: 2026,
};

const membership = {
  addedAt: generatedAt,
  catalog: ownedCatalogItem,
  id: listItemId,
  position: 0,
};

describe("saved-list contracts", () => {
  it("keeps Watch Later distinct from bounded private custom lists", () => {
    const response = savedListsResponseSchema.parse({
      generatedAt,
      lists: [customList],
      nextCursor: null,
      watchLater,
    });

    expect(response.watchLater.capabilities).toEqual({
      delete: false,
      rename: false,
      reorder: true,
    });
    expect(response.lists[0]?.kind).toBe("custom");
    expect(
      savedListsResponseSchema.safeParse({
        ...response,
        lists: [{ ...customList, id: listId }],
      }).success,
    ).toBe(false);
    expect(
      savedListsResponseSchema.safeParse({
        ...response,
        watchLater: { ...watchLater, capabilities: customList.capabilities },
      }).success,
    ).toBe(false);
  });

  it("bounds list creation, updates, and pagination", () => {
    expect(savedListCreateRequestSchema.parse({ name: "  Persian cinema  " })).toEqual({
      description: null,
      name: "Persian cinema",
    });
    expect(savedListUpdateRequestSchema.parse({ description: null })).toEqual({
      description: null,
    });
    expect(savedListUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(savedListCreateRequestSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(savedListsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(savedListsQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(savedListsQuerySchema.safeParse({ limit: SAVED_LIST_PAGE_MAX_ITEMS + 1 }).success).toBe(
      false,
    );
  });

  it("normalizes owned, requestable, and recoverably unavailable titles", () => {
    expect(savedCatalogItemSchema.parse(ownedCatalogItem).favorite.value).toBe(true);

    const requestable = {
      ...ownedCatalogItem,
      availability: "requestable" as const,
      favorite: { state: "not_applicable" as const, value: null },
      libraryReferenceId: null,
    };
    expect(savedCatalogItemSchema.parse(requestable).availability).toBe("requestable");

    expect(
      savedCatalogItemSchema.parse({
        ...requestable,
        availability: "unavailable",
        resolutionState: "missing",
      }).resolutionState,
    ).toBe("missing");
    expect(
      savedCatalogItemSchema.safeParse({
        ...requestable,
        availability: "requestable",
        resolutionState: "missing",
      }).success,
    ).toBe(false);
    expect(
      savedCatalogItemSchema.safeParse({
        ...requestable,
        libraryReferenceId: mediaId,
      }).success,
    ).toBe(false);
  });

  it("binds artwork to the same opaque catalog reference", () => {
    expect(
      savedCatalogItemSchema.safeParse({
        ...ownedCatalogItem,
        artwork: {
          ...ownedCatalogItem.artwork,
          posterPath: "/v1/saved/catalog/catalog_zyxwvutsrqponmlkjihgfe/images/poster",
        },
      }).success,
    ).toBe(false);
    expect(
      savedCatalogItemSchema.safeParse({
        ...ownedCatalogItem,
        tmdbId: 550,
      }).success,
    ).toBe(false);
  });

  it("represents degraded reconciliation without dropping private memberships", () => {
    const response = savedListItemsResponseSchema.parse({
      generatedAt,
      items: [membership],
      list: watchLater,
      nextCursor: null,
      reconciliation: {
        failures: [
          {
            code: "unreachable",
            message: "Jellyfin is temporarily unavailable.",
            occurredAt: generatedAt,
            operation: "saved.reconcile",
            retryable: true,
            service: "jellyfin",
          },
        ],
        state: "degraded",
      },
    });

    expect(response.items).toHaveLength(1);
    expect(response.reconciliation.state).toBe("degraded");
    expect(
      savedListItemsResponseSchema.safeParse({
        ...response,
        reconciliation: { failures: [], state: "degraded" },
      }).success,
    ).toBe(false);
    expect(
      savedListItemsResponseSchema.safeParse({
        ...response,
        items: [membership, { ...membership, id: "saved_item_zyxwvutsrqponmlkjihgfe" }],
      }).success,
    ).toBe(false);
  });

  it("keeps membership writes idempotent and closed", () => {
    expect(savedListMembershipRequestSchema.parse({ targetReferenceId: targetId })).toEqual({
      targetReferenceId: targetId,
    });
    expect(savedListMembershipRequestSchema.safeParse({ request: true }).success).toBe(false);
    expect(
      savedListMembershipResponseSchema.parse({
        created: false,
        item: membership,
        listId,
        revision: 3,
      }).created,
    ).toBe(false);
    expect(
      savedListMembershipDeleteResponseSchema.parse({
        catalogReferenceId: catalogId,
        listId,
        removed: true,
        revision: 4,
      }).removed,
    ).toBe(true);
  });

  it("bounds and de-duplicates optimistic reorder windows", () => {
    const secondId = "saved_item_zyxwvutsrqponmlkjihgfe";
    const request = savedListReorderRequestSchema.parse({
      orderedItemIds: [secondId, listItemId],
      startPosition: 0,
    });
    expect(savedListReorderResponseSchema.parse({ ...request, revision: 8 })).toMatchObject({
      revision: 8,
    });
    expect(
      savedListReorderRequestSchema.safeParse({
        orderedItemIds: [listItemId, listItemId],
        startPosition: 0,
      }).success,
    ).toBe(false);
    expect(
      savedListReorderRequestSchema.safeParse({
        orderedItemIds: Array.from(
          { length: SAVED_LIST_REORDER_MAX_ITEMS + 1 },
          (_, index) => `saved_item_${index.toString().padStart(22, "a")}`,
        ),
        startPosition: 0,
      }).success,
    ).toBe(false);
    expect(
      savedListReorderRequestSchema.safeParse({
        orderedItemIds: [listItemId, secondId],
        startPosition: SAVED_LIST_MAX_ITEMS - 1,
      }).success,
    ).toBe(false);
  });

  it("models bounded deletion undo and explicit Jellyfin favorites", () => {
    expect(
      savedListDeleteResponseSchema.parse({
        deletedAt: generatedAt,
        listId: customListId,
        revision: 8,
        undoExpiresAt: "2026-08-04T08:00:30.000Z",
      }).listId,
    ).toBe(customListId);
    expect(
      savedListDeleteResponseSchema.safeParse({
        deletedAt: generatedAt,
        listId: customListId,
        revision: 8,
        undoExpiresAt: generatedAt,
      }).success,
    ).toBe(false);
    expect(savedFavoriteMutationRequestSchema.parse({ favorite: true })).toEqual({
      favorite: true,
    });
    expect(
      savedFavoriteMutationResponseSchema.parse({
        favorite: false,
        synchronizedAt: generatedAt,
        targetReferenceId: targetId,
      }).favorite,
    ).toBe(false);
    expect(
      savedMembershipSummarySchema.parse({
        catalogReferenceId: catalogId,
        customListCount: 2,
        expiresAt: "2026-08-04T08:15:00.000Z",
        favorite: { state: "synced", value: false },
        issuedAt: generatedAt,
        targetReferenceId: targetId,
        watchLater: true,
      }).watchLater,
    ).toBe(true);
  });

  it("exports closed HTTP schemas", () => {
    expect(savedListItemsResponseJsonSchema).not.toHaveProperty("$schema");
    expect(savedFavoriteMutationRequestJsonSchema).not.toHaveProperty("$schema");
    expect(JSON.stringify(savedFavoriteMutationRequestJsonSchema)).toContain(
      "additionalProperties",
    );
  });

  it("rejects oversized pages before they can reach storage", () => {
    expect(
      savedListItemsQuerySchema.safeParse({ limit: SAVED_LIST_PAGE_MAX_ITEMS + 1 }).success,
    ).toBe(false);
  });
});
