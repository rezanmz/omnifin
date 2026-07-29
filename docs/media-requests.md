# Media requests

Omnifin exposes a normalized Seerr-backed request mutation without exposing Seerr
credentials, numeric user identifiers, raw storage paths, tags, or quota controls to
the browser. Optional server, quality, root-folder, and language choices cross the
boundary only as short-lived opaque references. This is a pre-release development surface; the
[compatibility matrix](compatibility.md) remains authoritative for supported versions.

## Authorization and identity

The gateway accepts `POST /v1/requests` only for an active session with the local
`request.create` permission. The request must carry the deployment's exact browser
origin, the session-bound CSRF proof, and an `Idempotency-Key` header. Viewers, recovery
sessions, anonymous callers, and unpaired identities are denied before an upstream
request is attempted.

Omnifin resolves the session's immutable Jellyfin user identifier against Seerr's user
directory. It then calls Seerr with the server API key and the exact numeric Seerr user
in `X-API-User`. A missing or ambiguous match fails closed. The API key is never used
without this delegated user context for request creation, so Seerr applies the paired
user's permissions, quota, and approval policy.

## Public input and response

The request body accepts only:

- `kind`: `movie` or `series`;
- `tmdbId`: a positive bounded TMDB identifier;
- `is4k`: an optional boolean that defaults to `false`;
- `seasons`: `all` or a bounded, duplicate-free season list for a series; and
- `routing`: an optional, closed set of opaque destination, quality-profile,
  root-folder, and language-profile references previously issued by the gateway.

Movie bodies cannot contain seasons. Fields such as `userId`, `serverId`, `profileId`,
raw `rootFolder`, `tags`, and `ignoreQuota` are rejected rather than forwarded. When
`routing` is omitted, Seerr and its Radarr or Sonarr policy remain responsible for
choosing operational settings.

`GET /v1/requests/routing-options` accepts only media kind and standard/4K intent. The
gateway first revalidates the session, permission, Jellyfin link, Seerr user mapping,
connector health, and routing capability. It then returns friendly destination,
profile, and terminal folder labels with bounded capacity telemetry. Full paths and
numeric upstream identifiers remain gateway-only.

Every routing reference is authenticated and encrypted, expires after 15 minutes, and
is bound to the local user, Seerr connector, destination, media kind, format intent,
and issuance set. Mixing references, changing an opaque value, crossing users,
switching format, or submitting after expiry fails closed before the Seerr mutation.
Routing values and root folders are redacted from structured logs.

The normalized response contains an Omnifin request identifier, media kind and TMDB
identifier, 4K flag, normalized request status, requested series seasons, creation time,
and the `seerr` source label. Raw user relations, email addresses, upstream media
records, storage paths, and service errors never cross the gateway boundary.

## Idempotency and ambiguous outcomes

Idempotency keys are scoped to the local user and stored only as SHA-256 hashes. The
gateway also stores a canonical request fingerprint. Reusing a key for a different
request is rejected. A completed success is returned with `Idempotency-Replayed: true`
without contacting Seerr, and a known failure is replayed without attempting another
mutation.

The gateway reserves the operation before the upstream write. If the process stops
after Seerr may have accepted the request but before the local outcome is committed,
the reservation remains pending. Replays return `request_outcome_pending` instead of
risking a duplicate upstream write. Operators can correlate the request identifier with
gateway and Seerr records before deciding whether to submit a new idempotency key.

## Request composer

Requestable discovery results open a modal Liquid Glass drawer rather than exposing
upstream controls in the search list. The composer checks the current session, local
permission, and paired Jellyfin identity before rendering mutation controls. It supports
standard or 4K intent and either all available or explicit, bounded season selections.
An opt-in Advanced routing disclosure reads the currently valid Seerr destinations and
offers native, keyboard-accessible destination, quality, storage, and language controls.
The collapsed summary remains quiet, and a single action restores Seerr defaults.

The browser creates a fresh cryptographic idempotency key for each distinct selection.
It preserves that key after an ambiguous network outcome so a retry can recover the
original success without duplication. A confirmed upstream failure starts a new key only
after the user explicitly reviews and retries the request. Successful local results update
the discovery status immediately without waiting for a second upstream search.

The drawer uses the native modal dialog model for focus containment, Escape dismissal,
focus restoration, and background inertness. Desktop and mobile layouts, dark and light
themes, reduced motion and transparency, forced colors, loading, pairing, denial, offline,
submitting, interrupted, and accepted states are covered by component, browser,
accessibility, and deterministic visual tests. Loading, partial, unavailable, expired,
and explicit-routing states preserve the baseline request path and never display a raw
storage path.

## Failure and audit model

The API maps upstream behavior into stable, sanitized outcomes for permission denial,
quota or policy denial, an existing request, no remaining seasons, missing Seerr user
context, rate or availability failures, configuration failures, and response drift.
Raw upstream messages are not returned or stored in the idempotency record.

Successful and failed attempts create `media.request.created` or
`media.request.failed` audit events. Audit metadata is bounded to media kind, TMDB
identifier, 4K intent, and a normalized failure code. It excludes credentials, user
tokens, usernames, idempotency keys, media paths, and upstream response bodies.

Deterministic connector fixtures cover user-context delegation, request payloads,
status normalization, known upstream failures, schema drift, and secret isolation.
Gateway tests additionally cover local authorization, CSRF, origin validation,
idempotency conflicts and replay, durable failure replay, audit writes, opaque-reference
tampering, user and format binding, expiry, and fresh and historical migration paths.
