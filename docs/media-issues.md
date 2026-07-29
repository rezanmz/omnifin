# Media issues

Omnifin gives operators one normalized queue for playback reports created inside
Omnifin and issues tracked by Seerr. The browser works only with Omnifin contracts;
raw Seerr responses, upstream numeric identifiers, connector credentials, and
Jellyfin media identifiers stay behind the gateway.

The pre-release workbench is available at `/operations/issues`. It supports open,
resolved, and combined status views; local, Seerr, and combined source views; manual
refresh; explicit resolve and reopen confirmation; and honest empty, partial,
unconfigured, denied, signed-out, loading, and offline states. The layout and dialog
are covered by desktop and phone visual baselines, dark and light themes, reduced
motion, keyboard focus management, and automated accessibility checks.

## Public contract

The gateway exposes two versioned routes:

- `GET /v1/issues` accepts `status=open|resolved|all`,
  `source=all|omnifin|seerr`, and `limit=1..50`.
- `POST /v1/issues/:issueId/status` accepts exactly one `status` field with `open`
  or `resolved`.

Both routes require an active session with `issue.manage`. The mutation additionally
requires the normal same-origin and CSRF proof, plus an `Idempotency-Key` header. A
successful replay returns `Idempotency-Replayed: true`; reusing a key for a different
decision fails with a conflict instead of applying an ambiguous write. Responses are
marked `no-store`, are schema-normalized, and contain only opaque `issue_*`
references.

## Source and failure behavior

Local player reports are read from Omnifin's encrypted issue records. Seerr issues
are requested through the configured connector only when its capability snapshot
contains `issue.read`; changing a Seerr issue additionally requires `issue.manage`.
The gateway merges available results by update time and returns an independent
health state for each source. A Seerr timeout therefore produces a partial local
queue instead of hiding usable information or pretending that the remote source is
healthy.

The current workbench intentionally uses bounded refreshes rather than implying a
live event stream. The interface retains its last verified snapshot when a refresh
fails and never assumes a mutation succeeded after an ambiguous response.

## Privacy and integrity boundaries

Seerr numeric issue identifiers are stored only in encrypted gateway records. A
keyed privacy digest supports stable lookup without making the identifier available
to SQLite indexes, while the browser receives a random opaque reference. External
references expire after 30 days and each connector is bounded to 4,096 records.
Local and external identifiers share one collision-checked namespace.

Mutation reservations and outcomes are durable in SQLite. Idempotency keys are
hashed per user, the intended issue/source/status tuple is fingerprinted, and the
stored outcome is replayed only for an exact match. Successful and failed decisions
write structured audit events without credentials, raw upstream payloads, media
paths, or external identifiers.

## Verification

The issue lifecycle is covered at four boundaries:

- contract tests reject extra fields, invalid identifiers, impossible episode
  coordinates, and oversized pages;
- connector fixtures normalize Seerr list/detail/status responses and safe failures;
- gateway integration tests cover partial results, authorization, CSRF, durable
  replay/conflict behavior, local/external namespace collisions, encrypted-reference
  tampering, and upstream unavailability;
- interface unit, Storybook, browser, accessibility, and deterministic visual tests
  cover the complete interaction and degraded-state matrix.

Protected live Seerr evidence is still required before the compatibility matrix can
mark the issue lifecycle as verified for a release.
