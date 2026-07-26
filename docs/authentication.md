# Authentication and account linking

This document records the current authentication checkpoint and the remaining Phase 1
authentication and authorization contract. It is for operators evaluating readiness
and contributors changing a security-sensitive flow.

> [!IMPORTANT]
> The current development branch implements the OIDC browser flow, JIT identity
> resolution, direct Jellyfin password and Quick Connect sign-in, password and Quick
> Connect OIDC-to-Jellyfin pairing, opaque sessions, and break-glass recovery, but Phase 1 has
> not passed its release gate. There is not yet a supported operator path for
> configuring providers, and provider-coordinated OIDC logout remains incomplete. Treat this
> document as development evidence, not a production support claim.

## Current development surface

The gateway exposes browser-safe provider metadata, OIDC start and callback endpoints,
direct Jellyfin password and Quick Connect authentication, CSRF-protected password
and Quick Connect pairing for pending OIDC users, session inspection and revocation,
and hidden recovery access. A discovered OIDC
provider is offered by the sign-in screen only when its persisted capability snapshot
is internally consistent and ready. Unchecked, failed, or malformed providers fail
closed as unavailable or misconfigured.

The OIDC flow currently creates or resolves an external identity keyed by immutable
issuer and subject, applies explicit role mappings, provisions a `viewer` by default
when JIT is enabled, and creates an opaque server-side session atomically. It does not
yet provide supported provider administration, RP-initiated or provider-initiated
logout, back-channel logout,
or the complete application permission surface. The
[roadmap](roadmap.md) and [compatibility matrix](compatibility.md) remain the source of
truth for verified availability.

## Phase 1 sign-in choices

When Phase 1 is complete, a normal user will be able to sign in through either:

- a configured OpenID Connect provider, such as Authentik; or
- Jellyfin username and password or Jellyfin Quick Connect.

The current login screen receives only safe provider metadata. Client secrets,
upstream token responses and identity assertions, runtime security seals, detailed
discovery failures, and internal configuration never reach the browser. The standard
OIDC redirect still carries its transient `code`, one-time `state`, or provider error
through the callback URL; operators must exclude those callback query strings from
reverse-proxy access logs. Multiple OIDC issuers are supported by the data model even
when an installation uses only one.

Provider states have deliberately narrow meanings:

- `available` means the enabled provider has a structurally valid last successful
  discovery snapshot. It is not a guarantee that the issuer is reachable now.
- `unavailable` means the provider has not passed discovery or its latest discovery
  failed. An OIDC row offers an explicit retry action; selecting it re-enters the
  bounded start path and recovery cooldown. Jellyfin remains non-interactive when its
  connector is disabled or cannot be selected unambiguously.
- `misconfigured` means persisted discovery or security attribution is inconsistent
  and requires administrator repair; the row is non-interactive.

An empty successful response is shown as an unconfigured installation. A timeout,
malformed response, or failed gateway request produces the distinct control-plane
unavailable state. Discovery runtimes cache for five minutes; failures back off from
30 seconds to five minutes, with up to five seconds of bounded jitter. A security-
relevant provider configuration change bypasses a stale cooldown.

## Current authentication browser routes

Browsers use the same-origin web routes below. The web process forwards them to the
versioned gateway API; operators must not expose the gateway directly.

