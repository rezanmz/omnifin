# System health

Omnifin provides one normalized operational view across enabled Radarr, Sonarr, and Prowlarr
connectors. It gives operators service warnings and storage pressure without exposing reusable
credentials, upstream identifiers, filesystem paths, provider URLs, or raw API payloads to the
browser.

This is pre-release fixture-backed development evidence. It is not a public compatibility claim;
the compatibility matrix remains authoritative until protected live checks record exact upstream
versions and dates.

## Authorization and connector selection

`GET /v1/system/status` and `GET /v1/system/status/events` require an active session with
`acquisition.manage`. The routes and service repeat the permission check before connector selection
or credential decryption. Recovery sessions and lower-privilege roles cannot use either endpoint.

An eligible source must be enabled, have a current validated health snapshot, identify itself as
Radarr, Sonarr, or Prowlarr, and advertise `system.health`. Radarr and Sonarr sources may also
advertise `storage.read`; Prowlarr currently contributes health signals only. The gateway considers
at most 12 sources and fails closed when the configured fan-out exceeds that bound.

## Normalization and privacy boundary

Each Servarr adapter validates the upstream health response before returning typed internal data.
Radarr and Sonarr additionally validate total and available storage from the upstream disk-space
endpoint. Text normalization removes control characters, addresses, filesystem paths, and any
configured API key that appears in an upstream warning.

Before public validation, the gateway:

- derives deployment-local opaque identifiers for sources, signals, and volumes with keyed HMACs;
- replaces raw mount paths with stable labels such as `Cinema storage 1`;
- maps upstream health types into `notice`, `warning`, and `error` severities;
- computes healthy, attention, and unavailable source counts from normalized results;
- derives healthy, warning, and critical capacity states from bounded byte totals; and
- returns typed partial failures without copying private upstream diagnostics.

The public response cannot represent a path, API key, upstream numeric identifier, arbitrary
provider field, URL, inconsistent capacity, or summary that disagrees with its sources.

## Partial failure and freshness

Source reads run concurrently, and health and storage are settled independently within each
source. A storage timeout does not discard verified health signals. A health failure does not
discard verified storage capacity. A source becomes unavailable only when it has no verified
telemetry, while healthy sources remain visible beside the safe failure context.

No eligible sources produces an explicit `unconfigured` response. The snapshot and event routes
are rate-limited and marked `no-store`. The event route shares one upstream refresh loop across
subscribers rather than opening one connector poller per browser. It permits at most 64 concurrent
connections and two per session, polls upstream no more often than every 10 seconds, emits a
heartbeat every 15 seconds, and ends each connection after about 45 seconds so native reconnection
re-enters session rotation and authorization checks.

Each event contains only a strict normalized status response plus an opaque cursor. A reconnect may
resume within a 30-second single-snapshot window; invalid cursors fail before connector access. The
response uses `Cache-Control: no-store, no-transform`, `Vary: Cookie`, and
`X-Accel-Buffering: no` so intermediaries do not cache, transform, or batch the stream.

The browser validates every event and its matching `Last-Event-ID` before replacing the verified
reading. Malformed, oversized, or mismatched events fail closed. A transient transport error keeps
native EventSource reconnection available while the interface visibly switches to a 30-second poll
that runs only while the document is visible. Live snapshots stop that fallback poll. Explicit
refresh remains available, and any failed refresh keeps the last verified result labelled stale;
the interface never invents new service or capacity state.

## Interface states and verification

The system-health workspace uses the adaptive Liquid Glass material system and supports light,
dark, and system appearance preferences. Ready, degraded, unconfigured, loading, stale,
signed-out, forbidden, and unavailable states are deliberate. Service signals and storage meters
retain semantic labels independently of color.

Component and Storybook tests cover normalized rendering, live replacement, polling fallback,
refresh recovery, stale-data retention, theme controls, and access boundaries. Broker and route
tests cover shared reads, connection bounds, replay, teardown, authorization, private SSE headers,
and payload redaction. Desktop and mobile visual baselines are committed for macOS and Linux,
including light, degraded, and onboarding states. Representative routes are checked for automatic
accessibility violations, responsive behavior, Content Security Policy, and production rendering.

## Intentionally absent mutations

This slice does not restart a service, delete files, change a root folder, alter an indexer, or
modify storage. Those actions require separate narrow contracts, local authorization, CSRF
protection, destructive-action confirmation, auditing, and isolated safe-write evidence before the
interface can expose them.
