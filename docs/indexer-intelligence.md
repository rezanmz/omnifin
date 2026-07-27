# Indexer Intelligence

Omnifin exposes a normalized operational view of Prowlarr indexers, application
sync, failure history, and safe connectivity tests. It is a pre-release development
surface; the [compatibility matrix](compatibility.md) remains authoritative for
supported upstream versions.

## Authorization and connector selection

Every Indexer Intelligence route requires an authenticated principal with
`acquisition.manage`. Anonymous users, viewers, requesters, recovery sessions, and
pending identity links are rejected before connector configuration or credentials are
read. The current role model grants this permission to operators and administrators.

Exactly one enabled Prowlarr connector must exist. Its most recent capability snapshot
must identify the same connector and service, be healthy, and advertise
`indexer.statistics` for reads or `indexer.test` for a test. Missing, ambiguous,
malformed, or capability-incompatible state fails closed. The gateway decrypts the API
key and optional trusted CA only for the upstream request.

## Normalized API

The gateway publishes four versioned endpoints:

- `GET /v1/indexers/intelligence` joins indexer definitions, a bounded 24-hour
  statistics window, and disabled-until health state.
- `GET /v1/indexer-applications` returns bounded application-sync destinations.
- `GET /v1/indexer-failures` returns rejected history in newest-first pages.
- `POST /v1/indexers/:indexerId/tests` runs a safe connectivity test for one exact
  positive identifier.

Read pages use opaque, request-bound cursors. Responses are `no-store`, abort-aware,
rate-limited, and parsed through shared contracts before crossing the gateway
boundary. Indexer records contain only bounded identity, protocol, privacy, feature,
state, count, duration, and success-rate fields. Failure records contain a normalized
kind, summary, timestamp, indexer identifier, and optional bounded latency. Raw search
queries, hosts, sources, provider fields, paths, and upstream messages are excluded.

## Safe test boundary

Prowlarr requires the full provider resource to test an indexer, and that resource can
contain reusable credentials. Omnifin first fetches the exact provider record inside
the gateway, verifies that its identifier matches the requested target, bounds its
serialized size, and posts it directly back to Prowlarr. The browser supplies no
provider body and receives only the target identifier, normalized outcome, and test
time.

The mutation requires an active local identity, same-origin validation, a
session-bound CSRF token, and a three-per-minute route limit. Success and failure are
audited with a bounded connector identifier, indexer identifier, outcome, normalized
failure code, request correlation, and privacy-preserving network hash. Credentials,
provider payloads, private errors, and addresses are never recorded.

## Partial failure behavior

Indexer definitions are required evidence. Statistics and disabled state are fetched
independently; if one optional source fails, verified definitions remain available
with zero-value telemetry, a typed partial failure, and `state: degraded`. Application
sync and failure history are independent browser sections, so one unavailable source
does not collapse the control room. If required evidence is unavailable, the route
returns a stable sanitized error instead of presenting an authoritative empty state.

## Interface behavior

The dedicated Operations workspace presents a quiet content hierarchy beneath
adaptive Liquid Glass navigation and command controls. It supports light, dark, and
live system appearance, keyboard and touch operation, reduced motion, responsive
phone through desktop layouts, and explicit ready, loading, empty, degraded,
unconfigured, offline, signed-out, and permission-denied states. Storybook,
accessibility, hydration, interaction, and deterministic visual tests cover the
assembled surface.

## Verification

Deterministic connector fixtures cover definitions/statistics/status joins,
application sync, failure normalization, partial failure, pagination, secret
isolation, exact-target testing, and mismatched-provider rejection. Gateway tests
cover authorization before storage access, capability and connector integrity,
encrypted credentials, cursors, safe errors, CSRF/origin enforcement, rate limits,
auditing, response headers, and abort propagation.

The live probe verifies version discovery, authentication, inventory, statistics,
failure status, application sync, and failure-history response shapes. Safe mutation
evidence remains in the isolated fixture until a disposable live Prowlarr environment
is provisioned. The fixture contract is aligned with the Prowlarr `2.5.2.5491` API
surface, but this is not a public version-support claim; exact live versions and dates
must be recorded under the compatibility policy first.
