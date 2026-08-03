# Security model

Omnifin is designed to concentrate administrative access to several services, so a
completed deployment will have a larger compromise impact than a read-only media
client. This model defines the assets, adversaries, boundaries, and invariants used in
design and review.

> [!IMPORTANT]
> The current checkpoint implements defensive foundations plus OIDC authentication,
> opaque local sessions, identity resolution, authentication audit records, and hidden
> recovery access. Password and Quick Connect Jellyfin linking, RP-initiated logout,
> and provider-initiated OIDC back- and front-channel logout are implemented, while
> encrypted and audited connector administration is implemented through the versioned
> gateway API. Permission enforcement covers every current route and is repeated inside
> administrative services. Browser-safe user access administration additionally protects OIDC
> role ownership, self-lockout, the final active administrator, stale revisions, and atomic session
> revocation. Remaining connector breadth and upstream mutations are still incomplete. Controls
> for those remaining surfaces are mandatory implementation requirements, not claims
> of current support.

For vulnerability reporting, follow [SECURITY.md](../SECURITY.md).

## Protected assets

- OIDC client credentials, authorization responses, and identity assertions
- Jellyfin user tokens and connector API credentials
- session tokens, CSRF material, and recovery secrets
- role assignments, identity links, and authorization policy
- private media metadata, paths, history, and viewing activity
- the ability to request, grab, delete, import, scan, or edit media
- audit history and the integrity of migrations and release artifacts

## Assumed adversaries

The design considers an unauthenticated internet client, a low-privilege authenticated
user, a malicious media or metadata payload, a compromised or misconfigured upstream
service, an attacker who can induce server-side requests, and an observer with access
to application logs or a database backup. A host-level compromise is outside the
application boundary; operators must still patch and isolate the host.

## Required security invariants

1. The browser never receives reusable upstream credentials.
2. Every upstream mutation requires a local permission check at the gateway.
3. Identity linking requires current proof of control; mutable profile claims are
   not proof.
4. Sessions are server-side, revocable, rotated, and bounded by inactivity and
   absolute expiry.
5. State-changing browser requests require origin and CSRF validation.
6. Connector egress is limited to administrator-approved destinations and resists
   SSRF and redirect bypasses.
7. Sensitive stored values use authenticated encryption with a key outside the
   database.
8. Logs, diagnostics, and error responses redact credentials, cookies, assertions,
   media paths, and private upstream payloads.
9. Security-relevant actions leave durable, attributable audit records.
10. Releases are reproducible enough to bind source, image digest, provenance, SBOM,
    signature, and attestation.

## Required threat controls

| Threat                        | Primary controls                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Session theft or fixation     | Secure HttpOnly cookies, rotation, bounded lifetime, revocation, HSTS                             |
| Login CSRF or callback replay | PKCE S256, state, nonce, one-time transactions, exact issuer validation                           |
| Account-link takeover         | Fresh Jellyfin proof, immutable IDs, uniqueness checks, no email auto-linking                     |
| Privilege escalation          | Default viewer JIT role, explicit claim mappings, named local permissions, audit                  |
| Cross-site request forgery    | SameSite cookie, strict origin checks, session-bound CSRF token                                   |
| SSRF through connector setup  | Scheme/host validation, resolved-address checks, redirect policy, explicit local-network approval |
| Credential disclosure         | Gateway isolation, authenticated encryption, redaction, response schemas, secret scans            |
| Malicious upstream content    | Schema parsing, output encoding, content-type controls, media proxy allowlists                    |
| Destructive replay            | Idempotency keys or current-state preconditions, authorization, audit, safe confirmation UX       |
| Supply-chain compromise       | Locked dependencies, pinned actions, review gates, CodeQL, SBOM, provenance, signatures           |

## Current connector-administration controls

- Connector API keys and passwords are authenticated-encrypted with a context bound to
  both service and connector identity. Browser responses expose only the credential kind
  and whether credentials are configured.
- New connector records are disabled. A successful probe must persist normalized health
  and capabilities before enablement, and that evidence expires after ten minutes; any
  destination, credential, HTTP, CA, or TLS policy change disables the connector and
  clears the evidence.
