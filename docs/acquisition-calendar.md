# Acquisition calendar

Omnifin exposes one normalized, read-only release horizon across validated Radarr and Sonarr
connectors. The calendar combines movie release dates and episode air dates without placing reusable
service credentials, raw provider records, filesystem paths, or upstream media identifiers in the
browser.

This is pre-release fixture-backed development evidence. It is not a public compatibility claim;
the compatibility matrix remains authoritative until protected live checks record exact upstream
versions and dates.

## Authorization and connector selection

`GET /v1/acquisitions/calendar` requires an active session with `media.view`. The route and service
repeat the permission check before connector selection or credential decryption. Recovery sessions
cannot use the endpoint.

An eligible source must be enabled, identify itself as Radarr or Sonarr, have a current validated
healthy snapshot, and advertise `acquisition.calendar`. The gateway selects a bounded number of
eligible sources and reads them concurrently under the request abort signal. Missing or unhealthy
connectors do not become implicit calendar sources.

Queries require explicit UTC `start` and `end` timestamps, allow a maximum 62-day window, and bound
each page to 100 events. Pagination cursors are gateway-signed and bound to their original time
range; a modified cursor or one reused for another range fails closed.

## Normalization and privacy boundary

The Radarr adapter reads the bounded v3 calendar endpoint and normalizes cinema, digital, physical,
and unknown movie release dates. The Sonarr adapter reads the same bounded endpoint family and
normalizes episode air dates. Both adapters validate upstream payloads before returning typed
internal events.

The gateway then:

- derives deployment-local opaque source and event identifiers;
- removes upstream identifiers before public validation;
- normalizes availability into `available`, `missing`, `monitored`, `queued`, or `unknown`;
- bounds titles, subtitles, overview text, years, episode coordinates, runtimes, dates, sources,
  failures, and total events;
- sorts events deterministically and recomputes every returned summary count; and
- emits safe typed failures without copying private upstream errors.

The public contract cannot represent a path, arbitrary provider field, API key, cookie, raw media
identifier, or unbounded payload. Contract refinements also prevent Radarr events from claiming
episode semantics, Sonarr events from claiming movie semantics, out-of-range events, duplicate
identifiers, inconsistent source references, or summaries that disagree with their events.

## Partial failure and truncation

No eligible sources produces an explicit `unconfigured` response. If one source fails, its safe
failure appears beside verified events from healthy sources and the response becomes `degraded`.
One unavailable source never causes the gateway to invent or discard another source's events.

Each adapter bounds its upstream result and the gateway applies a second page bound after combining
sources. `sourceTruncated` reports either source fan-out truncation or an adapter reaching its source
limit. `nextCursor` provides stable range-bound pagination when more combined events remain.

## Browser behavior

The route is non-cacheable and rate-limited. The calendar offers a focused seven-day week and a
Monday-aligned six-week month grid. Navigation advances by the selected period, while Today returns
to the current UTC week or month. Both views preserve refresh, signed cursor pagination,
title/source search, and movie, episode, and attention filters. Live reads preserve the last
verified horizon when a later refresh fails and label that evidence as stale.

Month cells show a bounded event preview. A day with additional arrivals exposes an explicit
expanded-state control, so density never makes an event unreachable. Selecting an event in either
view opens the same native modal detail drawer; Escape, backdrop activation, and the close control
dismiss it and return focus to the exact event that opened it.

Ready week/month, empty, unconfigured, degraded, loading, signed-out, forbidden, and unavailable
states have component coverage. Dark and light desktop/mobile baselines are committed for macOS and
Linux, and representative routes are checked for automatic accessibility violations, keyboard and
directional navigation, responsive behavior, reduced motion, Content Security Policy, and production
rendering.

## Intentionally absent mutations

This slice does not monitor, unmonitor, search, grab, delete, reschedule, or otherwise modify media.
Those operations require separate narrow contracts, local mutation authorization, CSRF protection,
idempotency where applicable, destructive-action confirmation, auditing, and isolated safe-write
evidence before the interface can expose them.
