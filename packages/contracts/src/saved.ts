import { z } from "zod";

import { partialFailureSchema } from "./connectors.js";
import { mediaReferenceIdSchema } from "./dashboard.js";
import { idempotencyKeySchema } from "./requests.js";

export const SAVED_CUSTOM_LIST_MAX_COUNT = 50;
export const SAVED_LIST_MAX_ITEMS = 500;
export const SAVED_LIST_PAGE_MAX_ITEMS = 50;
export const SAVED_LIST_REORDER_MAX_ITEMS = 100;
export const SAVED_LIST_NAME_MAX_LENGTH = 80;
export const SAVED_LIST_DESCRIPTION_MAX_LENGTH = 500;

const timestampSchema = z.iso.datetime({ offset: true });
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));

export const savedListIdSchema = z.string().regex(/^saved_list_[A-Za-z0-9_-]{22}$/u);
export const savedListItemIdSchema = z.string().regex(/^saved_item_[A-Za-z0-9_-]{22}$/u);
export const savedCatalogReferenceIdSchema = z.string().regex(/^catalog_[A-Za-z0-9_-]{22}$/u);
export const savedTargetReferenceIdSchema = z.string().regex(/^save_target_[A-Za-z0-9_-]{22}$/u);
export const savedListCursorSchema = z
  .string()
  .min(16)
  .max(1_024)
  .regex(/^[A-Za-z0-9_.-]+$/u);
export const savedListRevisionSchema = z.int().nonnegative().max(2_147_483_647);
export const savedListIdempotencyKeySchema = idempotencyKeySchema;
export type SavedListIdempotencyKey = z.infer<typeof savedListIdempotencyKeySchema>;

export const savedListKindSchema = z.enum(["watch_later", "custom"]);
export type SavedListKind = z.infer<typeof savedListKindSchema>;

export const savedListSummarySchema = z
  .strictObject({
    capabilities: z.strictObject({
      delete: z.boolean(),
      rename: z.boolean(),
      reorder: z.literal(true),
    }),
    createdAt: timestampSchema,
    description: safeTextSchema.max(SAVED_LIST_DESCRIPTION_MAX_LENGTH).nullable(),
    id: savedListIdSchema,
    itemCount: z.int().nonnegative().max(SAVED_LIST_MAX_ITEMS),
    kind: savedListKindSchema,
    name: safeTextSchema.max(SAVED_LIST_NAME_MAX_LENGTH),
    revision: savedListRevisionSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((list, context) => {
    const isCustom = list.kind === "custom";
    if (list.capabilities.delete !== isCustom || list.capabilities.rename !== isCustom) {
      context.addIssue({
        code: "custom",
        message: "Only custom saved lists can be renamed or deleted.",
        path: ["capabilities"],
      });
    }
    if (Date.parse(list.updatedAt) < Date.parse(list.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "A saved list cannot be updated before it is created.",
        path: ["updatedAt"],
      });
    }
  });
export type SavedListSummary = z.infer<typeof savedListSummarySchema>;

export const savedListsQuerySchema = z.strictObject({
  cursor: savedListCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(SAVED_LIST_PAGE_MAX_ITEMS).default(20),
});
export type SavedListsQuery = z.infer<typeof savedListsQuerySchema>;

export const savedListsResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    lists: z.array(savedListSummarySchema).max(SAVED_LIST_PAGE_MAX_ITEMS),
    nextCursor: savedListCursorSchema.nullable(),
    watchLater: savedListSummarySchema,
  })
  .superRefine((response, context) => {
    if (response.watchLater.kind !== "watch_later") {
      context.addIssue({
        code: "custom",
        message: "The dedicated Watch Later record must use the watch_later kind.",
        path: ["watchLater", "kind"],
      });
    }
    const ids = new Set([response.watchLater.id]);
    for (const [index, list] of response.lists.entries()) {
      if (list.kind !== "custom") {
        context.addIssue({
          code: "custom",
          message: "Paginated personal lists must use the custom kind.",
          path: ["lists", index, "kind"],
        });
      }
      if (ids.has(list.id)) {
        context.addIssue({
          code: "custom",
          message: "Saved list identifiers must be unique within a response.",
          path: ["lists", index, "id"],
        });
      }
      ids.add(list.id);
    }
  });