- Destination literals are validated before storage and resolved addresses are checked at
  request time. Redirects remain blocked and DNS-pinned transports cannot fall back to an
  unvalidated address. Plain HTTP requires explicit approval. Self-signed TLS requires
  both explicit approval and a current connector-specific CA certificate, so certificate
  and hostname verification remain enabled.
- Every mutation requires a same-origin CSRF proof and the local `connectors.manage`
  permission. A recovery session instead uses `recovery.jellyfin.manage`; both the route and
  service constrain that session to Jellyfin records, and list queries exclude every other
  connector. The service repeats permission and scope checks so future non-HTTP callers cannot
  bypass authorization.
- Updates and deletion require the latest opaque revision. Enabled connectors cannot be
  deleted, and connectors referenced by a service identity link remain protected.
- Creation, validation, update, and deletion write bounded audit metadata without connector
  credentials, private response bodies, or raw client addresses.

## Current user-access administration controls

- User directory reads require `roles.manage` before any account data is returned. Recovery
  sessions cannot use the directory, even though they can repair OIDC or Jellyfin configuration.
- Browser responses are schema-bounded to display identity, role and provenance, local status,
  normalized sign-in methods, Jellyfin link health, and session counts/timestamps. Immutable OIDC
  subjects, issuers, external Jellyfin identifiers, connector details, tokens, and credentials are
  excluded.
- Role and account-state mutations repeat named-permission checks in the service, require a current
  `updatedAt` precondition, deny self-mutation, and preserve at least one active administrator.
- Any identity with OIDC ownership keeps its role controlled by claim mappings. The local route can
  suspend that identity, but cannot create a competing manual role source.
- Re-enablement derives `active` or `pending_link` from the stored Jellyfin link. The browser cannot
  nominate an arbitrary account status or claim that a revoked link is usable.
- The account update, target-session revocation, and sanitized `auth.user.access_updated` audit
  record commit atomically. Audit metadata contains only previous/new role and state plus the
  revoked-session count; client addresses are privacy-hashed.

## Operator audit-trail controls

- Reads require an active account with `audit.view` at both the route and service boundary. Recovery
  sessions are explicitly denied before audit rows are queried, even though their bounded recovery
  attempts remain available to a later ordinary administrator.
- The strict response contains only a keyed opaque event reference, normalized category, bounded
  event type, outcome, occurrence time, and safe actor summary. Metadata JSON, target, upstream,
  connector, request, session and identity identifiers, IP hashes, paths, addresses, credentials,
  assertions, cookies, CSRF values, and raw errors are never selected into the public contract.
- Current display names are control-stripped and length-bounded. Removed accounts, system activity,
  and recovery activity receive fixed labels so deleted or inaccessible identity detail is not
  reconstructed from private fields.
- Pagination is newest-first and bounded to 50 records. Authenticated-encrypted cursors bind the page
  size, filters, initial SQLite row boundary, and snapshot time. Filter mismatch, tamper, or another
  deployment's key fails with a stable invalid-cursor response.
- The endpoint is rate-limited and non-cacheable. The browser stores neither records nor cursors,
  preserves verified pages during a pagination failure, and does not provide export or deletion.
- Audit records remain part of the sensitive SQLite and verified-backup lifecycle. Host logs remain
  necessary for wider investigation; databases and backup files must never be attached to public
  support reports.

## Discovery-feed and artwork controls

- Feed reads require `media.view` before connector selection or credential decryption. Exactly one
  enabled, healthy Seerr connector with the required capability is accepted; ambiguity fails closed.
- The four fixed discovery reads execute concurrently with bounded per-rail timeouts and strict
  schemas. Partial results preserve safe rails, while raw payloads, service URLs, request records,
  internal identifiers, image paths, and private errors remain behind the gateway.
- Artwork paths are converted into random, encrypted, expiring references bound to the requesting
  user. A reference cannot be replayed by another account, used after expiry, or changed into an
  arbitrary connector destination.
- Artwork resolution repeats session, permission, owner, expiry, connector, and path checks before
  an upstream request. Redirects are blocked; response type, length, and transfer size are bounded;
  logging and errors exclude the protected path and response body.
- The browser receives only same-origin artwork-reference URLs and accepts only their exact grammar.
  Images are privately cacheable with a gateway ETag and `nosniff`; normalized feed responses are
  private, short-lived, and vary on the session cookie.

