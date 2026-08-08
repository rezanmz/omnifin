# Saved titles and private lists

Omnifin provides three intentionally separate personal actions:

- **Watch Later** is a permanent, private system list for owned or requestable movies and series.
- **Personal lists** are private, named, manually ordered collections owned by one Omnifin user.
- **Favorite** changes the paired Jellyfin user's favorite state for an owned title. Jellyfin remains
  the source of truth.

Saving never requests, downloads, deletes, marks watched, or changes a media file. Favorite and
Watch Later use distinct controls, labels, permissions, and audit actions.

## Authorization and privacy boundary

An active account receives `saved.lists.self.manage` and `favorites.self.manage` independently of
request-review and library-administration permissions. Pending-link and recovery sessions receive
neither permission. Favorite operations additionally require a healthy linked Jellyfin identity and
an owned title.

Every storage query starts with the authenticated Omnifin `user_id`. A reference that belongs to
another user is indistinguishable from a missing reference and returns the canonical `404` response.
Saved-list responses never expose native Jellyfin, Seerr, TMDB, TVDB, or IMDb identifiers,
connector URLs, filesystem paths, or connector credentials. Responses use `Cache-Control: private, no-store` and
`Vary: Cookie`; logs and metrics exclude list names, descriptions, media titles, reference tokens,
and query text.

Two opaque reference classes prevent accidental data disclosure and unbounded persistence:

- `save_target_*` is a short-lived, server-backed capability issued on demand from a Library,
  Discovery, Search, or detail control. It is bound to the current user, identity-link revision, normalized
  title identity, and expiry. It cannot select a connector, URL, or upstream identifier.
- `catalog_*` is a durable random reference created only after the user saves a title. It is scoped
  to that user and survives connector replacement or Jellyfin item replacement.

Save-target rows expire after 15 minutes and are replaced rather than accumulated when the same
user sees the same normalized title again. Expired targets return `410 save_target_expired`; the UI
refreshes the card before retrying. A durable catalog reference is never accepted as a save target.

## Limits

| Resource              |           Limit |
| --------------------- | --------------: |
| Custom lists per user |              50 |
| Items per list        |             500 |
| List name             |   80 characters |
| List description      |  500 characters |
| Read page             |      50 records |
| Reorder window        | 100 memberships |
| Search text           |  100 characters |

Limits are enforced in the HTTP contract, service, and database constraints. Watch Later does not
consume the custom-list quota. A user has exactly one Watch Later list, provisioned transactionally
on first use.

## HTTP contract

All routes are under `/v1`, require an active server-side session, and return only normalized
contracts from `@omnifin/contracts/saved`. State-changing routes require the canonical origin and
CSRF header. JSON bodies are closed and capped before parsing.

### Lists

| Method and path                        | Purpose                                                          | Concurrency and replay                                                  |
| -------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/saved/lists?cursor&limit`     | Return Watch Later separately and a cursor page of custom lists. | Private `no-store` read.                                                |
| `POST /v1/saved/lists`                 | Create a custom list.                                            | Requires `Idempotency-Key`; a replay returns the original `201` result. |
| `GET /v1/saved/lists/:listId`          | Return one list summary.                                         | Returns a strong opaque `ETag`.                                         |
| `PATCH /v1/saved/lists/:listId`        | Rename or change the description of a custom list.               | Requires the exact prior `If-Match`.                                    |
| `DELETE /v1/saved/lists/:listId`       | Soft-delete a custom list and return its short undo deadline.    | Requires `If-Match`; cannot target Watch Later.                         |
| `POST /v1/saved/lists/:listId/restore` | Restore a list during its undo window.                           | Requires the deletion `If-Match` value and `Idempotency-Key`.           |

The ETag is an opaque keyed digest of user, list, and numeric revision; clients do not construct it.
Stale updates return `412 saved_list_revision_stale` with the current safe list summary and ETag.
The numeric revision in response bodies supports local cache ordering but is not accepted as proof
of concurrency by itself.

Deleting a list soft-deletes the list and all its membership rows in one transaction. It never calls
Jellyfin, Seerr, Radarr, Sonarr, or a download client. The default undo window is 30 seconds. After
the window, a bounded retention job permanently removes only Omnifin list and membership records.

### Membership and ordering

| Method and path                                            | Purpose                                             | Concurrency and replay                                               |
| ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /v1/saved/lists/:listId/items`                        | Search, filter, sort, and cursor-page memberships.  | Returns the list ETag and reconciliation state.                      |
| `POST /v1/saved/lists/:listId/items`                       | Resolve one `save_target_*` and add it to the list. | Requires `Idempotency-Key` and `If-Match`.                           |
| `DELETE /v1/saved/lists/:listId/items/:catalogReferenceId` | Remove one membership, not media.                   | Requires `If-Match`; repeated desired-state removal is a safe no-op. |
| `PATCH /v1/saved/lists/:listId/items/order`                | Reorder one contiguous window.                      | Requires `If-Match` and `Idempotency-Key`.                           |

Membership insertion is idempotent under the unique `(list_id, catalog_item_id)` constraint. If the
desired membership already exists, a repeated add succeeds without incrementing the revision even
when its older ETag is stale. A removal behaves the same when the membership is already absent.
Every actual membership change increments the list revision exactly once.