| Route                                                             | Purpose                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/auth/providers`                                         | Return the bounded browser-safe provider list.                          |
| `GET /api/auth/oidc/{providerId}/start`                           | Bind the browser, create a one-time transaction, and start OIDC.        |
| `GET /api/auth/oidc/callback/{providerId}`                        | Consume the transaction, validate the grant, and establish a session.   |
| `POST /api/auth/jellyfin/password`                                | Verify credentials with Jellyfin and establish a local session.         |
| `POST /api/auth/jellyfin/link/password`                           | Pair fresh credentials to the exact pending OIDC session.               |
| `POST /api/auth/jellyfin/link/quick-connect`                      | Create Quick Connect proof bound to the exact pending OIDC session.     |
| `POST /api/auth/jellyfin/link/quick-connect/{transactionId}/poll` | Complete pairing only for the originating OIDC session.                 |
| `POST /api/auth/jellyfin/quick-connect`                           | Create a browser-bound Quick Connect code transaction.                  |
| `POST /api/auth/jellyfin/quick-connect/{transactionId}/poll`      | Poll by opaque ID and establish a session only after approval.          |
| `GET /api/auth/session`                                           | Inspect and, when due, rotate the current local session.                |
| `DELETE /api/auth/session`                                        | Revoke the current session; requires same-origin CSRF protection.       |
| `DELETE /api/auth/sessions`                                       | Revoke every local session owned by the current user.                   |
| `GET /api/auth/identity-links`                                    | Inspect the current user's normalized Jellyfin link and health.         |
| `DELETE /api/auth/identity-links/{linkId}`                        | Revoke an owned link, erase its token, and reduce local authority.      |
| `POST /api/auth/recovery/session`                                 | Hidden, rate-limited recovery endpoint; never linked from the login UI. |

Register the exact callback
`<OMNIFIN_BASE_URL>/api/auth/oidc/callback/{providerId}` with each identity provider.
`OMNIFIN_BASE_URL` is a canonical origin only: it cannot contain credentials, a path,
query, or fragment. Start requests accept at most one `returnPath`, currently `/` or
`/settings`; all other redirect targets fail closed.

The first start request may issue a short-lived preflight binding cookie and redirect
once to the same start route before contacting the identity provider. Each created
transaction then receives its own state-named HttpOnly binding cookie. A callback can
therefore clear exactly its own cookie while concurrent tabs retain independent
one-time transactions, without exposing binding material to JavaScript.

## Implemented OIDC flow

The implementation uses Authorization Code Flow with PKCE S256. It never uses the
implicit grant or resource-owner password grant.

1. The gateway discovers metadata from the configured issuer and validates that the
   discovered issuer exactly matches the configured issuer.
2. It creates high-entropy PKCE, `state`, and `nonce` values, persists only the
   short-lived transaction state, and redirects to the provider.
3. The callback binds to the same browser, consumes the transaction exactly once, and
   validates state, code exchange, signature, issuer, audience, expiry, and nonce.
4. The external identity is keyed by `(issuer, sub)`. Email address and username are
   display claims, never identity keys.
5. A new identity is provisioned only when JIT provisioning is enabled. Its default
   role is `viewer` unless an explicit configured claim mapping grants another role.
6. Identity resolution, audit attribution, prior-session revocation, and new-session
   creation commit atomically before the browser receives the session cookie.

Default scopes must be `openid profile email`. Additional group or entitlement claims
may be requested only when an operator configures a role mapping. Omnifin must not ask
for `offline_access`, because it does not need long-lived access to an identity provider
API.

Provider-initiated and RP-initiated logout still must be supported when advertised by
provider metadata. A back-channel logout token must be validated against the same
issuer and client constraints before affected local sessions are revoked.

Authorization transactions expire after ten minutes and are consumed before the
callback interprets provider success or failure. A wrong browser binding does not
consume another tab's valid transaction. Provider configuration is bound into the
transaction so a security-relevant configuration change invalidates an in-flight
grant. The callback URL used for token exchange is reconstructed from the configured
public URL rather than request forwarding headers. Only `account_not_authorized`,
`authorization_denied`, `authentication_failed`, `invalid_request`,
`provider_unavailable`, and `session_limit_reached` may reach
`/login?authError=...`; arbitrary values and upstream details are discarded. Fixed
browser errors and bounded audit reasons prevent
provider diagnostics or assertions from leaking through redirects or application
logs.

OIDC starts are limited to 20 per minute per client network and 512 per ten minutes
server-wide. In the bundled topology, the loopback-bound web service trusts the exact
maintained edge hop count, discards caller-controlled forwarding prefixes and all
other address assertions, and passes one validated IP across the private gateway hop.
Directly reachable web processes must use a trusted-hop count of zero and enforce
per-client limits at their public edge. A separate 512-per-ten-minute server-wide start
budget is reserved before
each attempted start failure-audit write, including route-limit errors. Successful
preflights and authorization starts consume no audit-work units; exhaustion suppresses
only additional audit writes and does not change the start response. Callbacks are
limited to 30 per minute per client network. A separate 512-per-ten-minute server-wide
callback budget limits failure-audit write work; once that budget is exhausted,
callback validation and legitimate sign-in continue, but additional failures are
intentionally not written to the audit budget. Provider
metadata is limited to 60 requests per minute, and every route remains under the
gateway-wide 300-per-minute client limit. IPv6 addresses group by `/64`, and
IPv4-mapped IPv6 addresses normalize to IPv4. Discovery failures enter bounded
exponential backoff so an unavailable issuer cannot be hammered by every login
attempt. Actual request-limit failures use `429`, `Retry-After`, and `no-store`
directives; rate-limited callbacks do not create another failure-audit write. Failure
audits coalesce duplicate client-network and reason buckets; once the durable
suppression counter or distinct-bucket capacity is full, further duplicate or
saturated failures make no SQLite changes, including after the audit service reopens
the database within the same window.

Authenticated session issuance is also bounded inside the same immediate database
transaction that creates the session. One user may hold at most 16 active sessions and
may receive at most 32 new sessions in any rolling 24-hour window. Exact
reauthentication replacement receives credit for the active session it replaces, but
still consumes the rolling issuance budget. Concurrent gateway processes cannot race
either boundary. A limit denial creates no session, secret reservation, or session
success audit; the callback records one bounded `session_limit_reached` denial and the
login screen gives a safe recovery instruction. Historical secret digests remain
reserved so a stale bearer or CSRF value cannot become valid again after a restart.

## OIDC-to-Jellyfin pairing

An OIDC identity alone does not grant media access. After first OIDC sign-in, the user
must prove control of a Jellyfin account. Password and Quick Connect proof are
implemented; the remaining lifecycle controls are still Phase 1 work.

- Credential pairing must be sent directly from the gateway to Jellyfin. The password
  must be discarded as soon as the exchange completes.
- Quick Connect must be considered complete only after Jellyfin confirms the user and
  returns an authenticated session.
- Only the resulting Jellyfin token may be retained, encrypted at rest.
- Email or username similarity must never create or change a link.
- A Jellyfin identity may not be linked to multiple Omnifin accounts without an
  explicit conflict-resolution flow and fresh proof of control.

The paired identity must supply library visibility, playback permission, watch state,
progress, and user context for compatible Seerr operations. If Jellyfin is unavailable,
the OIDC identity may remain pending, but media operations must stay denied. Users can
inspect normalized link health, relink through either fresh proof method, revoke the
link, and revoke all of their local sessions.

`POST /v1/auth/jellyfin/link/password` requires the exact session cookie, matching
CSRF token, and same application origin before credentials are parsed or Jellyfin is
contacted. The gateway binds the authenticated Jellyfin `(connector, server, user)`
identity to the pending session's immutable local user ID inside one immediate SQLite
transaction. It refuses an identity already owned by another user and never considers
email, display name, or username similarity. Successful pairing encrypts the Jellyfin
token, activates the user, preserves OIDC issuer, subject, logout-session attribution,
and ID-token hint, revokes the pending bearer plus the user's other local sessions,
and returns a newly issued OIDC-attributed session. Password bytes are discarded after
the upstream exchange.

`POST /v1/auth/jellyfin/link/quick-connect` creates the same five-minute encrypted
proof transaction as direct Quick Connect sign-in, but additionally binds it to the
exact CSRF-proven pending OIDC session and marks its purpose as pairing. Polling
requires that same still-eligible session, its CSRF token, the application origin, the
opaque transaction identifier, and the separate browser-binding cookie. A different
valid session for the same user cannot adopt the transaction. Successful approval uses
the same immutable identity ownership checks and atomic OIDC session replacement as
password pairing; the Jellyfin token remains encrypted and the OIDC attribution and
absolute session expiry are preserved.

`GET /v1/auth/identity-links` returns at most the current user's browser-safe Jellyfin
link; access tokens, device identifiers, connector configuration, and other users are
never included. `DELETE /v1/auth/identity-links/{linkId}` requires origin and CSRF
proof, erases the encrypted Jellyfin token, marks the user pending-link, and revokes
all sibling sessions atomically. A current OIDC session is reduced in place to the
pending-link permission set so the user can immediately provide fresh password or
Quick Connect proof; a direct Jellyfin session is revoked because it cannot establish
independent OIDC ownership. Relinking updates the existing immutable link rather than
creating a second user or link.

## Current direct Jellyfin sign-in

`POST /v1/auth/jellyfin/password` exchanges a bounded username and byte-preserved
password directly with the configured server. The gateway verifies that Jellyfin's
public server identifier matches the token issuer, creates or resolves the local user
only from the immutable connector, server, and Jellyfin user identifiers, encrypts the
resulting token with link-bound authenticated encryption, and issues a local opaque
session. The password is never persisted and neither it nor the Jellyfin token reaches
browser storage or the response. Exact-origin enforcement, bounded request bodies,
per-client and global credential limits, connector-binding revalidation, and safe audit
metadata protect the public route.

`POST /v1/auth/jellyfin/quick-connect` creates a five-minute, browser-bound transaction
and returns only an opaque local transaction identifier, a display code, expiry, and
polling cadence. The Jellyfin secret, device identifier, expected server identity, and
connector revision are stored in an authenticated-encryption envelope. Polling is
same-origin, cadence-limited, capped per browser and globally, and consumes an approved
transaction before exchanging its secret for a Jellyfin token. The resulting identity
uses the same immutable reconciliation and session path as password sign-in. A stolen
transaction identifier cannot be polled without the separate `HttpOnly`, `SameSite=Lax`
browser-binding cookie, and connector changes invalidate outstanding attempts.

An operator disabling direct Jellyfin sign-in must first verify a working OIDC admin
path or retain the documented recovery secret once those controls are available.

## Required local roles

Upstream credentials often carry broad administrative power, so all authority must be
decided locally.

| Role        | Intended authority                                                                            |
| ----------- | --------------------------------------------------------------------------------------------- |
| `viewer`    | Browse permitted libraries, view personal state, and play allowed media.                      |
| `requester` | Viewer permissions plus create and manage permitted requests.                                 |
| `operator`  | Requester permissions plus day-to-day queue, acquisition, issue, and safe library operations. |
| `admin`     | Configure identity, roles, connectors, security policy, and destructive operations.           |

Routes must check named permissions rather than comparing role strings inline.
Privileged role mappings must match an explicit configured claim path and value.
Missing, malformed, or ambiguous claims must never elevate access. Role changes must
revoke or refresh affected sessions and create audit records.

## Required sessions and request protection

Browser sessions must use opaque random values stored in `Secure`, `HttpOnly`,
`SameSite=Lax` cookies. The database must retain a one-way token digest. Sessions must
rotate after authentication and privilege changes, expire after inactivity and at an
absolute deadline, and be revocable individually or account-wide. The account-wide
route uses the CSRF-proven session as its actor, revokes all of that user's active
sessions in one immediate transaction, emits one bounded audit event with the revoked
count, and cannot affect a different account.

State-changing requests must require both an accepted origin and a session-bound CSRF
token. Authentication callbacks must be protected by one-time state and nonce values.
Login, callback, pairing, and recovery routes must have stricter rate limits than
ordinary reads. Redirect destinations must be allowlisted local paths, not arbitrary
URLs.

The first invalid CSRF proof for a valid session creates an attributable denial audit.
Later denials for that same session coalesce through a deterministic database key and
make no additional SQLite changes, including across gateway processes or restarts.
This retains the initial security signal while bounding durable storage by the number
of sessions already created.

## Required recovery access

A hidden break-glass route must restore administrative access when both OIDC and
Jellyfin configuration are unusable. It must remain absent from the normal login
interface and require a high-entropy value supplied as a Docker secret.

Recovery attempts must be rate-limited and audit-logged, including bounded failure
signals. Successful attempts always produce an audit record. Unauthenticated denials
and internal failures coalesce by privacy-protected client and reason within each
15-minute window. At most 255 distinct denial records and one context-free
`audit_budget_saturated` marker are written per process window; repeats and later
attempts in a saturated window are suppressed. The durable audit table is therefore a
security-signal ledger, not a complete request counter.

A successful recovery session must be short-lived, locally scoped, visibly marked, and
must not be usable as a permanent authentication method. Operators should test recovery
after initial setup, store the secret separately from the database, and rotate it after
use.

The implemented recovery boundary allows only one active recovery session: a newly
verified break-glass login atomically supersedes the prior recovery session and records
that transition. It also permits at most eight recovery sessions in a rolling 24-hour
window, independent of normal per-user capacity. Further verified attempts return a
no-store `429` with `Retry-After` and create no session or secret-reservation rows.
Every gateway startup revokes and audits any active recovery session before serving
requests. Restarting the gateway during a repair therefore requires a fresh break-glass
login, which also consumes another slot in the rolling issuance budget.

## Phase 1 operator checklist

- Use HTTPS and a canonical public origin before enabling OIDC.
- Register only the exact documented callback and logout URLs with the provider.
- Confirm issuer and client identifiers; do not copy a provider's authorization URL
  into the issuer field.
- Begin with JIT provisioning disabled or viewer-only.
- Test sign-in, logout, session revocation, and failed claim mappings with a
  non-administrator account.
- Pair accounts through fresh Jellyfin proof, even when profile claims appear to
  match.
- Store the encryption master key and recovery secret outside the SQLite backup.
