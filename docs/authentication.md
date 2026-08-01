# Authentication and account linking

This document records the current authentication checkpoint and the remaining Phase 1
authentication and authorization contract. It is for operators evaluating readiness
and contributors changing a security-sensitive flow.

> [!IMPORTANT]
> The current development branch implements the OIDC browser flow, JIT identity
> resolution, direct Jellyfin password and Quick Connect sign-in, password and Quick
> Connect OIDC-to-Jellyfin pairing, RP-initiated logout, provider-initiated back- and
> front-channel logout, opaque sessions, and break-glass
> recovery. The permission-checked identity control room and API can create, list, and validate
> encrypted configurations and administer provider lifecycles and explicit role mappings. A pinned,
> isolated Authentik environment exercises real authorization, guarded role-mapping updates, RP logout, and
> back-channel logout. A separate digest-pinned Dex environment exercises generic discovery, S256
> PKCE, immutable identity reuse, viewer JIT provisioning, active-session role remapping, and safe local
> logout fallback when the issuer advertises no logout endpoint. These fixtures are development
> evidence rather than a public provider support baseline. An administrator-only user access
> directory now exposes normalized account
> state, role provenance, and session activity without external subjects or service credentials;
> direct roles and local suspension are guarded by optimistic revisions and atomic session
> revocation. The protected live compatibility baseline remains pending, and Phase 1 has
> not passed a tagged release gate; treat this document as development evidence, not a production
> support claim.

## Current development surface

The gateway exposes browser-safe provider metadata, OIDC start and callback endpoints,
direct Jellyfin password and Quick Connect authentication, CSRF-protected password
and Quick Connect pairing for pending OIDC users, session inspection and revocation,
and hidden recovery access. A discovered OIDC
provider is offered by the sign-in screen only when its persisted capability snapshot
is internally consistent and ready. Unchecked, failed, or malformed providers fail
closed as unavailable or misconfigured.

Administrators and short-lived recovery sessions can create, inspect, and validate OIDC provider
configuration through a CSRF-protected mutation API. Client secrets are encrypted before the
transaction commits and are represented to browsers only by a boolean configured state.
Creation writes a sanitized audit event atomically with the provider row. A newly created
provider remains `unchecked` and cannot be selected on the login screen until validation succeeds.
Validation always performs fresh discovery through the pinned-address safe-fetch boundary,
returns only normalized capability booleans, and never returns discovered endpoints or runtime
security seals. Disabled providers can be validated without becoming sign-in eligible. Validation
success and failure are audit-logged with bounded reason codes, and repeated failures use the
registry's retry backoff instead of repeatedly contacting the issuer.

Provider configurations can be replaced without returning stored secrets. Omitting the secret for
an existing confidential client retains its encrypted value; changing a public client to a
confidential method requires fresh secret proof. Runtime-affecting changes clear cached discovery
evidence and pending authorization transactions, and any effective provider change revokes active
OIDC sessions attributed to that provider. Issuers with linked identities cannot be changed.
Deletion requires a disabled provider and is rejected while any external identity still depends on
it; only then are unbound role mappings and transient protocol records removed transactionally.

Provider role mappings can be listed, created, updated, and deleted through the same administrative
boundary. Mapping inputs use bounded, prototype-safe claim paths and exact typed scalar values;
string, numeric, and boolean values are never coerced. Higher numeric priority wins, while
conflicting roles at the same highest matching priority deny sign-in. Successful mapping changes
write sanitized audit records and immediately revoke active sessions for users whose authority
came from that provider's default or mapped role. Claim paths and expected values are deliberately
excluded from audit metadata. Updates preserve the mapping and provider identities, reject no-op or
equivalent rules without a storage, audit, or session side effect, and leave manually assigned
Jellyfin-only authority unchanged.

