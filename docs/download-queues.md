# Download queues

Omnifin exposes one normalized queue across validated qBittorrent and SABnzbd connectors. The
workspace gives operators current progress, degraded-client context, and exact-item pause, resume,
front-of-queue promotion, and removal controls without
placing reusable download-client credentials, raw queue responses, download hashes, or media paths
in the browser.

This is pre-release fixture-backed development evidence. It is not a public compatibility claim;
the compatibility matrix remains authoritative until protected live checks record exact upstream
versions and dates.

The protected pull-request aggregate also exercises the production adapters against fresh,
digest-pinned qBittorrent and SABnzbd containers. Its synthetic queue items must complete observed
exact-item pause, resume, front-of-queue promotion, and preserve-files removal without retaining
credentials, native IDs, or paths in the report. The complete isolation and evidence contract is
documented in the
[download-client fixture runbook](operations/download-client-fixtures.md).

## Authorization and connector selection

`GET /v1/downloads/queue` requires an active session with `downloads.manage`. The route and service
repeat the permission check before connector selection or credential decryption. Recovery sessions
and lower-privilege roles cannot use the endpoint.

An eligible client must be enabled, have a current validated health snapshot, identify itself as
qBittorrent or SABnzbd, and advertise `download.queue.read`. The gateway considers a bounded number
of configured clients and fails closed on malformed encrypted configuration. Eligible reads run in
parallel under the request abort signal so one slow client does not serialize every other result.

## Normalization and secret boundary

The qBittorrent adapter establishes a short-lived authenticated session and reads the bounded
torrent information endpoint. It accepts only qBittorrent's legacy `200`/`Ok.` login response or the
current empty `204` response and requires the corresponding legacy or port-scoped session cookie.
The SABnzbd adapter sends its API key only to the approved connector destination and reads the
bounded queue response. In both cases the adapter validates the upstream payload before it returns
typed internal data.

The gateway then:

- derives a deployment-local opaque item identifier from the connector generation and upstream
  identifier, while preserving the established identifier derivation for generation-zero
  connectors;
- removes the upstream identifier before public validation;
- normalizes torrent and Usenet states into one bounded state vocabulary;
- bounds client names, titles, categories, dates, progress, rates, sizes, peer counts, clients, and
  total items;
- recomputes client totals and aggregate summary values from the returned items; and
- returns typed per-client failures without copying private upstream messages.

The public response cannot represent a path, arbitrary provider field, API key, cookie, raw hash,
or unbounded byte value. Contract refinements also prevent a qBittorrent item from claiming the
Usenet protocol, a SABnzbd item from exposing torrent peer counts, or a summary from disagreeing
with its items.

## Partial failure and truncation

No eligible clients produces an explicit `unconfigured` response. If every eligible client fails,
the response is `degraded` with safe client failures and no invented transfers. If at least one
client succeeds, its verified items remain available beside the failed-client context.

Each adapter bounds its source queue, and the gateway applies a second global item limit after
combining clients. A `truncated` flag tells the interface when either bound was reached. Connector
fan-out is also bounded; exceeding it marks the response truncated rather than silently implying a
complete view.

## Browser behavior

The read route is non-cacheable and rate-limited. While the workspace is active, it opens the
same-origin authenticated event stream described below. Strict snapshots replace the existing
TanStack Query value in place, so progress changes do not rebuild the page or alter its geometry.
An explicit state indicator distinguishes live, reconnecting, 12-second polling fallback, and
fixed snapshot modes. If the stream is unavailable, interrupted, or invalid, the last verified
queue remains visible and foreground polling resumes every 12 seconds. An explicit refresh remains
available. A later read failure produces a visible stale notice rather than presenting retained
evidence as current telemetry.

Search and state filters operate only on normalized in-memory data. Pause and resume first open an
inline confirmation with the safe cancel action focused. Promotion is a reversible, non-blocking
action with a direct **First** control. Before any write, the browser revalidates the active
session, permission, and CSRF token, then sends one opaque item identifier, its connector, and its
observed state. Removal also requires the operator to type `REMOVE`, explains the client-specific
consequence, and uses a fresh cryptographic idempotency key for each confirmation. Successful
mutations update the local queue without waiting for the next live event or poll and leave
persistent screen-reader status announcements.

Ready, empty, unconfigured, degraded, loading, signed-out, forbidden, and unavailable states have
component coverage. Dark and light desktop/mobile baselines are committed, and representative
routes are checked for automatic accessibility violations, keyboard filtering, responsive
overflow, Content Security Policy, and production rendering.

## Authenticated live snapshot stream

