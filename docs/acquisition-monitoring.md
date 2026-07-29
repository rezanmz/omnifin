# Acquisition monitoring

Omnifin provides a narrowly scoped operator control for pausing or enabling automatic acquisition
on one whole Radarr movie or one whole Sonarr series. It does not expose episode, season, file,
queue, profile, tag, path, deletion, or arbitrary editor controls.

This is a pre-release development surface. Fixture verification does not establish a supported
upstream version; the [compatibility matrix](compatibility.md) remains authoritative.

## Public contract and authorization

`GET /v1/acquisitions/monitoring` accepts one bounded `mediaId` and a `service` of `radarr` or
`sonarr`. `PUT /v1/acquisitions/monitoring` accepts the same exact target plus the state the operator
observed and the opposite desired state:

```json
{
  "expectedMonitored": true,
  "mediaId": 42,
  "monitored": false,
  "service": "radarr"
}
```

Both routes require `acquisition.manage` at the route and service boundaries. The mutation also
requires an active local user, same-origin validation, the session-bound CSRF token, a body no larger
than 2 KiB, and a limit of 12 requests per minute. Reads are limited to 30 requests per minute. Both
routes are abort-aware and explicitly non-cacheable.

Exactly one enabled, currently healthy connector for the named service must advertise
`acquisition.monitoring`. Missing, ambiguous, unhealthy, stale, or capability-incompatible
configuration fails closed before an upstream request is made. Connector credentials are decrypted
only inside the gateway.

## Upstream mutation boundary

Before changing state, the gateway reads and validates the exact title. If it already has the desired
state, Omnifin returns that verified state without issuing another write and records the operation as a
replay. Otherwise the adapter sends only:

- Radarr: `{ "movieIds": [mediaId], "monitored": desiredState }` to the movie editor;
- Sonarr: `{ "seriesIds": [mediaId], "monitored": desiredState }` to the series editor.

The upstream response must identify the same title and confirm the desired boolean. A mismatched,
missing, malformed, or unsupported response fails closed. The public response contains only the
normalized target kind, service, media identifier, monitoring state, and verification time.

Pausing monitoring does not remove files, cancel downloads, alter queues, change quality profiles or
tags, block releases, or disable the connector. Enabling monitoring makes the whole title eligible for
the upstream service's normal missing and upgrade behavior; it does not itself queue an immediate
search.

## Audit and interface behavior

Every real upstream change first persists a structured `acquisition.monitoring.requested` audit event;
storage failure therefore prevents the mutation instead of erasing its trail. Successful changes,
verified replays, and normalized failures are recorded as distinct follow-up actions. Audit metadata
records the bounded target and state transition, never connector credentials, paths, raw response
bodies, cookies, CSRF tokens, or private upstream errors.

The signal-history drawer presents the verified state in a Liquid Glass control with explicit loading,
ready, confirmation, submitting, paused, unavailable, configuration, permission-denied, signed-out,
and rate-limited states. The confirmation explains the acquisition effect and places initial focus on
Cancel. Controls meet the 44-pixel target size, announce completion to assistive technology, disable
nonessential motion when requested, and adapt to light, dark, desktop, and phone presentation.

## Verification

Contract tests enforce service/kind consistency, bounded identifiers, strict bodies, and real state
changes. Connector fixtures verify Radarr reads, Radarr and Sonarr editor payloads, exact-target
response confirmation, cross-service rejection before transport, and path/secret isolation. Gateway
tests cover authorization before storage access, CSRF and origin enforcement, capability health,
encrypted connector selection, safe replay, audits, rate limits, no-store responses, and abort
propagation. Component, Storybook, browser, Axe, and deterministic visual tests cover the assembled
interaction on desktop and phone geometries.

Live Radarr and Sonarr profiles remain read-only until disposable upstream environments can exercise
and restore monitoring state safely.