export type SavedListsResponse = z.infer<typeof savedListsResponseSchema>;

export const savedListCreateRequestSchema = z.strictObject({
  description: safeTextSchema.max(SAVED_LIST_DESCRIPTION_MAX_LENGTH).nullable().default(null),
  name: safeTextSchema.max(SAVED_LIST_NAME_MAX_LENGTH),
});
export type SavedListCreateRequest = z.infer<typeof savedListCreateRequestSchema>;

export const savedListUpdateRequestSchema = z
  .strictObject({
    description: safeTextSchema.max(SAVED_LIST_DESCRIPTION_MAX_LENGTH).nullable().optional(),
    name: safeTextSchema.max(SAVED_LIST_NAME_MAX_LENGTH).optional(),
  })
  .refine((request) => request.description !== undefined || request.name !== undefined, {
    message: "At least one editable saved-list field is required.",
  });
export type SavedListUpdateRequest = z.infer<typeof savedListUpdateRequestSchema>;

export const savedListMutationResponseSchema = z.strictObject({
  list: savedListSummarySchema,
});
export type SavedListMutationResponse = z.infer<typeof savedListMutationResponseSchema>;

export const savedListDeleteResponseSchema = z
  .strictObject({
    deletedAt: timestampSchema,
    listId: savedListIdSchema,
    revision: savedListRevisionSchema,
    undoExpiresAt: timestampSchema,
  })
  .refine((response) => Date.parse(response.undoExpiresAt) > Date.parse(response.deletedAt), {
    message: "Saved-list undo must expire after deletion.",
    path: ["undoExpiresAt"],
  });
export type SavedListDeleteResponse = z.infer<typeof savedListDeleteResponseSchema>;

export const savedListRestoreRequestSchema = z.strictObject({});
export type SavedListRestoreRequest = z.infer<typeof savedListRestoreRequestSchema>;

export const savedCatalogAvailabilitySchema = z.enum([
  "owned",
  "requestable",
  "requested",
  "unavailable",
]);
export type SavedCatalogAvailability = z.infer<typeof savedCatalogAvailabilitySchema>;

export const savedCatalogResolutionStateSchema = z.enum([
  "current",
  "connector_unavailable",
  "missing",
  "relink_required",
]);
export type SavedCatalogResolutionState = z.infer<typeof savedCatalogResolutionStateSchema>;

export const savedFavoriteStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("synced"), value: z.boolean() }),
  z.strictObject({ state: z.literal("unavailable"), value: z.boolean().nullable() }),
  z.strictObject({ state: z.literal("not_applicable"), value: z.null() }),
]);
export type SavedFavoriteState = z.infer<typeof savedFavoriteStateSchema>;

const savedArtworkPathSchema = z
  .string()
  .max(512)
  .regex(/^\/v1\/saved\/catalog\/catalog_[A-Za-z0-9_-]{22}\/images\/(?:backdrop|poster)$/u)
  .nullable();

