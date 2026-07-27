# Media requests

Omnifin exposes a normalized Seerr-backed request mutation without exposing Seerr
credentials, numeric user identifiers, server selection, storage paths, profiles, tags,
or quota controls to the browser. This is a pre-release development surface; the
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
- `is4k`: an optional boolean that defaults to `false`; and
- `seasons`: `all` or a bounded, duplicate-free season list for a series.

Movie bodies cannot contain seasons. Fields such as `userId`, `serverId`, `profileId`,
`rootFolder`, `tags`, and `ignoreQuota` are rejected rather than forwarded. Seerr and
its Radarr or Sonarr policy remain responsible for choosing operational settings.

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
idempotency conflicts and replay, durable failure replay, audit writes, and fresh and
historical migration paths.