## Playback-proxy controls

- Playback negotiation and every manifest, segment, range, and progress request require
  `media.view` and the same active user-to-Jellyfin identity link revision that created the
  playback session. A stopped or expired session fails before connector credentials are decrypted.
- The browser receives only a random 31-character HLS asset handle. The resolved Jellyfin path and
  query are validated by the connector, encrypted in SQLite, integrity-bound to the playback
  session, and never placed in a URL, public response, log, or diagnostic.
- Handles are deduplicated within one playback session, capped per session and deployment, and
  removed when playback stops or the owning session is deleted. Expired-session cleanup cascades to
  its handles; unlinking the Jellyfin identity invalidates the session through its exact link and
  revision binding.
- One manifest allocates its handles atomically from a single bounded count snapshot. Rejected
  manifests leave no partial handles behind, and long VOD manifests do not require one SQLite
  transaction or full-table count per segment.
- Rolling upgrades continue accepting the former bounded `asset_v2` encrypted URL until its
  already-created playback session stops or expires. A player may safely renegotiate if an
  intermediary or operator invalidates that legacy session during deployment.
- Upstream targets remain constrained to Jellyfin playback paths without credential-bearing query
  fields. Redirects, oversized manifests, excessive line counts, unsafe content types, malformed
  ranges, and response-size overruns fail closed. Media responses are private, non-cacheable, and
  vary on the authenticated session cookie.

## Media-request mutation controls

- Request creation requires `request.create` at both the session route and service boundary,
  plus the global same-origin and session-bound CSRF policy. Recovery sessions cannot request
  media.
- The gateway derives Seerr user context only from the session's proven Jellyfin identity link.
  It resolves the exact immutable Jellyfin user identifier and sends the resulting numeric Seerr
  user in `X-API-User`; the browser cannot nominate another user or fall back to the API-key owner.
- The normalized body excludes upstream administration fields, quota bypasses, storage paths,
  profiles, tags, and arbitrary identifiers. Response parsing rejects schema drift before data
  crosses the gateway boundary.
- Per-user idempotency keys and canonical request fingerprints are stored only as hashes. A key
  cannot be reused for different input, known outcomes are replayed without another write, and an
  ambiguous pending outcome fails closed rather than risking a duplicate request.
- The idempotency outcome and sanitized audit event commit in one SQLite transaction. Audit records
  contain bounded media intent and normalized failure codes, never credentials, usernames,
  idempotency keys, private upstream messages, or media paths.

## Acquisition-provenance read controls

- Title provenance requires `acquisition.manage` at both the session route and service boundary.
  Unauthorized callers are rejected before connector selection or secret decryption.
- A request can nominate only `radarr` or `sonarr`, one bounded upstream media identifier, and an
  optional Sonarr season. Exactly one enabled, healthy, capability-verified matching connector is
  required.
- History and queue reads are independently bounded and parsed. Safe partial results survive one
  upstream failure; raw history data, queue statuses, download hashes, paths, and private errors do
  not cross the gateway boundary.
- Live provenance uses a short-lived, target-scoped SSE connection with opaque cursors, bounded
  replay, heartbeats, global and per-session capacity limits, and periodic session revalidation.
  Polling groups and replay entries include the Omnifin identity, so an encrypted recovery offer
  bound to one user is never reused for another user viewing the same title.
  The browser accepts a snapshot only when its schema, cursor, size, and exact selected target all
  match; otherwise it preserves the last verified view and falls back to bounded foreground polling.

## Acquisition-search mutation controls

- Automatic search requires an active user with `acquisition.manage` at both the session route and
  service boundary. Same-origin, session-bound CSRF, mutation rate limiting, and an abort signal are
  mandatory; recovery sessions cannot issue the command.
- The public contract accepts only one exact Radarr movie, Sonarr series, or Sonarr season target.
  The adapter maps that target to `MoviesSearch`, `SeriesSearch`, or `SeasonSearch`; arbitrary
  command names and destructive fields are impossible to express.
- Per-user idempotency keys and canonical target fingerprints are stored only as hashes. A pending
  outcome fails closed, a known success is replayed without another upstream call, and key reuse
  for another target is rejected.