The browser control room is available only when the current principal holds
`recovery.oidc.manage`. It uses the same normalized contracts and CSRF boundary as the API, never
receives stored client-secret values, and converts a changed administrative session into a
signed-out state. Its guided Authentik path reserves `oidc-{slug}` before creation so the exact
callback and logout URLs can be registered without a temporary provider or wildcard redirect.
Empty, loading, offline, permission-denied, validation-failure, conflict, session-expired, and
destructive-confirmation states are explicit. Its role editor preserves mixed typed claim values,
announces the session impact before saving, and returns only the normalized updated rule and a
revocation count.

The browser user access directory requires a normal session with `roles.manage`; break-glass
recovery is deliberately excluded. It lists only normalized display identity, authentication
methods, role provenance, local account status, Jellyfin link health, and bounded session activity.
It never returns OIDC issuer/subject pairs, Jellyfin identifiers, tokens, connector configuration,
or upstream credentials. Direct Jellyfin-only roles may be assigned locally, while any identity
with OIDC ownership keeps its role under provider claim mappings. Administrators cannot change
their own row or remove the final active administrator.

Every role or local account-state update requires the record's exact `updatedAt` revision,
same-origin session CSRF proof, and the named permission for the requested field. A successful
change, all target-session revocations, and one sanitized audit event commit in a single immediate
transaction. Re-enabling an account derives `active` versus `pending_link` from the current
Jellyfin link instead of trusting a browser-supplied status. The interface stages changes first,
states the exact role and session impact, and requires a separate apply action.

The OIDC flow currently creates or resolves an external identity keyed by immutable
issuer and subject, applies explicit role mappings, provisions a `viewer` by default
when JIT is enabled, and creates an opaque server-side session atomically. It does not yet provide
the media-operation permission surfaces planned for later phases. Every currently implemented
administrative and self-service route has an explicit local permission boundary. The
[roadmap](roadmap.md) and [compatibility matrix](compatibility.md) remain the source of
truth for verified availability.

Successful OIDC callbacks with a pending-link principal are sent directly to
`/link/jellyfin`; active accounts retain the validated same-origin return path stored
with the authorization transaction. The pairing screen rechecks the opaque session
before revealing credential controls and keeps its CSRF proof only in memory.

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

## Current authentication routes

Browsers and configured identity providers use the public web routes below. The web
process forwards them to the versioned gateway API; operators must not expose the
gateway directly.

