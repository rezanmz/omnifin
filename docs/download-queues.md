# Download queues

Omnifin exposes one normalized queue across validated qBittorrent and SABnzbd connectors. The
workspace gives operators current progress, degraded-client context, and exact-item pause, resume,
and removal controls without
placing reusable download-client credentials, raw queue responses, download hashes, or media paths
in the browser.

This is pre-release fixture-backed development evidence. It is not a public compatibility claim;
the compatibility matrix remains authoritative until protected live checks record exact upstream
versions and dates.

The protected pull-request aggregate also exercises the production adapters against fresh,
digest-pinned qBittorrent and SABnzbd containers. Its synthetic queue items must complete observed
exact-item pause, resume, and preserve-files removal without retaining credentials, native IDs, or
paths in the report. The complete isolation and evidence contract is documented in the
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

- derives a deployment-local opaque item identifier from the connector and upstream identifier;
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

The route is non-cacheable and rate-limited. The workspace polls every 12 seconds while live,
supports an explicit refresh, and preserves the last verified queue if a later refresh fails. A
visible stale notice distinguishes retained evidence from current telemetry. Search and state
filters operate only on normalized in-memory data. Queue changes first open an inline confirmation
with the safe cancel action focused. The browser then revalidates the active session, permission,
and CSRF token before sending one opaque item identifier, its connector, and its observed state.
Removal also requires the operator to type `REMOVE`, explains the client-specific consequence, and
uses a fresh cryptographic idempotency key for each confirmation. A successful removal updates the
local queue totals without waiting for the next poll and leaves a persistent screen-reader status
announcement after the card disappears.

Ready, empty, unconfigured, degraded, loading, signed-out, forbidden, and unavailable states have
component coverage. Dark and light desktop/mobile baselines are committed, and representative
routes are checked for automatic accessibility violations, keyboard filtering, responsive
overflow, Content Security Policy, and production rendering.

## Exact-item pause and resume

`POST /v1/downloads/queue/actions` requires an active user with `downloads.manage`, same-origin and
CSRF validation, a 1 KiB body limit, mutation rate limiting, and an abort-aware request. The strict
contract cannot express deletion, paths, categories, priorities, URLs, or multiple targets.

The gateway selects the named healthy connector only when it advertises both queue read and mutate
capabilities. It reads the queue, derives every deployment-local opaque identifier, and requires
exactly one match. An already-achieved action returns as a verified replay; otherwise the observed
state must match the submitted state before a write is allowed. A durable `requested` audit event
is stored before the upstream call, so audit storage failure prevents mutation. The gateway then
re-reads the exact item with bounded retries and returns only a schema-valid desired state. Updated,
replayed, failed, stale, and missing-target outcomes retain only bounded public identifiers and
metadata.

qBittorrent uses a validated single torrent hash and selects `stop`/`start` for version 5 or newer
and `pause`/`resume` for version 4. SABnzbd binds `pause` or `resume` to exactly one validated
`nzo_id`. Raw hashes, `nzo_id` values, credentials, cookies, and upstream responses never reach the
browser or audit metadata.

## Exact-item removal with downloaded files preserved

`POST /v1/downloads/queue/removals` has the same active-user, `downloads.manage`, same-origin, CSRF,
1 KiB body, connector-capability, rate-limit, and no-store boundaries as pause and resume. It also
requires an `Idempotency-Key` header. Its strict contract contains one connector, one deployment-
local opaque item, and the freshly observed state; it cannot express a filesystem path, bulk target,
client-native command, or deletion of downloaded content.

The gateway hashes the per-user idempotency key and a canonical target fingerprint before storing
them. It durably reserves the operation, snapshots the exact public queue item, and commits the
`download.queue.removal.requested` audit record before contacting the client. qBittorrent receives
one validated torrent hash with `deleteFiles=false`. SABnzbd receives one validated `nzo_id` without
`del_files=1`, so already-downloaded files are preserved. The gateway then performs bounded exact-
item reads and reports success only after that opaque item is absent.

Completed and failed outcomes replay without another upstream mutation. A recent pending operation
is rejected instead of joined. After the short recovery lease, the gateway can complete an operation
whose exact item is already absent, or retry only when the current item still matches the durable
snapshot; identifier reuse or changed item metadata fails closed. Completed operation records are
retained for 30 days and pruned transactionally before new reservations. Responses and audit events
contain only bounded public identifiers, the normalized snapshot, an operation identifier, and the
fixed `contentDisposition: "preserved"` guarantee. Raw hashes, `nzo_id` values, idempotency keys,
credentials, cookies, paths, and upstream bodies remain inside the gateway.

Relocation, priority changes, category changes, blocklisting, deletion of downloaded content, and
bulk mutations remain intentionally absent. They require their own destructive-action and recovery
design plus disposable live-service evidence before the interface can expose them.