`GET /v1/downloads/queue/events` is a versioned `text/event-stream` endpoint for the same bounded
queue representation returned by `GET /v1/downloads/queue`. It requires a current server-side
session and `downloads.manage`; unauthenticated, unauthorized, malformed-cursor, rate-limit, and
capacity failures use the canonical JSON error contract before streaming begins. The safe GET does
not require a CSRF header. It accepts no query parameters or caller-selected destination.

Each message uses the default SSE event type and contains:

```text
id: download_event_<opaque 22-character value>
data: {"cursor":"download_event_<same value>","kind":"snapshot","queue":{...}}
```

The strict data contract rejects extra fields. In particular, it cannot represent connector
credentials, native queue identifiers, media paths, cookies, or arbitrary upstream values. The
browser accepts a message only when the SSE `lastEventId` exactly matches the validated cursor in
its JSON data. The queue is bounded to 200 items, so each message is a complete normalized snapshot
and this endpoint deliberately has no pagination or partial-delta semantics.

The gateway sends `retry: 3000`, emits comment heartbeats every 15 seconds, and ends each stream
after about 45 seconds. Native `EventSource` reconnection then re-enters session rotation,
expiration, and authorization checks. A reconnect may send `Last-Event-ID`; only the newest
snapshot retained inside a 30-second recovery window can be replayed, and an exact cursor is never
duplicated. Invalid cursors fail with `download_queue_event_cursor_invalid`. The response uses
`Cache-Control: no-store, no-transform`, `Pragma: no-cache`, `Vary: Cookie`, and
`X-Accel-Buffering: no` so intermediaries do not cache, transform, or batch events.

One process-wide broker performs a single upstream refresh for all connected operators instead of
polling administrative clients once per browser. It admits at most 64 streams globally and two per
session. Excess connections fail before streaming with `429`, `Retry-After`, and
`download_queue_event_capacity_reached`. When the final subscriber leaves, the shared read is
aborted. If a shared refresh fails after headers are committed, streams close without exposing the
private failure; browsers retain the last verified value and use the polling fallback while native
reconnection continues.

## Exact-item pause and resume

`POST /v1/downloads/queue/actions` requires an active user with `downloads.manage`, same-origin and
CSRF validation, a 1 KiB body limit, mutation rate limiting, and an abort-aware request. The strict
contract cannot express deletion, paths, categories, priorities, URLs, or multiple targets.

The gateway selects the named healthy connector only when it advertises both queue read and mutate
capabilities. Before reading or writing the target, it reserves a `download_queue_item_operations`
row and an encrypted external-mutation dispatch, snapshots the connector instance/config
generations, and takes the deployment-local exact-target lock. It then reads the queue, derives
every opaque identifier, and requires exactly one match. An already-achieved action returns as a
verified no-op; otherwise the observed state must match the submitted state before a write is
allowed. A durable `requested` audit event is stored before dispatch, and the journal is changed to
`dispatched` immediately before the adapter call. Audit or generation-check failure therefore
prevents mutation.

The first exact postcondition read decides the result. The desired state succeeds even when the
adapter response was lost. The identical target still in its exact pre-dispatch state permits at
most one proof-based state-set retry; the retry boundary is durable before the second adapter call.
Absence, identity change, generation change after dispatch, or a different observed state becomes
uncertain. A failed post-dispatch read becomes `reconcile_required`; neither condition is reported
as an ordinary retryable upstream failure. Unresolved rows retain the target lock.

Callers may provide `Idempotency-Key`; browser calls without one receive a request-scoped key. The
same key replays a completed result, reconciliation requirement, or uncertain result without
reconstructing an adapter. A different key conflicts while an unresolved operation owns the exact
target. Every write response includes `X-Omnifin-Operation-Id`, and idempotent routes also expose
`Idempotency-Replayed`. Safe conflict codes distinguish locked targets, changed connector
generations, reconciliation requirements, and uncertain outcomes without exposing native IDs.

qBittorrent uses a validated single torrent hash and selects `stop`/`start` for version 5 or newer
and `pause`/`resume` for version 4. SABnzbd binds `pause` or `resume` to exactly one validated
`nzo_id`. Raw hashes, `nzo_id` values, credentials, cookies, and upstream responses never reach the
browser or audit metadata.

## Safe current-view bulk pause and resume

`POST /v1/downloads/queue/bulk-actions` coordinates pause or resume for 1–200 explicit opaque
targets. It accepts no wildcard, client-native identifier, path, category, URL, deletion option, or
arbitrary command. The operator workspace captures only eligible transfers in the current search
and filter, displays the exact count and client scope, and requires confirmation before submitting.