- The normalized outcome and bounded audit event commit in one SQLite transaction. Stored and
  returned data exclude credentials, raw upstream commands, response bodies, paths, idempotency
  keys, and private errors.
- `POST /v1/acquisitions/searches` is abort-aware, rate-limited, and explicitly non-cacheable. Its
  exact-target body cannot express direct release selection, grabs, blocklisting, deletion, or
  arbitrary retry commands.

## Acquisition failed-queue recovery controls

- Failed-queue recovery requires an active user with `acquisition.manage` at both the session
  route and service boundary, same-origin validation, session-bound CSRF, mutation rate limiting,
  a bounded body, and per-user idempotency.
- The browser receives a five-minute authenticated-encryption reference only for a currently
  stalled queue event. It is bound to the user and exact connector, target, upstream queue item,
  normalized event fingerprint, and expiry. Public event IDs are keyed privacy hashes; raw queue
  IDs never cross the gateway boundary.
- The gateway selects the single healthy connector advertising `acquisition.queue.mutate`,
  decrypts the reference, then re-reads and uniquely matches the exact queue item. Expired,
  tampered, missing, duplicate, recovered, or state-changed items fail before mutation.
- The only adapter mutation is exact-item deletion with `removeFromClient=true`, `blocklist=true`,
  `skipRedownload=false`, and `changeCategory=false`. The contract cannot express a bulk target,
  arbitrary queue ID, category change, library deletion, or automatic retry search.
- A durable normalized snapshot and requested audit event commit before the upstream write. The
  item must disappear from a bounded follow-up read before success is recorded. Ambiguous
  post-mutation failures and abandoned post-mutation leases are never retried automatically.
- Operation rows and audits exclude the encrypted reference, raw queue ID, release title,
  download hash, path, credentials, upstream response, cookies, and CSRF value. Known success is
  replayed without another write; key conflicts, pending operations, and failed attempts fail
  closed.

## Acquisition-monitoring mutation controls

- Reads and updates require `acquisition.manage` at both the session route and service boundary.
  Updates additionally require an active user, same-origin validation, a session-bound CSRF token,
  a 2 KiB body limit, mutation rate limiting, and an abort signal; recovery sessions cannot mutate.
- The strict public contract can identify only one Radarr movie or one whole Sonarr series, its
  observed boolean, and the opposite desired boolean. Season, episode, path, file, profile, tag,
  queue, deletion, blocklist, and arbitrary editor fields are impossible to express.
- Exactly one enabled, healthy connector advertising `acquisition.monitoring` is selected before
  credential decryption. The gateway reads the exact target first and returns an already-desired
  state as a verified replay without another upstream write.
- The adapters send only `movieIds` or `seriesIds` plus `monitored`. The normalized response must
  confirm the exact target and desired state; mismatches and malformed responses fail closed.
- A durable requested event is inserted before any real upstream write, so audit storage failure
  prevents mutation. Updated, replayed, and failed follow-up outcomes carry bounded state metadata.
  Credentials, CSRF values, paths, raw editor responses, cookies, and private upstream errors are
  excluded.
- `GET` and `PUT /v1/acquisitions/monitoring` are abort-aware, rate-limited, and explicitly
  non-cacheable. Enabling monitoring does not itself queue a search; pausing it does not change
  existing files, downloads, queues, profiles, or tags.

## Download-queue controls

- Queue reads require `downloads.manage` at both the session route and service boundary.
  Unauthorized callers are rejected before connector selection or credential decryption.
- Only enabled, recently validated qBittorrent or SABnzbd connectors advertising
  `download.queue.read` are eligible. The gateway bounds connector fan-out, executes eligible
  reads concurrently, and returns safe partial results when one client fails.
- Client credentials are decrypted only inside the gateway. qBittorrent session cookies and
  SABnzbd API keys never cross the adapter boundary; raw hashes, upstream identifiers, paths,
  and private response fields never enter the public contract.
- Every returned transfer receives a deployment-local opaque identifier derived from its
  connector and upstream identifier. Item counts, byte values, rates, text, client count, and
  aggregate response size are independently bounded and schema-validated.
- `GET /v1/downloads/queue` is abort-aware, rate-limited, and explicitly non-cacheable. Filtering
  and refresh remain browser-local reads.
