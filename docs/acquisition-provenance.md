# Acquisition provenance

Omnifin exposes a normalized title trace across Radarr and Sonarr history and queue
data, plus a narrowly scoped automatic-search recovery action. It is a pre-release
development surface; the
[compatibility matrix](compatibility.md) remains authoritative for supported upstream
versions.

## Authorization and connector selection

The gateway accepts `GET /v1/acquisitions/provenance` only for an authenticated
principal with `acquisition.manage`. Viewers, requesters, recovery sessions, and
anonymous callers are denied before connector state or credentials are read.

The query names exactly one service and upstream title identifier:

- `service`: `radarr` or `sonarr`;
- `mediaId`: a positive bounded Radarr movie or Sonarr series identifier; and
- `seasonNumber`: an optional bounded Sonarr season. Radarr targets reject this
  field.

Exactly one enabled matching connector must exist. Its most recent validated health
snapshot must identify the same connector and service, report healthy state, and
advertise the capability required by the operation: `acquisition.history` for the
trace and `acquisition.search` for recovery. Missing, ambiguous, stale, malformed, or
capability-incompatible configuration fails closed. The API key and optional trusted
connector CA are decrypted only inside the gateway for the duration of the request.

## Normalized event model

Radarr and Sonarr history and queue reads run independently and concurrently. Up to
250 records are requested from each bounded upstream page, filtered again to the exact
title and optional season, normalized, deduplicated by source identifier, and returned
newest first.

The public contract represents searches, grabs, queue state, active downloads,
stalls, failures, imports, upgrades, and ignored downloads. The current connector
slice emits the upstream-backed grab, queue, download, stall, failure, import,
upgrade, and ignored states. A successful recovery returns a normalized queued-search
receipt; the drawer presents it immediately while later upstream history and queue
reads remain authoritative.

Each event may contain a bounded release title, quality, protocol, indexer, download
client, size, season, and episode numbers. It never contains API keys, download hashes,
storage or media paths, raw history data, raw queue status, arbitrary upstream fields,
or private error messages.

## Partial failure behavior

History and queue are separate evidence sources. If one succeeds and the other fails,
the response remains useful with `state: degraded`, the verified events, and one typed
partial failure. If both reads complete, `state` is `complete` even when the title has
no events. If neither source can provide evidence, the request fails with a sanitized
availability outcome rather than presenting an empty trace. Cancellation follows the
browser request abort signal through the gateway and connector transport.

The route uses `Cache-Control: no-store`, `Pragma: no-cache`, and `Vary: Cookie`.
Rate limits, invalid responses, configuration failures, and temporary availability
failures map to stable public error codes without forwarding upstream messages.

## Live delivery and fallback

While the signal-history drawer is open, the browser connects to
`GET /v1/acquisitions/provenance/events` with the same exact target query. This is a
short-lived, authenticated Server-Sent Events stream. The gateway coalesces polling
only for subscribers inspecting the same target; a Radarr movie, a Sonarr series, and
each selected Sonarr season remain separate groups. The normalized response is parsed
again and matched to the requested target before it is published.

Each snapshot has a fresh opaque `provenance_event_*` cursor. The stream sends bounded
reconnect guidance and heartbeats, retains only a small time- and count-limited replay
window, closes periodically so the session is revalidated, and enforces global and
per-session connection limits. Invalid resume cursors are rejected before any
connector call. Target failures close only the affected group and are logged through
redacted diagnostics; other targets continue independently.

The browser does not call a transport live merely because a socket opened. It accepts
an update only after checking the message-size bound, JSON, strict public schema,
transport cursor, and exact selected target. Invalid data closes the stream without
replacing the last verified view. A transient disconnect changes the status to
`Refreshing` and enables bounded 15-second polling while the document is visible;
native EventSource reconnection can restore the live path after the next valid
snapshot. Connecting, live, and fallback states are exposed as an assistive live
region and never rely on color alone.

## Contextual recovery

`POST /v1/acquisitions/searches` accepts the same exact target contract as the read
route. It supports only three current upstream commands: Radarr `MoviesSearch`, Sonarr
`SeriesSearch`, and Sonarr `SeasonSearch`. A request cannot nominate a path, release,
profile, tag, download, blocklist entry, monitoring change, or arbitrary command.

The route requires an active user with `acquisition.manage`, same-origin validation,
a session-bound CSRF token, and a bounded `Idempotency-Key`. Recovery and pending-link
sessions cannot use it. The gateway reserves a per-user hash of the idempotency key
and a canonical target fingerprint before any upstream call. Replays return the stored
normalized receipt, different input under the same key is rejected, and an unresolved
pending operation fails closed rather than issuing a second command.

Search success or failure and its sanitized audit event commit together. Audit data
contains the service, media identifier, optional season, normalized outcome, and a
privacy-preserving IP hash. It never contains the raw key, API credential, upstream
body, storage path, username, or private error. Because a connection can fail after an
upstream server receives a command, the interface preserves the current key and tells
the operator to verify history before explicitly creating a fresh attempt.

## Signal-history drawer

Selecting an expanded operation opens a lazy-loaded native modal drawer. The
interface shows summary counts, event chronology, release context, verified degraded
data, and a persistent verification label. Its contextual-recovery card uses a
two-step exact-target confirmation. The only mutation offered is the bounded automatic
search described above; destructive recovery controls remain absent.

The Liquid Glass surface retains focus containment, Escape dismissal, background
inertness, keyboard-scrollable history, at least 44-pixel controls, reduced motion,
and adaptive light, dark, system, phone, tablet, desktop, and 10-foot presentation.
Storybook covers complete, degraded, empty, loading, offline, permission-denied,
connecting, live, polling-fallback, recovery-confirmation, monitoring, and queued-success states.
Component, browser, accessibility, and deterministic visual tests cover the assembled interaction. The separate
[acquisition-monitoring boundary](acquisition-monitoring.md) documents the exact whole-title
mutation available inside the same drawer.

## Verification

Deterministic connector fixtures cover Radarr and Sonarr filtering, history and queue
normalization, degraded reads, cancellation-compatible requests, malformed upstream
responses, exact Radarr/Sonarr search payloads, and secret/path isolation. Gateway
tests cover authorization before storage access, CSRF and origin enforcement,
idempotency conflicts and replay, exact connector selection, capability health,
encrypted credentials, transactional audit outcomes, safe errors, response headers,
abort propagation, target-scoped stream coalescing, replay bounds, connection limits,
failure isolation, teardown, and secret-free SSE output.

Live version support is not inferred from fixture success. It requires the protected
integration environment to record exact upstream versions and dates according to the
[compatibility policy](compatibility.md).
