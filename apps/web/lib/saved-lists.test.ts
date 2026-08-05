import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  SavedListItemsResponse,
  SavedListMutationResponse,
  SavedListsResponse,
  SavedMembershipSummary,
} from "@omnifin/contracts/saved";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SavedListsClientError,
  browserSavedArtworkPath,
  createSavedListIdempotencyKey,
  savedListsClient,
} from "./saved-lists";

const csrfToken = "saved_lists_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const listId = `saved_list_${"l".repeat(22)}`;
const customListId = `saved_list_${"u".repeat(22)}`;
const catalogId = `catalog_${"c".repeat(22)}`;
const targetId = `save_target_${"t".repeat(22)}`;
const mediaId = `media_${"m".repeat(22)}`;
const itemId = `saved_item_${"i".repeat(22)}`;
const etag = `"saved_${"e".repeat(22)}"`;
const now = "2026-08-04T11:00:00.000Z";

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
  issuedAt: now,
  linkedServices: [
    {
      displayName: "Home Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: now,
      linkedAt: "2026-08-01T11:00:00.000Z",
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
  id: listId,
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

const savedItems: SavedListItemsResponse = {
  generatedAt: now,
  items: [
    {
      addedAt: now,
      catalog: {
        artwork: {
          accentColor: "#336699",
          backdropPath: `/v1/saved/catalog/${catalogId}/images/backdrop`,
          blurHash: null,
          posterPath: `/v1/saved/catalog/${catalogId}/images/poster`,
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

const target: SavedMembershipSummary = {
  catalogReferenceId: catalogId,
  customListCount: 0,
  customListIds: [],
  expiresAt: "2026-08-04T11:15:00.000Z",
  favorite: { state: "synced", value: true },
  issuedAt: now,
  targetReferenceId: targetId,
  watchLater: true,
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function apiError(code: string, message = "The private-list request failed safely.") {
  return { error: { code, message, requestId: "saved-test-request" } };
}

describe("savedListsClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a permitted local session before its private lists", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken, principal }))
      .mockResolvedValueOnce(response(lists));
    vi.stubGlobal("fetch", fetch);

    await expect(savedListsClient.load()).resolves.toEqual({
      snapshot: { csrfToken, lists, principal },
      status: "ready",
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/saved/lists?limit=50",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("fails closed for signed-out, unprivileged, and unreadable sessions", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(
        response({ csrfToken, principal: { ...principal, permissions: ["media.view"] } }),
      )
      .mockResolvedValueOnce(response({ csrfToken, principal: { raw: "unsafe" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(savedListsClient.load()).resolves.toEqual({ status: "signed_out" });
    await expect(savedListsClient.load()).resolves.toEqual({ status: "forbidden" });
    await expect(savedListsClient.load()).resolves.toEqual({ status: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("loads versioned list items and rewrites only bounded saved artwork paths", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(savedItems, 200, { etag }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      savedListsClient.listItems(listId, {
        availability: "owned",
        limit: 30,
        query: "  Meridian  ",
        sort: "title",
      }),
    ).resolves.toMatchObject({
      data: {
        items: [
          {
            catalog: {
              artwork: {
                backdropPath: `/api/saved/catalog/${catalogId}/images/backdrop`,
                posterPath: `/api/saved/catalog/${catalogId}/images/poster`,
              },
            },
          },
        ],
      },
      etag,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/saved/lists/${listId}/items?availability=owned&limit=30&sort=title&query=Meridian`,
    );
    expect(() => browserSavedArtworkPath("https://upstream.example/private.jpg")).toThrow(
      SavedListsClientError,
    );
  });

  it("sends CSRF, ETag, and idempotency proofs only in headers", async () => {
    const mutation: SavedListMutationResponse = { list: customList };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(mutation, 201, { etag, "idempotency-replayed": "false" }))
      .mockResolvedValueOnce(response(target, 201))
      .mockResolvedValueOnce(response(target, 201))
      .mockResolvedValueOnce(
        response({ favorite: false, synchronizedAt: now, targetReferenceId: targetId }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      savedListsClient.createList(
        { description: customList.description, name: customList.name },
        { csrfToken, idempotencyKey: "saved-create-weekend-0001" },
      ),
    ).resolves.toMatchObject({ data: mutation, etag, replayed: false });
    await expect(savedListsClient.issueLibraryTarget(mediaId, { csrfToken })).resolves.toEqual(
      target,
    );
    await expect(
      savedListsClient.issueDiscoveryTarget(
        { kind: "movie", language: "en-CA", tmdbId: 603 },
        { csrfToken },
      ),
    ).resolves.toEqual(target);
    await expect(
      savedListsClient.updateFavorite(
        targetId,
        { favorite: false },
        { csrfToken, idempotencyKey: "saved-favorite-0001" },
      ),
    ).resolves.toMatchObject({ favorite: false });

    const [createUrl, createInit] = fetch.mock.calls[0]!;
    expect(createUrl).toBe("/api/saved/lists");
    expect(String(createUrl)).not.toContain(csrfToken);
    expect(createInit.headers).toMatchObject({
      "idempotency-key": "saved-create-weekend-0001",
      "x-omnifin-csrf": csrfToken,
    });
    const [targetUrl, targetInit] = fetch.mock.calls[1]!;
    expect(targetUrl).toBe(`/api/saved/targets/library/${mediaId}`);
    expect(targetInit).toMatchObject({ body: "{}", method: "POST" });
    const [discoveryTargetUrl, discoveryTargetInit] = fetch.mock.calls[2]!;
    expect(discoveryTargetUrl).toBe("/api/saved/targets/discovery");
    expect(discoveryTargetInit).toMatchObject({
      body: JSON.stringify({ kind: "movie", language: "en-CA", tmdbId: 603 }),
      method: "POST",
    });
    expect(fetch.mock.calls[3]?.[1].headers).toMatchObject({
      "idempotency-key": "saved-favorite-0001",
      "x-omnifin-csrf": csrfToken,
    });
  });

  it("requires local retry and concurrency proofs before a mutation is sent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      savedListsClient.createList({ description: null, name: "Weekend" }, { csrfToken }),
    ).rejects.toMatchObject({ code: "idempotency_key_required", kind: "invalid_response" });
    await expect(
      savedListsClient.removeItem(listId, catalogId, { csrfToken }),
    ).rejects.toMatchObject({ kind: "precondition", retryMode: "refresh" });
    await expect(savedListsClient.readList(`saved_list_${"x".repeat(21)}`)).rejects.toMatchObject({
      code: "invalid_reference",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes membership without confusing it with media deletion", async () => {
    const deletion = { catalogReferenceId: catalogId, listId, removed: true, revision: 2 };
    const fetch = vi.fn().mockResolvedValueOnce(response(deletion, 200, { etag }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      savedListsClient.removeItem(listId, catalogId, { csrfToken, etag }),
    ).resolves.toEqual({ data: deletion, etag });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/saved/lists/${listId}/items/${catalogId}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls[0]?.[1].headers["if-match"]).toBe(etag);
  });

  it.each([
    [401, "authentication_required", "signed_out", "none"],
    [403, "saved_list_principal_unavailable", "forbidden", "none"],
    [404, "saved_list_not_found", "not_found", "refresh"],
    [410, "saved_target_expired", "expired", "refresh"],
    [412, "saved_list_revision_stale", "precondition", "refresh"],
    [428, "saved_list_precondition_required", "precondition", "refresh"],
    [409, "saved_list_operation_in_progress", "conflict", "same_key"],
    [409, "saved_favorite_operation_in_progress", "conflict", "same_key"],
    [409, "saved_reorder_window_changed", "conflict", "refresh"],
    [503, "saved_list_temporarily_unavailable", "unavailable", "same_key"],
    [400, "invalid_request", "invalid_response", "none"],
  ] as const)("maps HTTP %s / %s to %s", async (status, code, kind, retryMode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(apiError(code), status)));

    await expect(savedListsClient.list()).rejects.toMatchObject({ code, kind, retryMode });
  });

  it("preserves aborts, bounds network failures, and rejects missing ETags", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("private host")));
    await expect(savedListsClient.list()).rejects.toMatchObject({
      code: "service_unavailable",
      kind: "unavailable",
      retryMode: "same_key",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError")),
    );
    await expect(savedListsClient.list()).rejects.toMatchObject({ name: "AbortError" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(savedItems)));
    await expect(
      savedListsClient.listItems(listId, { availability: "all", limit: 30, sort: "manual" }),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });
  });

  it("creates a namespaced secure retry identifier", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-4def-8123-456789abcdef" });
    expect(createSavedListIdempotencyKey()).toBe("saved-01234567-89ab-4def-8123-456789abcdef");
  });
});