- Single-item pause, resume, and removal use separate strict action contracts containing one
  connector, one opaque item, and its observed state. Their `POST` routes require an active user,
  session-bound CSRF and same-origin validation, a 1 KiB body limit, mutation rate limiting, and
  `download.queue.mutate` on the selected healthy connector.
- The gateway resolves the opaque ID against a fresh exact-connector queue read, rejects missing or
  stale targets, writes a durable requested audit before mutation, and verifies the desired state
  with bounded post-write reads. Safe replay avoids a duplicate write when the state is already
  achieved. Public responses and audit metadata never contain the qBittorrent hash or SABnzbd
  `nzo_id`.
- Removal additionally requires a per-user idempotency key and a typed browser confirmation. The
  durable operation and requested audit commit before mutation; bounded verification requires the
  exact item to disappear. Recovery reuses the public item snapshot and fails closed on identifier
  reuse. qBittorrent is always called with `deleteFiles=false`, and SABnzbd is never called with
  `del_files=1`, preserving downloaded content.
- Bulk pause/resume requires a per-user idempotency key and 1–200 explicit opaque targets captured
  from the current browser view. The gateway persists ordered progress, revalidates and mutates each
  target through the exact-item path with concurrency capped at four, reports every outcome, and can
  resume missing targets after an expired recovery lease. It never sends a client-native bulk
  command or stores raw identifiers in its operation ledger or audit metadata.
- The public contracts cannot express downloaded-file deletion, relocation, categories, priorities,
  arbitrary URLs, wildcards, native identifiers, or client-native command fields.

## Acquisition-calendar read controls

- Calendar reads require `media.view` at both the session route and service boundary. Unauthorized
  callers are rejected before connector selection or credential decryption.
- Only enabled, currently healthy Radarr or Sonarr connectors advertising `acquisition.calendar`
  are eligible. The gateway bounds source fan-out, executes reads concurrently, and returns safe
  partial results when one source fails.
- Credentials are decrypted only inside the gateway. Raw upstream media identifiers, paths,
  provider fields, credentials, and private errors never enter the public contract; events and
  sources receive deployment-local opaque identifiers.
- Date windows, page sizes, source counts, source events, text, episode coordinates, runtimes, and
  aggregate response size are independently bounded and schema-validated. Gateway-signed cursors
  are bound to the exact requested range and compared in constant time.
- `GET /v1/acquisitions/calendar` is abort-aware, rate-limited, explicitly non-cacheable, and
  read-only. The browser offers search, filtering, bounded week/month navigation, and refresh but no monitoring,
  search, grab, deletion, or rescheduling mutation in this slice.

## Indexer Intelligence controls

- Reads and tests require `acquisition.manage` at both the session route and service boundary.
  Unauthorized callers are rejected before connector selection or credential decryption.
- Exactly one enabled, healthy, capability-verified Prowlarr connector is required. Reads require
  `indexer.statistics`; tests require `indexer.test`. Ambiguous, malformed, or mismatched
  connector state fails closed.
- Inventory, statistics, status, applications, and failure history are independently bounded and
  schema-validated. Normalized responses exclude raw queries, hosts, sources, paths, provider
  fields, credentials, and private upstream messages.
- A safe test accepts only one bounded positive indexer identifier. The gateway retrieves the
  secret-bearing provider resource, verifies its identifier, bounds it, and sends it directly to
  Prowlarr; the provider body never enters or leaves the browser boundary.
- Tests require an active identity, same-origin session-bound CSRF validation, abort propagation,
  and a three-per-minute route limit. Sanitized success and failure audits contain no provider
  payload, credential, address, or private error.

## System-health controls

- Reads require `acquisition.manage` at both the session route and service boundary. Unauthorized
  callers are rejected before connector selection or credential decryption.
- Only enabled, currently validated Radarr, Sonarr, and Prowlarr connectors advertising
  `system.health` are eligible. Capacity reads additionally require `storage.read`; source fan-out
  is bounded and an over-limit deployment fails closed.
- Health and storage payloads are independently bounded and schema-validated. Upstream paths are
  used only as inputs to deployment-local keyed identifiers, then replaced with non-sensitive
  ordinal labels before public validation.