export const savedCatalogItemSchema = z
  .strictObject({
    artwork: z.strictObject({
      accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/u)
        .nullable(),
      backdropPath: savedArtworkPathSchema,
      blurHash: z.string().max(256).nullable(),
      posterPath: savedArtworkPathSchema,
    }),
    availability: savedCatalogAvailabilitySchema,
    favorite: savedFavoriteStateSchema,
    id: savedCatalogReferenceIdSchema,
    kind: z.enum(["movie", "series"]),
    libraryReferenceId: mediaReferenceIdSchema.nullable(),
    overview: safeTextSchema.max(2_000).nullable(),
    resolutionState: savedCatalogResolutionStateSchema,
    title: safeTextSchema.max(300),
    year: z.int().min(1870).max(2200).nullable(),
  })
  .superRefine((item, context) => {
    const expectedArtworkPrefix = `/v1/saved/catalog/${item.id}/images/`;
    for (const [key, path] of Object.entries({
      backdropPath: item.artwork.backdropPath,
      posterPath: item.artwork.posterPath,
    })) {
      if (path !== null && !path.startsWith(expectedArtworkPrefix)) {
        context.addIssue({
          code: "custom",
          message: "Saved artwork must belong to the same opaque catalog reference.",
          path: ["artwork", key],
        });
      }
    }

    if (item.resolutionState === "current" && item.availability === "owned") {
      if (item.libraryReferenceId === null || item.favorite.state !== "synced") {
        context.addIssue({
          code: "custom",
          message:
            "A current owned title requires a library reference and synchronized favorite state.",
          path: ["libraryReferenceId"],
        });
      }
    }
    if (item.availability !== "owned") {
      if (item.libraryReferenceId !== null || item.favorite.state !== "not_applicable") {
        context.addIssue({
          code: "custom",
          message: "Only owned titles can expose a library reference or Jellyfin favorite state.",
          path: ["availability"],
        });
      }
    }
    if (item.resolutionState === "missing" && item.availability !== "unavailable") {
      context.addIssue({
        code: "custom",
        message: "A missing saved title must be reported as unavailable.",
        path: ["availability"],
      });
    }
    if (
      item.resolutionState !== "current" &&
      item.availability === "owned" &&
      item.favorite.state === "synced"
    ) {
      context.addIssue({
        code: "custom",
        message: "Degraded owned titles cannot claim freshly synchronized favorite state.",
        path: ["favorite", "state"],
      });
    }
  });
export type SavedCatalogItem = z.infer<typeof savedCatalogItemSchema>;

export const savedListItemSchema = z.strictObject({
  addedAt: timestampSchema,
  catalog: savedCatalogItemSchema,
  id: savedListItemIdSchema,
  position: z
    .int()
    .nonnegative()
    .max(SAVED_LIST_MAX_ITEMS - 1),
});
export type SavedListItem = z.infer<typeof savedListItemSchema>;

export const savedListAvailabilityFilterSchema = z.enum([
  "all",
  "owned",
  "requestable",
  "requested",
  "unavailable",
]);
export type SavedListAvailabilityFilter = z.infer<typeof savedListAvailabilityFilterSchema>;

export const savedListItemSortSchema = z.enum(["manual", "added_desc", "title"]);
export type SavedListItemSort = z.infer<typeof savedListItemSortSchema>;

export const savedListItemsQuerySchema = z.strictObject({
  availability: savedListAvailabilityFilterSchema.default("all"),
  cursor: savedListCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(SAVED_LIST_PAGE_MAX_ITEMS).default(30),
  query: safeTextSchema.max(100).optional(),
  sort: savedListItemSortSchema.default("manual"),
});
export type SavedListItemsQuery = z.infer<typeof savedListItemsQuerySchema>;

export const savedListReconciliationSchema = z
  .strictObject({
    failures: z.array(partialFailureSchema).max(2),
    state: z.enum(["current", "degraded"]),
  })
  .superRefine((reconciliation, context) => {
    if ((reconciliation.state === "current") !== (reconciliation.failures.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Degraded saved-list reconciliation must include a safe connector failure.",
        path: ["failures"],
      });
    }
    const services = new Set<string>();
    for (const [index, failure] of reconciliation.failures.entries()) {
      if (failure.service !== "jellyfin" && failure.service !== "seerr") {
        context.addIssue({
          code: "custom",
          message: "Saved-list reconciliation failures can identify only Jellyfin or Seerr.",
          path: ["failures", index, "service"],
        });
      }
      if (services.has(failure.service)) {
        context.addIssue({
          code: "custom",
          message: "Saved-list reconciliation can include one failure per connector service.",
          path: ["failures", index, "service"],
        });
      }
      services.add(failure.service);
    }
  });