| Route                                                                          | Purpose                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `GET /api/auth/providers`                                                      | Return the bounded browser-safe provider list.                              |
| `GET /api/auth/oidc/{providerId}/start`                                        | Bind the browser, create a one-time transaction, and start OIDC.            |
| `GET /api/auth/oidc/callback/{providerId}`                                     | Consume the transaction, validate the grant, and establish a session.       |
| `POST /api/auth/oidc/logout`                                                   | Revoke locally, then request RP-initiated provider logout when available.   |
| `POST /api/auth/oidc/backchannel/{providerId}`                                 | Verify a provider Logout Token and revoke its exact local session scope.    |
| `GET /api/auth/oidc/frontchannel/{providerId}`                                 | Accept exact session-aware provider logout in a restricted iframe.          |
| `POST /api/auth/jellyfin/password`                                             | Verify credentials with Jellyfin and establish a local session.             |
| `POST /api/auth/bootstrap/jellyfin/password`                                   | Establish the first admin from recovery plus Jellyfin admin proof.          |
| `POST /api/auth/bootstrap/jellyfin/quick-connect`                              | Start recovery-bound first-admin Quick Connect proof.                       |
| `POST /api/auth/bootstrap/jellyfin/quick-connect/{transactionId}/poll`         | Complete first-admin bootstrap for the exact recovery session.              |
| `POST /api/auth/jellyfin/link/password`                                        | Pair fresh credentials to the exact pending OIDC session.                   |
| `POST /api/auth/jellyfin/link/quick-connect`                                   | Create Quick Connect proof bound to the exact pending OIDC session.         |
| `POST /api/auth/jellyfin/link/quick-connect/{transactionId}/poll`              | Complete pairing only for the originating OIDC session.                     |
| `POST /api/auth/jellyfin/quick-connect`                                        | Create a browser-bound Quick Connect code transaction.                      |
| `POST /api/auth/jellyfin/quick-connect/{transactionId}/poll`                   | Poll by opaque ID and establish a session only after approval.              |
| `GET /api/auth/session`                                                        | Inspect and, when due, rotate the current local session.                    |
| `DELETE /api/auth/session`                                                     | Revoke the current session; requires same-origin CSRF protection.           |
| `DELETE /api/auth/sessions`                                                    | Revoke every local session owned by the current user.                       |
| `GET /api/auth/identity-links`                                                 | Inspect the current user's normalized Jellyfin link and health.             |
| `DELETE /api/auth/identity-links/{linkId}`                                     | Revoke an owned link, erase its token, and reduce local authority.          |
| `POST /api/auth/recovery/session`                                              | Hidden, rate-limited recovery endpoint; never linked from the login UI.     |
| `GET /api/admin/setup/readiness`                                               | Read a no-store, detail-free setup summary; requires a full administrator.  |
| `GET /api/admin/auth/oidc/providers`                                           | List secret-free OIDC configuration for an authorized administrator.        |
| `POST /api/admin/auth/oidc/providers`                                          | Create an encrypted, audited OIDC configuration; requires session CSRF.     |
| `PUT /api/admin/auth/oidc/providers/{providerId}`                              | Replace configuration, invalidate stale runtime state, and revoke sessions. |
| `DELETE /api/admin/auth/oidc/providers/{providerId}`                           | Delete a disabled provider only when no external identities depend on it.   |
| `POST /api/admin/auth/oidc/providers/{providerId}/validate`                    | Freshly validate discovery and return only safe capability information.     |
| `GET /api/admin/auth/oidc/providers/{providerId}/role-mappings`                | List exact claim-to-role rules for an authorized administrator.             |
| `POST /api/admin/auth/oidc/providers/{providerId}/role-mappings`               | Create an audited rule and revoke affected role-derived sessions.           |
| `PUT /api/admin/auth/oidc/providers/{providerId}/role-mappings/{mappingId}`    | Atomically update a rule and revoke only affected role-derived sessions.    |
| `DELETE /api/admin/auth/oidc/providers/{providerId}/role-mappings/{mappingId}` | Delete a rule and revoke affected role-derived sessions.                    |
| `GET /api/admin/users`                                                         | List bounded, browser-safe account authority and activity summaries.        |
| `PATCH /api/admin/users/{userId}`                                              | Apply a revision-bound role or local-state change and revoke sessions.      |

Register the exact callback
`<OMNIFIN_BASE_URL>/api/auth/oidc/callback/{providerId}`, post-logout redirect
`<OMNIFIN_BASE_URL>/login?loggedOut=1`, back-channel logout URI
`<OMNIFIN_BASE_URL>/api/auth/oidc/backchannel/{providerId}`, and front-channel logout URI
`<OMNIFIN_BASE_URL>/api/auth/oidc/frontchannel/{providerId}` with each identity provider.
`OMNIFIN_BASE_URL` is a canonical origin only: it cannot contain credentials, a path,
query, or fragment. Start requests accept at most one `returnPath`, currently `/` or
`/settings`; all other redirect targets fail closed.

For a newly created provider, `providerId` is predictably reserved as `oidc-{slug}`. This lets an
operator register the exact callback and logout URLs at the identity provider before submitting
client credentials to Omnifin. The identifier remains stable if the display slug is renamed later;
an old identifier cannot be silently reused by another provider.

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

RP-initiated logout is implemented when provider metadata advertises an exact approved
end-session endpoint. The account screen submits the CSRF proof through a native
same-origin form, so the gateway can revoke and audit the exact local session before it
releases the encrypted ID-token hint for the provider redirect. The hint never passes
through application JavaScript or a JSON response. Discovery failure or a provider
without RP-initiated logout still completes local logout and returns to the fixed login
route. Other Omnifin sessions remain active; the separate logout-all control revokes
those sessions without claiming to terminate provider SSO.

