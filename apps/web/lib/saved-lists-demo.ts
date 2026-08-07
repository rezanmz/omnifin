import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  SavedListItemsResponse,
  SavedListsResponse,
  SavedListSummary,
} from "@omnifin/contracts/saved";

import {
  savedListsClient,
  type SavedListsClient,
  type SavedWorkspaceLoadOutcome,
} from "./saved-lists";

const generatedAt = "2026-08-04T11:00:00.000Z";
const watchLaterId = `saved_list_${"l".repeat(22)}`;
const weekendId = `saved_list_${"w".repeat(22)}`;
const csrfToken = "saved_demo_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-09-04T11:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Mina",
  externalIdentity: {
    displayClaims: { displayName: "Mina" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "mina-subject",
  },
  inactivityExpiresAt: "2026-08-04T12:00:00.000Z",
  issuedAt: generatedAt,
  linkedServices: [
    {
      displayName: "Living Room Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: generatedAt,
      linkedAt: generatedAt,
      service: "jellyfin",
      username: "mina",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.viewer],
  role: "viewer",
  sessionId: "saved-demo-session",
  userId: "saved-demo-user",
};

const watchLater: SavedListSummary = {
  capabilities: { delete: false, rename: false, reorder: true },
  createdAt: generatedAt,
  description: null,
  id: watchLaterId,
  itemCount: 4,
  kind: "watch_later",
  name: "Watch Later",
  revision: 4,
  updatedAt: generatedAt,
};

const weekend: SavedListSummary = {
  capabilities: { delete: true, rename: true, reorder: true },
  createdAt: generatedAt,
  description: "Quiet films for Friday night.",
  id: weekendId,
  itemCount: 2,
  kind: "custom",
  name: "Weekend",
  revision: 2,
  updatedAt: generatedAt,
};

export const demoSavedLists: SavedListsResponse = {
  generatedAt,
  lists: [weekend],
  nextCursor: null,
  watchLater,
};

function ownedItem(
  character: string,
  input: { accent: string; kind?: "movie" | "series"; title: string; year: number },
): SavedListItemsResponse["items"][number] {
  return {
    addedAt: generatedAt,
    catalog: {
      artwork: {
        accentColor: input.accent,
        backdropPath: null,
        blurHash: null,
        posterPath: null,
      },
      availability: "owned",
      favorite: { state: "synced", value: false },
      id: `catalog_${character.repeat(22)}`,
      kind: input.kind ?? "movie",
      libraryReferenceId: `media_${character.repeat(22)}`,
      overview: null,
      resolutionState: "current",
      title: input.title,
      year: input.year,
    },
    id: `saved_item_${character.repeat(22)}`,
    position: character.codePointAt(0)! - "a".codePointAt(0)!,
  };
}

export const readySavedPage = {
  data: {
    generatedAt,
    items: [
      ownedItem("a", { accent: "#bd745c", title: "Ember Coast", year: 2026 }),
      ownedItem("b", {
        accent: "#758cc7",
        kind: "series",
        title: "Northern Lights",
        year: 2025,
      }),
      ownedItem("c", { accent: "#a9825d", title: "The Far Meridian", year: 2024 }),
      ownedItem("d", { accent: "#667f73", title: "Stillwater Signal", year: 2026 }),
    ],
    list: watchLater,
    nextCursor: null,
    reconciliation: { failures: [], state: "current" },
  } satisfies SavedListItemsResponse,
  etag: `"saved_${"e".repeat(22)}"`,
};

export const emptySavedPage = {
  data: {
    ...readySavedPage.data,
    items: [],
    list: { ...watchLater, itemCount: 0 },
  } satisfies SavedListItemsResponse,
  etag: `"saved_${"z".repeat(22)}"`,
};

export const readySavedOutcome: Extract<SavedWorkspaceLoadOutcome, { status: "ready" }> = {
  snapshot: { csrfToken, lists: demoSavedLists, principal },
  status: "ready",
};

export const savedListsDemoClient: SavedListsClient = {
  ...savedListsClient,
  async createList(input) {
    const list: SavedListSummary = {
      ...weekend,
      description: input.description,
      id: `saved_list_${"n".repeat(22)}`,
      itemCount: 0,
      name: input.name,
      revision: 0,
    };
    return { data: { list }, etag: `"saved_${"n".repeat(22)}"`, replayed: false };
  },
  async list() {
    return demoSavedLists;
  },
  async listItems(listId) {
    if (listId === watchLaterId) return readySavedPage;
    return {
      data: {
        ...emptySavedPage.data,
        list: { ...weekend, id: listId, itemCount: 0 },
      },
      etag: `"saved_${"z".repeat(22)}"`,
    };
  },
  async load() {
    return readySavedOutcome;
  },
  async removeItem(listId, catalogReferenceId) {
    return {
      data: { catalogReferenceId, listId, removed: true, revision: watchLater.revision + 1 },
      etag: `"saved_${"r".repeat(22)}"`,
    };
  },
};
