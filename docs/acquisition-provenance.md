# Acquisition provenance

Omnifin exposes a normalized, read-only title trace across Radarr and Sonarr history
and queue data. It is a pre-release development surface; the
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
advertise `acquisition.history`. Missing, ambiguous, stale, malformed, or
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
upgrade, and ignored states; search lifecycle events are reserved for the contextual
recovery slice.

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

## Signal-history drawer

Selecting an expanded operation opens a lazy-loaded native modal drawer. The
interface shows summary counts, event chronology, release context, verified degraded
data, refresh provenance, and a persistent read-only label. It deliberately offers no
mutation from this first slice.

The Liquid Glass surface retains focus containment, Escape dismissal, background
inertness, keyboard-scrollable history, at least 44-pixel controls, reduced motion,
and adaptive light, dark, system, phone, tablet, desktop, and 10-foot presentation.
Storybook covers complete, degraded, empty, loading, offline, and permission-denied
states. Component, browser, accessibility, and deterministic visual tests cover the
assembled interaction.

## Verification

Deterministic connector fixtures cover Radarr and Sonarr filtering, history and queue
normalization, degraded reads, cancellation-compatible requests, malformed upstream
responses, and secret/path isolation. Gateway tests cover authorization before storage
access, exact connector selection, capability health, encrypted credentials, safe
errors, response headers, and abort propagation.

Live version support is not inferred from fixture success. It requires the protected
integration environment to record exact upstream versions and dates according to the
[compatibility policy](compatibility.md).