The route requires an active `downloads.manage` session, same-origin CSRF proof, a per-user
`Idempotency-Key`, a 64 KiB body limit, a six-per-minute operation limit, and no-store responses. The
gateway durably reserves only the parent aggregate, then creates one journaled
`download_queue_item_operations` child for every exact target and limits concurrent mutations to
four. It never forwards a client-native bulk command. Each qBittorrent hash or SABnzbd `nzo_id` is
resolved, locked, generation-checked, dispatched, and reconciled independently inside the secret
boundary.

Results preserve input order and report a normalized success or bounded failure for every target,
so partial completion is explicit. Progress is stored after each bounded batch, while each child
boundary is independently durable. A recent pending parent is rejected; after a 30-second lease
expires, the same idempotency proof resumes only children that are still provably pre-dispatch or
can be reconciled by an exact read. Dispatched children are never reclaimed for blind redispatch.
Existing Phase 0 `quarantined` parents always fail closed with their stored progress unchanged and
make zero adapter calls. Up to 200 parent records are retained per user. Retention removes only old
definitive parents/children and never prunes unresolved or quarantined evidence.

Bulk requested/completed audit events contain the operation ID, action, target count, client count,
and normalized outcome counts. Existing per-item audit records retain exact public target evidence.
Raw identifiers, idempotency keys, credentials, paths, and private upstream responses are never
stored in audit metadata or returned to the browser.

## Exact-item front-of-queue promotion

`POST /v1/downloads/queue/promotions` applies the same active-user, `downloads.manage`, same-origin,
CSRF, 1 KiB body, connector-capability, mutation-rate, abort, and no-store boundaries as pause and
resume. Its closed contract contains exactly one connector, one deployment-local opaque item, and
the freshly observed state. It cannot express a numeric priority, arbitrary position, bulk target,
path, category, URL, or client-native command.

Promotion uses the same operation row, encrypted dispatch, generation snapshot, exact-target lock,
idempotency replay, and dispatched-before-adapter boundary as pause/resume. The gateway resolves the
opaque target against a fresh exact queue read and retains its native position only inside the
secret boundary. An item already at position zero returns as a verified no-op without contacting
the client. Missing or unobservable queue order fails closed; otherwise the observed state must
match before mutation. The exact postcondition must show the identical item at position zero. Only
an unchanged item at its prior position permits one proof-based promotion retry; changed,
recreated, absent, or unreadable postconditions retain uncertainty or a reconciliation requirement.

qBittorrent receives one validated torrent hash through its `topPrio` endpoint. SABnzbd receives
one validated `nzo_id` through `mode=switch` with position zero. The gateway performs bounded exact-
item reads after the write and reports success only after the same opaque item is observed at the
front. Raw hashes, `nzo_id` values, credentials, cookies, client positions, and upstream responses
never cross the public contract or enter audit metadata.

## Exact-item removal with downloaded files preserved

`POST /v1/downloads/queue/removals` has the same active-user, `downloads.manage`, same-origin, CSRF,
1 KiB body, connector-capability, rate-limit, and no-store boundaries as pause and resume. It also
requires an `Idempotency-Key` header. Its strict contract contains one connector, one deployment-
local opaque item, and the freshly observed state; it cannot express a filesystem path, bulk target,
client-native command, or deletion of downloaded content.

The gateway hashes the per-user idempotency key and a canonical target fingerprint before storing
them. It durably reserves the removal plus its encrypted external-mutation dispatch, snapshots the
connector generations and a richer target identity beside the exact public item, takes the shared
download-target lock, and commits the `download.queue.removal.requested` audit record before
contacting the client. qBittorrent receives one validated torrent hash with `deleteFiles=false`.
SABnzbd receives one validated `nzo_id` without `del_files=1`, so already-downloaded files are
preserved. The journal is marked dispatched immediately before that exact adapter call.

Exact absence is definitive success, including after a lost adapter response. The identical target
still present permits one proof-based retry whose dispatch count is persisted first. A changed or
recreated target is uncertain, and an unreadable postcondition requires reconciliation; neither is
downgraded to an ordinary failed/retryable response. Same-key success and unresolved outcomes replay
without an adapter call, while new keys conflict on the retained target lock. Only definitive
succeeded/failed operation and dispatch rows expire after 30 days. Responses, headers, and audit
events contain only bounded public identifiers, the normalized snapshot, an operation identifier,
and the fixed `contentDisposition: "preserved"` guarantee. Raw hashes, `nzo_id` values, idempotency
keys, credentials, cookies, paths, and upstream bodies remain inside the gateway.

Arbitrary numeric priorities or positions, relocation, category changes, blocklisting, and deletion
of downloaded content remain intentionally absent. Bulk pause/resume is deliberately limited to
explicit, freshly revalidated targets and cannot express those broader mutations.
