# Authentication and account linking

This document records the current authentication foundation and the mandatory Phase 1
authentication and authorization contract. It is for operators evaluating readiness
and contributors changing a security-sensitive flow.

> [!IMPORTANT]
> Phase 0 does not provide a usable sign-in method. It includes authentication schemas,
> database migrations, browser-safe provider discovery, and security primitives. A
> configured provider is reported as unavailable, and its login-method flags remain
> false, until the corresponding Phase 1 flow is implemented and verified. The OIDC,
> Jellyfin, account-linking, session, authorization, and recovery behavior below is the
> required Phase 1 contract, not a current support claim.

## Current Phase 0 surface

The foundation can describe configured OIDC and Jellyfin providers without exposing
secrets. It does not yet expose OIDC start or callback endpoints, Jellyfin credential
or Quick Connect login, account pairing, authenticated sessions, role enforcement, or
recovery access. The public roadmap and compatibility matrix remain the source of
truth for verified availability.

## Planned Phase 1 sign-in choices

When Phase 1 is complete, a normal user will be able to sign in through either:

- a configured OpenID Connect provider, such as Authentik; or
- Jellyfin username and password or Jellyfin Quick Connect.

The Phase 1 login screen must receive only safe provider metadata. Client secrets,
issuer credentials, upstream tokens, and internal configuration must never reach the
browser. Multiple OIDC issuers are already supported by the data model even when an
installation uses only one.

## Required OIDC flow

The Phase 1 implementation must use Authorization Code Flow with PKCE S256. It must
never use the implicit grant or resource-owner password grant.

1. The gateway discovers metadata from the configured issuer and validates that the
   discovered issuer exactly matches the configured issuer.
2. It creates high-entropy PKCE, `state`, and `nonce` values, persists only the
   short-lived transaction state, and redirects to the provider.
3. The callback consumes the transaction exactly once and validates state, code
   exchange, signature, issuer, audience, expiry, and nonce.
4. The external identity is keyed by `(issuer, sub)`. Email address and username are
   display claims, never identity keys.
5. A new identity is provisioned only when JIT provisioning is enabled. Its default
   role is `viewer` unless an explicit configured claim mapping grants another role.
6. The gateway rotates the local session before completing sign-in.

Default scopes must be `openid profile email`. Additional group or entitlement claims
may be requested only when an operator configures a role mapping. Omnifin must not ask
for `offline_access`, because it does not need long-lived access to an identity provider
API.

Provider-initiated and RP-initiated logout must be supported when advertised by
provider metadata. A back-channel logout token must be validated against the same
issuer and client constraints before affected local sessions are revoked.

## Required OIDC-to-Jellyfin pairing

An OIDC identity alone must not grant media access. After first OIDC sign-in, the user
must prove control of a Jellyfin account through credentials or Quick Connect.

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
the OIDC identity may remain pending, but media operations must stay denied. Users must
be able to inspect link health, relink, revoke the link, and revoke all of their local
sessions.

## Required direct Jellyfin sign-in

Direct sign-in must exchange credentials or Quick Connect approval for a Jellyfin
access token. Omnifin must create or resolve the local user from the immutable Jellyfin
server and user identifiers, then create a local opaque session. It must not expose the
Jellyfin token in that session or in browser storage.

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
absolute deadline, and be revocable individually or account-wide.

State-changing requests must require both an accepted origin and a session-bound CSRF
token. Authentication callbacks must be protected by one-time state and nonce values.
Login, callback, pairing, and recovery routes must have stricter rate limits than
ordinary reads. Redirect destinations must be allowlisted local paths, not arbitrary
URLs.

## Required recovery access

A hidden break-glass route must restore administrative access when both OIDC and
Jellyfin configuration are unusable. It must remain absent from the normal login
interface and require a high-entropy value supplied as a Docker secret.

Recovery attempts must be rate-limited and audit-logged, including failures. A
successful recovery session must be short-lived, locally scoped, visibly marked, and
must not be usable as a permanent authentication method. Operators should test recovery
after initial setup, store the secret separately from the database, and rotate it after
use.

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
