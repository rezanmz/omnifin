# Security model

Omnifin is designed to concentrate administrative access to several services, so a
completed deployment will have a larger compromise impact than a read-only media
client. This model defines the assets, adversaries, boundaries, and invariants used in
design and review.

> [!IMPORTANT]
> The current checkpoint implements defensive foundations plus OIDC authentication,
> opaque local sessions, identity resolution, authentication audit records, and hidden
> recovery access. Password and Quick Connect Jellyfin linking, RP-initiated logout,
> and provider-initiated OIDC back-channel logout are implemented, while front-channel
> logout, complete permission enforcement, connector
> administration, media proxying, and upstream mutations remain incomplete. Controls
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
  atomically.

Password and Quick Connect Jellyfin proof-of-control pairing now have
immutable-ownership, exact-session binding, CSRF, session-rotation, migration, token
erasure, revocation, relinking, and secret-preservation tests. Provider-initiated
front-channel OIDC logout and full permission enforcement still need completed
threat-model gates before Phase 1 can pass.

When media proxying is implemented, responses must enforce an approved upstream
origin, safe content types, byte-range limits, authorization on every request, and
cache rules that do not expose one user's protected content to another.

## Operational controls

Future supported deployments should place Omnifin on a segmented network with only
required egress to configured services, terminate HTTPS at a maintained reverse proxy,
protect host and backup access, and use distinct least-privilege connector credentials
where an upstream service supports them. Internet-facing access should sit behind rate
limiting and normal infrastructure monitoring.

When implemented, audit records must support investigation without replacing host
logs, and their retention and export must preserve user privacy. Once product data is
stored, a database backup may contain private metadata and encrypted secrets while the
master key separately enables decryption; both require protection.

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