export type SavedListReconciliation = z.infer<typeof savedListReconciliationSchema>;

export const savedListItemsResponseSchema = z
  .strictObject({
    generatedAt: timestampSchema,
    items: z.array(savedListItemSchema).max(SAVED_LIST_PAGE_MAX_ITEMS),
    list: savedListSummarySchema,
    nextCursor: savedListCursorSchema.nullable(),
    reconciliation: savedListReconciliationSchema,
  })
  .superRefine((response, context) => {
    const itemIds = new Set<string>();
    const catalogIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (itemIds.has(item.id) || catalogIds.has(item.catalog.id)) {
        context.addIssue({
          code: "custom",
          message: "Saved-list pages cannot contain duplicate memberships or catalog titles.",
          path: ["items", index, "id"],
        });
      }
      itemIds.add(item.id);
      catalogIds.add(item.catalog.id);
    }
  });
export type SavedListItemsResponse = z.infer<typeof savedListItemsResponseSchema>;

export const savedListMembershipRequestSchema = z.strictObject({
  targetReferenceId: savedTargetReferenceIdSchema,
});
export type SavedListMembershipRequest = z.infer<typeof savedListMembershipRequestSchema>;

export const savedListMembershipResponseSchema = z.strictObject({
  created: z.boolean(),
  item: savedListItemSchema,
  listId: savedListIdSchema,
  revision: savedListRevisionSchema,
});
export type SavedListMembershipResponse = z.infer<typeof savedListMembershipResponseSchema>;

export const savedListMembershipDeleteResponseSchema = z.strictObject({
  catalogReferenceId: savedCatalogReferenceIdSchema,
  listId: savedListIdSchema,
  removed: z.boolean(),
  revision: savedListRevisionSchema,
});
export type SavedListMembershipDeleteResponse = z.infer<
  typeof savedListMembershipDeleteResponseSchema
>;

function validateReorderWindow(
  request: { orderedItemIds: string[]; startPosition: number },
  context: z.RefinementCtx,
) {
  if (new Set(request.orderedItemIds).size !== request.orderedItemIds.length) {
    context.addIssue({
      code: "custom",
      message: "A saved-list reorder window cannot contain duplicate memberships.",
      path: ["orderedItemIds"],
    });
  }
  if (request.startPosition + request.orderedItemIds.length > SAVED_LIST_MAX_ITEMS) {
    context.addIssue({
      code: "custom",
      message: "A saved-list reorder window cannot exceed the list capacity.",
      path: ["startPosition"],
    });
  }
}

export const savedListReorderRequestSchema = z
  .strictObject({
    orderedItemIds: z.array(savedListItemIdSchema).min(2).max(SAVED_LIST_REORDER_MAX_ITEMS),
    startPosition: z
      .int()
      .nonnegative()
      .max(SAVED_LIST_MAX_ITEMS - 1),
  })
  .superRefine(validateReorderWindow);
export type SavedListReorderRequest = z.infer<typeof savedListReorderRequestSchema>;

export const savedListReorderResponseSchema = z
  .strictObject({
    orderedItemIds: z.array(savedListItemIdSchema).min(2).max(SAVED_LIST_REORDER_MAX_ITEMS),
    revision: savedListRevisionSchema,
    startPosition: z
      .int()
      .nonnegative()
      .max(SAVED_LIST_MAX_ITEMS - 1),
  })
  .superRefine(validateReorderWindow);
export type SavedListReorderResponse = z.infer<typeof savedListReorderResponseSchema>;

export const savedFavoriteMutationRequestSchema = z.strictObject({
  favorite: z.boolean(),
});
export type SavedFavoriteMutationRequest = z.infer<typeof savedFavoriteMutationRequestSchema>;

export const savedFavoriteMutationResponseSchema = z.strictObject({
  favorite: z.boolean(),
  synchronizedAt: timestampSchema,
  targetReferenceId: savedTargetReferenceIdSchema,
});
export type SavedFavoriteMutationResponse = z.infer<typeof savedFavoriteMutationResponseSchema>;

