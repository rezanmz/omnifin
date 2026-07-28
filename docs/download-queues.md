# Download queues

Omnifin exposes one normalized, read-only queue across validated qBittorrent and SABnzbd
connectors. The workspace gives operators current progress and degraded-client context without
placing reusable download-client credentials, raw queue responses, download hashes, or media paths
in the browser.

This is pre-release fixture-backed development evidence. It is not a public compatibility claim;
the compatibility matrix remains authoritative until protected live checks record exact upstream
versions and dates.

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
torrent information endpoint. The SABnzbd adapter sends its API key only to the approved connector
destination and reads the bounded queue response. In both cases the adapter validates the upstream
payload before it returns typed internal data.

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
filters operate only on normalized in-memory data and never change an upstream client.

Ready, empty, unconfigured, degraded, loading, signed-out, forbidden, and unavailable states have
component coverage. Dark and light desktop/mobile baselines are committed, and representative
routes are checked for automatic accessibility violations, keyboard filtering, responsive
overflow, Content Security Policy, and production rendering.

## Intentionally absent mutations

This slice does not pause, resume, reprioritize, remove, relocate, or otherwise modify a transfer.
Those operations require separate narrow contracts, local authorization, CSRF protection,
idempotency where applicable, destructive-action confirmation, auditing, and isolated safe-write
evidence before the interface can expose them.