Owned controls issue targets from an opaque user-scoped Library reference. Discovery controls send
only the bounded media kind, locale, and TMDB coordinate already present in the normalized Discovery
contract to `POST /v1/saved/targets/discovery`. Before issuing a target, the gateway re-resolves that
coordinate through the configured Seerr connector and stores only an encrypted normalized snapshot.
Issuing or consuming this target does not call the media-request service. Requestable cards and
details therefore provide Watch Later as a separate 44-pixel action beside Request.

A reorder request supplies `startPosition` and the complete ordered set of 2–100 opaque membership
identifiers currently occupying that contiguous window. The service verifies that exact set before
rewriting normalized integer positions. A different set returns `409 saved_reorder_window_changed`;
an older list ETag returns `412`. Positions are never accepted as database identifiers.

### Favorites

`PUT /v1/saved/favorites/:targetReferenceId` accepts `{ "favorite": true | false }`. The target must
resolve to a current owned Jellyfin item belonging to the paired user. The gateway writes the desired
state through the paired user's encrypted Jellyfin token, reads it back, and reports success only
after Jellyfin returns the requested value. Setting the already-current value is a successful no-op.

The favorite intent, opaque target lock, encrypted normalized request, and exact connector-generation
snapshot are committed before the setter dispatch boundary. Recovery reads the paired user's exact
favorite state first. A matching desired state completes without another write; a proven opposite
state permits one safe state-set retry. Ambiguous or unconfirmed outcomes remain
reconciliation-required, retain their journal row and lock, and block a different key from blindly
writing the same favorite target.

List membership may retain the last observed favorite value for degraded rendering, but it is never
authoritative. Each normal refresh reconciles from Jellyfin. An unavailable connector returns a safe
retryable error and leaves the displayed favorite in the explicit `unavailable` state; it does not
optimistically claim synchronization.

## Storage and encryption

The migration creates five user-scoped structures:

1. `saved_lists` stores a random list ID, user ID, kind, encrypted name/description, revision,
   timestamps, and an optional deletion deadline.
2. `saved_catalog_items` stores a random catalog ID, user ID, keyed identity digest, encrypted
   normalized identity, encrypted bounded display snapshot, and reconciliation timestamps.
3. `saved_list_items` stores membership, normalized position, and creation time with unique list/item
   and list/position constraints.
4. `saved_targets` stores short-lived random targets bound to user ID and identity-link revision with
   an encrypted normalized target.
5. `saved_list_operations` stores bounded idempotency state and encrypted successful responses;
   fingerprints are deployment-keyed and private fields never appear as plaintext operation data.

Private text and normalized provider coordinates use the deployment master key with record type,
user ID, and record ID as authenticated additional data. Identity lookup uses a separately derived
HMAC key; it cannot be reversed into a provider identifier. Re-keying is versioned. Database backups
therefore do not reveal list names, descriptions, title snapshots, or provider identifiers without
the deployment secret.

## Deterministic reconciliation

The current foundation preserves owned and requestable entries as separate encrypted catalog
identities and retains deliberate missing/degraded states. Cross-source promotion into one durable
entry is the remaining reconciliation step and must follow this fail-closed algorithm:

One user can encounter the same title through Discovery and Jellyfin. Reconciliation uses this
ordered algorithm within the same media kind:

1. Retain an existing valid Jellyfin association for the current identity-link revision.
2. Match a unique normalized external-provider identity from encrypted server-side metadata.
3. If no provider identity exists, match a unique normalized title and release year only when the
   connector supplies both and no competing candidate exists.
4. Otherwise retain the membership as `unavailable`; never guess or silently merge ambiguous titles.

The chosen identity is reduced to a deployment-keyed digest before indexing. Saving an owned and a
discovery representation with the same digest reuses one `catalog_*` row, so a list renders one card.
If Jellyfin removes and later re-adds the item under a new native identifier, a unique provider match
updates the encrypted association without changing list membership or the catalog reference. If an
owned item disappears but Discovery still resolves it, the same item becomes requestable or
requested. If every source disappears, its encrypted bounded snapshot remains visible as a
recoverable `missing` item until the user removes it.

Relinking Jellyfin invalidates short-lived save targets and library references immediately. Durable
memberships remain private and are reconciled against the new paired identity. No favorite mutation
is allowed until reconciliation produces a current owned association.

## Interface states and accessibility

Cards and details receive a `savedMembershipSummary` containing a short-lived save target, Watch
Later state, the count and opaque identifiers of the user's current custom-list memberships, and
favorite state. The identifiers are limited to the authenticated user's own list summaries and do
not expose list names or provider identities. The quick Watch Later control is available without
opening details and announces “Added to Watch Later” or “Removed from Watch Later” through a polite
live region. Favorite uses a separately labelled heart control. Personal-list selection is an
accessible disclosure in the detail view, not a nested click target inside the card's primary action.

The Saved destination supports manual, recently added, and title sorting plus owned, requestable,
requested, and unavailable filters. It deliberately renders loading geometry, empty lists, no search
matches, connector degradation, expired targets, relink-required items, and optimistic-conflict
recovery. Reordering works through drag, keyboard move commands, touch controls, and directional
navigation; reduced-motion mode removes positional animation. Delete confirmation says that only the
private list is removed and that media files are untouched.

Current automated coverage includes user isolation, guessed and expired references, duplicate
submissions, stale ETags, reorder races, encrypted-field leakage, owned-item removal, verified
requestable target issuance, proof that saving does not create a request, favorite round trips,
partial outages, keyboard controls, and screen-reader announcements. Connector replacement,
owned/discovery deduplication, mobile visual baselines, and ten-foot focus evidence remain release
gates before this feature can be marked complete.