- Normalization removes control characters, URLs, filesystem paths, and configured API keys from
  warning text. Public contracts exclude upstream identifiers, wiki links, raw provider fields,
  credentials, and private connector diagnostics.
- `GET /v1/system/status` is abort-aware, read-only, rate-limited, and explicitly non-cacheable.
  Partial failures retain only independently verified telemetry and never infer a healthy state.

## Browser protections

The web and gateway emit Content Security Policy, HSTS for secure requests,
`nosniff`, frame restrictions, restrictive referrer policies, and minimal permissions
policies. OIDC client secrets, token responses, ID and access tokens, and session
tokens remain in the gateway; the browser receives only an opaque HttpOnly session
cookie and safe provider and principal contracts after sign-in. The standard code
flow necessarily carries a transient, PKCE-bound authorization `code`, one-time
`state`, or provider error through the browser callback. Callback responses are
`no-store`, use the restrictive referrer policy, consume state once, and immediately
redirect to a fixed local URL. Operators must configure reverse proxies and access
logs not to persist callback query strings. No reusable credential may enter a query
string, browser storage, client log, analytics, or error-reporting service. External
telemetry is off by default.

The web process handles `/api` through a controlled streaming proxy rather than a
generic rewrite. It confines normalized targets to `/v1` and removes untrusted
forwarding and client-address headers. In the loopback-bound Compose topology, an
explicit trusted-edge hop count lets it retain only the validated IP immediately
before the maintained proxy chain, then pass that single address across the private
web-to-gateway hop. Caller-controlled prefix entries are discarded, while malformed
selected entries and oversized chains fail closed. The proxy also replaces
caller-supplied request IDs before preserving distinct
`Set-Cookie` and redirect headers, and it returns a bounded `no-store` error on gateway
failure. Its outage log contains only a generic event name and a fresh request ID—never
the callback path, query, upstream error, authorization code, state, or provider
diagnostic.

## Current OIDC threat-model controls

- **Spoofing:** exact discovery issuer matching, pinned client and signing settings,
  signature, audience, expiry, nonce, and subject validation; identities use
  `(issuer, sub)` rather than email or username.
- **Tampering and replay:** PKCE S256, high-entropy state and nonce, an HttpOnly
  preflight binding cookie plus a transaction-specific HttpOnly binding cookie,
  one-time transaction consumption, security-configuration binding, and a callback
  URL reconstructed from the canonical public origin. The per-state cookie lets
  concurrent tabs complete independently without accepting another tab's binding.
- **Repudiation:** bounded authentication audit outcomes retain correlation and request
  context without storing authorization responses, tokens, or upstream diagnostics.
- **Information disclosure:** fixed browser error codes, response-schema allowlists,
  encrypted client secrets, no-store responses, and structured-log redaction keep
  provider details and assertions server-side.
- **Logout integrity:** an exact same-origin form CSRF proof authorizes RP-initiated
  logout. The gateway atomically revokes and audits the local session before releasing
  non-serializable provider material, uses only the validated discovered end-session
  endpoint, and falls back to a completed local logout if discovery is unavailable.
  Provider-initiated back-channel requests use no browser authority: the gateway
  validates a signed, issuer/client-bound, time-bounded Logout Token through the
  approved JWKS transport. It requires the logout event, rejects `nonce`, scopes
  revocation by the private `sid` hash and/or immutable subject, and commits the replay
  receipt, revocation, and sanitized audit event in one immediate transaction.
  Front-channel logout requires exact provider, issuer, and session parameters, scopes
  revocation by the provider and private `sid` hash, and atomically records only newly
  revoked sessions. The successful empty document is frameable only by the validated
  issuer origin; all denials retain the global frame prohibition.