export const savedMembershipSummarySchema = z
  .strictObject({
    catalogReferenceId: savedCatalogReferenceIdSchema.nullable(),
    customListCount: z.int().nonnegative().max(SAVED_CUSTOM_LIST_MAX_COUNT),
    customListIds: z
      .array(savedListIdSchema)
      .max(SAVED_CUSTOM_LIST_MAX_COUNT)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Saved custom-list memberships must be unique.",
      }),
    expiresAt: timestampSchema,
    favorite: savedFavoriteStateSchema,
    issuedAt: timestampSchema,
    targetReferenceId: savedTargetReferenceIdSchema,
    watchLater: z.boolean(),
  })
  .superRefine((summary, context) => {
    if (Date.parse(summary.expiresAt) <= Date.parse(summary.issuedAt)) {
      context.addIssue({
        code: "custom",
        message: "A save target must expire after it is issued.",
        path: ["expiresAt"],
      });
    }
    if (
      summary.catalogReferenceId === null &&
      (summary.watchLater || summary.customListCount > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Saved memberships require a stable opaque catalog reference.",
        path: ["catalogReferenceId"],
      });
    }
    if (summary.customListCount !== summary.customListIds.length) {
      context.addIssue({
        code: "custom",
        message: "Saved custom-list membership count must match its opaque references.",
        path: ["customListCount"],
      });
    }
  });
export type SavedMembershipSummary = z.infer<typeof savedMembershipSummarySchema>;

export const savedOwnedTargetIssueRequestSchema = z.strictObject({});
export type SavedOwnedTargetIssueRequest = z.infer<typeof savedOwnedTargetIssueRequestSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const savedListsQueryJsonSchema = withoutSchemaDialect(savedListsQuerySchema);
export const savedListsResponseJsonSchema = withoutSchemaDialect(savedListsResponseSchema);
export const savedListCreateRequestJsonSchema = withoutSchemaDialect(savedListCreateRequestSchema);
export const savedListUpdateRequestJsonSchema = withoutSchemaDialect(savedListUpdateRequestSchema);
export const savedListMutationResponseJsonSchema = withoutSchemaDialect(
  savedListMutationResponseSchema,
);
export const savedListDeleteResponseJsonSchema = withoutSchemaDialect(
  savedListDeleteResponseSchema,
);
export const savedListRestoreRequestJsonSchema = withoutSchemaDialect(
  savedListRestoreRequestSchema,
);
export const savedListItemsQueryJsonSchema = withoutSchemaDialect(savedListItemsQuerySchema);
export const savedListItemsResponseJsonSchema = withoutSchemaDialect(savedListItemsResponseSchema);
export const savedListMembershipRequestJsonSchema = withoutSchemaDialect(
  savedListMembershipRequestSchema,
);
export const savedListMembershipResponseJsonSchema = withoutSchemaDialect(
  savedListMembershipResponseSchema,
);
export const savedListMembershipDeleteResponseJsonSchema = withoutSchemaDialect(
  savedListMembershipDeleteResponseSchema,
);
export const savedListReorderRequestJsonSchema = withoutSchemaDialect(
  savedListReorderRequestSchema,
);
export const savedListReorderResponseJsonSchema = withoutSchemaDialect(
  savedListReorderResponseSchema,
);
export const savedFavoriteMutationRequestJsonSchema = withoutSchemaDialect(
  savedFavoriteMutationRequestSchema,
);
export const savedFavoriteMutationResponseJsonSchema = withoutSchemaDialect(
  savedFavoriteMutationResponseSchema,
);
export const savedMembershipSummaryJsonSchema = withoutSchemaDialect(savedMembershipSummarySchema);
export const savedOwnedTargetIssueRequestJsonSchema = withoutSchemaDialect(
  savedOwnedTargetIssueRequestSchema,
);