Provider-initiated back-channel logout follows
[OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html).
The provider sends exactly one form-encoded `logout_token`; extension form fields are
ignored as the specification requires. The gateway verifies the compact assertion's
signature with the runtime's approved JWKS transport and requires the configured
signing algorithm, exact issuer and audience, bounded `iat`, future `exp`, unique
`jti`, the back-channel logout event, no `nonce`, and at least one of `sid` or `sub`.
An explicit JWT type, when present, must be `logout+jwt`.

Session-specific tokens are scoped by the provider and the privacy-preserving hash of
`sid`; when both `sid` and `sub` are present, both must identify the same stored
identity session. A subject-only token revokes every local OIDC session for the exact
immutable `(issuer, sub)` identity. Receipt insertion, revocation, and a sanitized
audit event commit atomically. Recent `jti` replays are acknowledged idempotently
without another revocation or audit write. Assertions, raw session identifiers, and
token identifiers are never persisted. Invalid requests return a fixed no-store
response; a bounded discovery or JWKS outage returns a retryable service response.

Provider-initiated front-channel logout follows
[OpenID Connect Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html).
Omnifin advertises support only when discovery reports both front-channel logout and
session-parameter support. The provider must send exactly one `iss` and one `sid`; the
issuer must exactly match the enabled provider, and the privacy-preserving `sid` hash
can revoke only OIDC sessions scoped to that provider. Revocation and its sanitized
audit event commit atomically. A repeat or unknown session identifier is acknowledged
without another write.

The endpoint uses `GET` only because the OIDC specification defines an iframe
navigation. It does not depend on the Omnifin browser cookie, which can be unavailable
in a third-party iframe. After exact provider validation, the otherwise global frame
denial is narrowed only for the configured issuer origin; malformed, mismatched, and
storage-failed requests retain `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
Responses are empty and non-cacheable, and raw `sid` values are never stored or written
to audit metadata.

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

Logout capability discovery is optional. Omnifin revokes the local session before attempting any
provider redirect. If the exact enabled provider advertises a valid end-session endpoint, the
gateway creates the bounded RP-initiated request described above. If discovery omits the endpoint or
fresh discovery fails, logout completes at the same-origin `/login?loggedOut=1` fallback without
constructing an arbitrary provider URL. The
[standards-generic OIDC fixture](operations/oidc-provider-fixture.md) exercises this negative
capability path; Authentik exercises the advertised RP-initiated path.

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
gateway-wide 300-per-minute client limit. Back-channel logout is limited to 120
requests per minute per provider network source. IPv6 addresses group by `/64`, and
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
must prove control of a Jellyfin account. Password and Quick Connect proof, link inspection,
relinking, revocation, logout-all, and administrator-controlled local suspension are implemented.

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

The account-and-access screen exposes link health, proof-appropriate relinking,
deliberate link revocation, RP-initiated provider logout, and logout-all controls.
Direct Jellyfin sessions relink through direct authentication; OIDC sessions use the
CSRF-protected pairing and provider-logout endpoints.

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

On a fresh database, the hidden `/recovery` interface can exchange that session for a
normal administrator session only after password or Quick Connect proof from a Jellyfin
account whose upstream policy explicitly marks it as an administrator. The exchange is one
immediate SQLite transaction: it verifies that no active local administrator exists, reuses
only an exact immutable server/user identity, records `recovery_bootstrap` role provenance,
and replaces the recovery session. Ordinary Jellyfin sign-in remains viewer-default and
never imports upstream administrator authority. Competing proofs can therefore produce at
most one first administrator.

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
- Register only the exact documented callback, back-channel logout, front-channel
  logout, and post-logout URLs with the provider.
- Confirm issuer and client identifiers; do not copy a provider's authorization URL
  into the issuer field.
- Begin with JIT provisioning disabled or viewer-only.
- Test sign-in, logout, session revocation, and failed claim mappings with a
  non-administrator account.
- Pair accounts through fresh Jellyfin proof, even when profile claims appear to
  match.
- Store the encryption master key and recovery secret outside the SQLite backup.