- **Denial of service:** bounded request targets, per-client start and callback limits,
  a server-wide start limit, separate non-blocking server-wide start and callback
  audit-write budgets, and durable no-write caps for duplicate and saturated failure
  buckets limit unauthenticated SQLite write pressure. Bounded discovery timeouts,
  exponential failure backoff, and bounded in-memory caches limit upstream work, while
  audit-budget exhaustion does not alter an otherwise valid authentication response.
  A valid session can create at most one CSRF-denial audit row, so replaying an invalid
  CSRF proof cannot turn a low-privilege account into an audit-storage amplifier.
  Authenticated issuance is capped at 16 active sessions and 32 new sessions per user
  in a rolling 24-hour window. Both checks run in the session creation transaction,
  remain effective across processes and restarts, and deny without adding session or
  secret-reservation rows. Reauthentication replacements count against the rolling
  budget.
  Recovery issuance has a separate eight-per-24-hour durable budget and a singleton
  active-session invariant, so replay of a valid break-glass secret cannot become a
  session-storage amplifier or displace ordinary user capacity.
- **Elevation of privilege:** new JIT identities default to `viewer`; privileged roles
  require an explicit validated claim mapping, and identity plus session changes commit
  atomically. Direct Jellyfin sign-in also remains viewer-default even when Jellyfin marks
  the upstream account as an administrator. The first local administrator requires a
  CSRF-proven recovery session and either an exact PKCE-bound OIDC callback or fresh Jellyfin
  proof with an explicit upstream administrator policy. The immediate SQLite transaction aborts
  when another active local admin already exists, and the recovery session is replaced rather
  than upgraded in place. An OIDC bootstrap administrator remains denied from media operations
  until separately proving control of a Jellyfin account.

Password and Quick Connect Jellyfin proof-of-control pairing now have
immutable-ownership, exact-session binding, CSRF, session-rotation, migration, token
erasure, revocation, relinking, and secret-preservation tests. The pinned isolated Authentik gate
exercises authorization, a guarded role-mapping update, RP logout, and provider-initiated
back-channel revocation. The standards-generic gate additionally proves that an update revokes the
active mapped session and that fresh sign-in reuses the immutable identity with its new role.
Protected live compatibility evidence remains separate from this development gate and is required
before a public support claim.

## Stack-verification controls

- **Spoofing:** only a server-resolved session with both connector and OIDC recovery administration
  permissions may run the report. The mutation-shaped request requires the exact canonical origin
  and the current session CSRF proof; partial recovery and operator roles fail at route and service
  boundaries.
- **Tampering:** every connector result must bind the returned service and connector identifier to
  the exact stored row before aggregation. The response uses a strict versioned schema, canonical
  service and field order, internally derived counts and states, and closed capability and finding
  enums.
- **Repudiation:** the assembled report is not an audit log and is not persisted. The underlying
  connector and OIDC validation paths refresh their existing minimal success or failure audit
  events. The report has a bounded generation time and explicitly identifies itself as a local
  diagnostic.
- **Information disclosure:** connector and provider identifiers, names, destinations, users,
  claims, media data, paths, credentials, assertions, raw errors, request metadata, and audit data
  cannot enter the response schema. Upstream version strings are exported only through a narrow
  64-character grammar; rejected values become `version_redacted`.
- **Denial of service:** the endpoint permits two starts per minute and one in-flight run per
  administrator session. It reads at most 100 connector and 50 OIDC records, runs no more than four
  upstream checks concurrently, and inherits the fixed timeouts and response-size limits of the
  hardened adapters and OIDC discovery client.
- **Elevation of privilege:** verification performs no upstream write. It may refresh only local
  health/discovery snapshots and the normal validation audits; it cannot enable a service, change a
  role, mint a session, expose a credential, or convert diagnostic success into a compatibility or
  authorization decision.

## Deployment-doctor controls

- **Spoofing:** the maintenance command accepts no destination argument. It uses the configured
  canonical HTTPS origin and fixed private gateway endpoints, keeps ordinary certificate and hostname
  validation enabled, follows no redirects, and requires exact bounded health/readiness shapes.
- **Tampering:** the storage check opens an existing regular SQLite file read-only, runs a bounded
  quick check plus foreign-key validation, and requires a readable non-empty migration ledger. The
  image check accepts only a full `sha256` digest reference.
- **Repudiation:** each versioned report includes a bounded generation time and deterministic ordered
  results. The command does not claim to be an authenticated audit event; operators retain it with
  the host's own invocation and change records.
- **Information disclosure:** successful and failed checks return only enumerated IDs, states, and
  reason codes. Origins, hostnames, addresses, paths, image values, headers, bodies, database values,
  environment values, and exception text cannot enter the report schema.
- **Denial of service:** network checks have fixed timeouts, private bodies have strict byte limits,
  public bodies are discarded, and SQLite uses `quick_check(1)` instead of a full integrity scan.
- **Elevation of privilege:** the rootless read-only maintenance container mounts no encryption or
  recovery secrets for the doctor. The command performs no database, backup, session, or upstream
  mutation and provides no insecure TLS override.

## Scheduled-backup retention controls

- **Spoofing:** the retained-backup command accepts no output or deletion path. It writes only beneath
  the configured private backup directory and recognizes a strict UTC-plus-random generated basename.
  Retention candidates require an exact database/manifest pair in the existing backup format and the
  managed-retention manifest marker; generated-looking manual backups are preserved and rejected.
- **Tampering:** a new recovery point is independently verified before retention begins. Every
  candidate is a private regular file pair and passes manifest, byte-count, SHA-256, SQLite integrity,
  foreign-key, migration-count, and schema checks before any pair is retired. Symlinks, partial pairs,
  scan failures, hard failures, and tampered bytes stop pruning while preserving the new verified pair.
- **Repudiation:** each invocation emits one structured result with operation, state, safe basenames,
  counts, digests, and an enumerated attention reason. Host schedulers retain the invocation time,
  exit code, image digest, and unit identity; Omnifin never writes paths or exception text to the
  report.
- **Information disclosure:** output and errors exclude the configured directory, database path,
  environment, credentials, and raw filesystem messages. Backup contents remain sensitive and require
  private local and off-host access control.
- **Denial of service:** retention is bounded to `2..365`, directory enumeration stops after 10,000
  entries, generated candidate evaluation stops after 730 pairs, and verification is sequential.
  An invalid or excessive set preserves the new verified backup and returns temporary failure instead
  of continuing deletion.
- **Elevation of privilege:** scheduling stays outside the rootless distroless image. The operation has
  no arbitrary target, wildcard, recursive removal, network call, or privilege transition. Pair
  retirement uses same-directory renames, directory synchronization, explicit rollback, and a
  fail-closed attention state for cleanup or rollback failure.

Clock rollback cannot make the current recovery point an expiry target. Generated points within a
15-minute overlap window are also protected, so concurrent starts temporarily exceed retention rather
than delete one another's result. systemd single-instance execution or an external cron `flock` remains
the normal first line of overlap prevention.

Media proxy responses enforce an approved upstream origin, safe content types, byte-range limits,
authorization on every request, and cache rules that do not expose one user's protected content to
another.

## Operational controls

Future supported deployments should place Omnifin on a segmented network with only
required egress to configured services, terminate HTTPS at a maintained reverse proxy,
protect host and backup access, and use distinct least-privilege connector credentials
where an upstream service supports them. Internet-facing access should sit behind rate
limiting and normal infrastructure monitoring.

Audit records support investigation without replacing host logs. They share the SQLite and
verified-backup lifecycle, expose no browser export or deletion control, and preserve user privacy at
the public contract boundary. A database backup contains private metadata and encrypted secrets while
the master key separately enables decryption; both require protection.

## Vulnerability scanning policy

The pinned Trivy scanner produces a complete SARIF report for source and container
scans, including low, medium, unfixed, and fixable findings. Reporting is separate from
enforcement: CI fails on fixable high or critical vulnerabilities and independently
fails on high or critical secret and infrastructure findings. Unfixed vulnerabilities
remain visible and are reevaluated by scheduled scans as upstream fixes become
available; excluding them from the blocking pass is not a risk acceptance or a report
suppression.

Do not add directory-wide, file-wide, status-wide, or severity-wide ignores to make a
check green. A future false-positive exception must identify the exact finding and
affected package or path, explain the deployment-specific reasoning, include an expiry,
and receive security review in the same pull request.

## Review gates

A security-sensitive feature is not complete until it has:

- a threat-model update covering spoofing, tampering, repudiation, disclosure,
  denial of service, and elevation of privilege;
- negative tests for invalid credentials, permissions, replay, timeout, and malformed
  upstream data;
- a secret-leak inspection across logs, responses, browser storage, and build output;
- an account and session lifecycle test where applicable; and
- review of dependency, container, infrastructure, and migration changes.
