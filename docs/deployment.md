# Deployment guide

This guide describes the intended supported single-node deployment and the decisions
an operator must make safely. Omnifin is currently pre-release; do not treat an
untagged image or default branch build as a production support promise.

> [!IMPORTANT]
> The current development branch is not a production support promise. It can run the OIDC
> browser flow for a configured provider,
> establish local sessions, authenticate by password or Quick Connect with a configured
> Jellyfin server, pair a pending OIDC user through fresh credentials or Quick Connect, and
> provide RP-initiated logout, provider-initiated back- and front-channel logout, and
> hidden first-administrator recovery. A permission-checked interface and API can create, inspect, and safely
> validate encrypted OIDC provider records, manage their guarded lifecycle, and administer explicit
> role mappings. A separate connector API stores encrypted credentials, requires fresh probes before
> enablement, and permits recovery sessions to repair Jellyfin configuration only. The connector
> browser interface and normalized upstream media operations are pre-release surfaces; the
> protected live compatibility baseline remains incomplete. Tagged phase releases define supported
> deployment claims.

## Deployment model

The Compose files establish the intended topology: web and gateway processes
run from the same immutable image, only the web service is published, and the
gateway owns the SQLite volume. The gateway owns all upstream communication, secret isolation,
authorization, and audit records. The runtime includes permission-checked identity, connector, and
media-operation surfaces; the compatibility matrix, not the presence of a route, determines which
upstream versions have enough evidence for a release claim.

The production image is distroless and runs without a shell or package manager as a
numeric non-root user. Use the application health endpoints and structured logs for
normal diagnosis; do not install troubleshooting tools into a running release image.

Set `OMNIFIN_DISPLAY_PROFILE=ten-foot` when the interface is viewed primarily from
television distance. The default `standard` profile remains appropriate for desktop,
tablet, and handheld use.

The public image location is `ghcr.io/rezanmz/omnifin`. Every verified GitHub Release attaches a
runtime-only `compose.yaml`, a version-labelled `omnifin.env.example` containing its exact image
digest, and `SHA256SUMS`. Verify the checksums before copying the template to `.env`; never replace
its immutable digest with a moving tag for a persistent installation. Avoid `edge`: it follows the
default branch and may include migrations that have not passed a release gate.

## Requirements for a supported deployment

Before operating a release that advertises the corresponding capabilities, prepare:

- a canonical HTTPS public URL;
- a persistent volume with sufficient free space and reliable backups;
- a randomly generated encryption master key supplied through a private file-backed
  Compose secret, not embedded in Compose configuration or `.env`;
- a separately generated, file-backed break-glass recovery secret;
- dedicated connector credentials where upstream services support them; and
- exact OIDC callback, back-channel logout, front-channel logout, and post-logout URLs
  when using an identity provider.

Keep the master key and recovery secret outside the database backup. Anyone holding
both the database and master key may be able to recover upstream credentials.

The gateway requires an encryption key to start and can store encrypted OIDC client
secrets, Jellyfin access tokens, connector credentials, and local session and recovery
state. Direct Jellyfin sign-in is the first workflow that writes an encrypted upstream
token; passwords are used only for the upstream exchange and are never persisted.

The `OMNIFIN_JELLYFIN_URL` setting bootstraps the single Jellyfin connector used for the first
administrator, direct authentication, pairing, and media operations. It must be a canonical HTTPS URL
without embedded credentials, a query, or a fragment. An operator who deliberately
targets a trusted private-network HTTP endpoint must also set
`OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED=true`. That acknowledgement enables only the
configured for that server. Treat this acknowledgement as a deployment-specific trust decision,
not as a substitute for network isolation.

## First administrator

A fresh database has no privileged local user. Before configuring OIDC or additional services:

1. Configure `OMNIFIN_JELLYFIN_URL` and start the gateway and web processes.
2. Open `<OMNIFIN_BASE_URL>/recovery` directly. The route is intentionally absent from normal
   sign-in navigation and is marked `noindex`.
3. Enter the deployment recovery secret, then choose Jellyfin password or Quick Connect.
4. Prove a Jellyfin account whose current Jellyfin policy has `IsAdministrator=true`.

Omnifin keys the account by the immutable Jellyfin server and user identifiers. A password is sent
only to Jellyfin and discarded immediately; only the returned token is encrypted at rest. The
database transaction refuses the operation if an active local administrator already exists,
creates or reuses the exact Jellyfin identity, promotes it with `recovery_bootstrap` provenance,
and replaces recovery access with a normal Jellyfin-attributed administrator session. Other active
sessions for that same local user are revoked.

Ordinary Jellyfin sign-in never inherits Jellyfin administrator authority and provisions a local
`viewer` by default. The hidden bootstrap endpoint is the only initial bridge, and it requires both
the short-lived recovery session and current proof of Jellyfin administrator control. Denials leave
the recovery session intact so an operator can correct the account or an upstream outage without
re-entering the secret. See the [first-run runbook](first-run.md) for exact commands and checks.

`OMNIFIN_BASE_URL` must contain only the canonical public origin, with no credentials,
path, query, or fragment. Production requires HTTPS except for a loopback-only source
preview. The production container permits that HTTP exception only when
`OMNIFIN_INSECURE_LOOPBACK_PREVIEW=true`; the bundled Compose file sets it because its
default port binding is loopback-only. Do not carry that exception into a published
network deployment. Register
`<OMNIFIN_BASE_URL>/api/auth/oidc/callback/{providerId}` exactly at the OIDC provider;
for a new configuration, the administration UI can calculate `providerId` as `oidc-{slug}` before
credentials are submitted. Do not derive callback URLs from proxy forwarding headers. The current branch deliberately has no
environment-variable OIDC bootstrap. Its permission-checked administration API encrypts
client secrets and audits provider creation, replacement, validation, and guarded deletion.
Authorized administrators and recovery sessions reach the guided control room through
**Account & access → Identity providers**. It previews exact callback and logout endpoints before
the first credential is submitted, saves new providers disabled, requires fresh discovery
validation before offering enablement, and manages exact typed role mappings. Role-mapping
administration, guarded mapping updates, and the role-derived session invalidation boundary are
implemented. Operators should not edit SQLite manually to bypass that boundary.

After bootstrap, **Account & access → Setup guide** provides a live, permission-aware route through
the remaining configuration. Its core-ready boundary requires both a verified Jellyfin identity and
a currently validated Jellyfin connector. OIDC and surrounding media services are reported as
recommended or optional extensions, so a deliberately smaller home stack is never labelled broken.
The browser receives only normalized readiness state; connector URLs, credentials, identity
subjects, recovery access, and raw upstream responses stay outside the guide.

The same guide includes a separate **Deployment flight check** for the host boundary. It reports only
four ordered ready-or-attention results: production runtime, canonical HTTPS with secure sessions,
configured recovery access, and persistent SQLite storage. Only a full administrator can request the
snapshot. The response is non-cacheable and never includes environment values, public origins,
filesystem paths, proxy details, secret material, or database contents. A flight-check outage remains
visibly separate from connector readiness, so a failed diagnostic cannot make a healthy media core
look unconfigured.

Treat the flight check as a preflight, not certification. It cannot prove that a reverse proxy is
correctly stripping untrusted forwarding headers, a certificate is publicly trusted, the volume is
durable on the host, backups are restorable, or recovery secrets are available to the operator. Before
publishing Omnifin beyond loopback, resolve every attention result and complete the proxy, backup,
restore, and recovery exercises in this guide.

## Target production network layout

Terminate TLS at a maintained reverse proxy and forward only to the web service. Do
not publish the gateway port to an untrusted network. Preserve the canonical host and
scheme so origin checks, secure cookies, and OIDC redirects remain correct. The
copyable one-host Caddy and Nginx configurations, forwarded-header rules, SSE settings, and public
verification steps are in the [reverse proxy runbook](operations/reverse-proxy.md). The
fronting proxy must remove any client-supplied forwarding chain before setting or
appending its observed address. The published web socket is loopback-only, and the
bundled Compose topology sets `OMNIFIN_WEB_TRUST_PROXY_HOPS=1` for that single
maintained edge. Set the value to the exact reviewed hop count when more proxies are
present; use `0` whenever clients can reach the web process directly. A wrong nonzero
value lets callers choose rate-limit attribution. The bundled gateway separately
trusts exactly the single private web-service hop; do not change that hop count in the
public Compose path.

The same-origin `/api` proxy removes every inbound client-address and forwarding
assertion. When an explicit web trusted-hop count is nonzero, it then selects only the
IP address immediately before those trusted hops and sends that single canonical
`X-Forwarded-For` value to the private gateway. Attacker-controlled earlier entries,
malformed or oversized chains, and all other address headers are discarded. This
keeps gateway and OIDC per-client rate-limit groups distinct without accepting a
browser-selected identity. Continue to enforce edge limits at the TLS proxy as an
additional layer, and treat hashed addresses as operational attribution rather than
proof of a person's identity.

Once upstream configuration is implemented, restrict gateway egress to DNS and the
configured identity and media services where practical. Approve private-network
connector destinations deliberately. Never grant access to cloud metadata addresses,
unrelated administration networks, or a generic forward proxy.

Production deployments should use valid certificates end to end where possible.
Insecure HTTP weakens connector identity and requires an explicit, service-specific
administrative acknowledgement. A self-signed HTTPS connector additionally requires
its current PEM-encoded CA certificate; Omnifin keeps normal certificate and hostname
verification enabled against that connector-specific trust anchor.

## Tagged installation verification

The release workflow generates the same three assets from the immutable tagged source, starts them
against the anonymously pullable candidate digest on a clean hosted runner, verifies web and gateway
health plus recovery-route reachability, creates and verifies an online SQLite backup, and tears down
the complete Compose project. Stable tags cannot move unless that installation gate succeeds.

Operators should still repeat the health and backup checks on their own host before adding service
credentials. Host networking, proxy headers, filesystem ownership, certificates, and upstream ACLs
remain deployment-specific.

## Source-checkpoint verification

1. Start the exact source commit or locally built image digest selected for validation.
2. Confirm web liveness through the published loopback port:

   ```sh
   curl --fail --silent --show-error http://127.0.0.1:3000/healthz
   ```

3. Confirm gateway liveness and storage readiness from inside the private Compose
   network. The web process deliberately does not proxy gateway readiness:

   ```sh
   docker compose exec -T gateway /nodejs/bin/node /opt/omnifin/bin/healthcheck.mjs
   docker compose exec -T gateway /nodejs/bin/node --input-type=module --eval \
     'const response = await fetch("http://127.0.0.1:4000/readyz"); const body = await response.json(); if (!response.ok || body.status !== "ready") process.exit(1); console.log(JSON.stringify(body));'
   ```

4. Confirm provider discovery returns only safe metadata. Without a provider configured
   through test tooling, the login screen must remain explicitly unconfigured.
5. If validating the OIDC development flow with an isolated synthetic provider,
   confirm the exact callback, PKCE, authorization replay rejection, session inspection,
   RP-initiated logout, signed back-channel logout, session-aware front-channel logout,
   and Logout Token replay behavior.
   Do not use a personal identity provider or manually edit production data.
6. Confirm recovery remains absent from the ordinary login interface and rejects a
   missing or incorrect secret without revealing whether recovery is configured.
7. On a fresh disposable database, establish the first administrator and confirm the
   resulting session is Jellyfin-attributed, locally `admin`, and no longer a recovery session.
8. Confirm a gateway restart revokes the active recovery session, then reauthenticate
   deliberately; each new recovery session consumes one of eight rolling 24-hour
   issuance slots.
9. Confirm telemetry is disabled and inspect logs for accidental private values.

These checks validate the foundation only. They do not make the preview suitable for
real users or a personal media library.

## Future supported-release verification

After a release explicitly advertises identity and connector support:

1. Sign in with a non-administrator account and verify denied operations stay denied.
2. Configure one connector at a time and run its safe connection test.
3. Verify OIDC sign-in, logout, session revocation, and Jellyfin pairing before
   relying on OIDC for administrator access.
4. Test the break-glass procedure, rotate its secret if the exercise exposed it, and
   store the runbook where it remains available during an outage.
5. Exercise a representative authorized read and safe mutation, then inspect the audit
   record and degraded-service behavior.

## Backups

The maintenance container creates an online, transactionally consistent SQLite snapshot and
a strict integrity manifest without exposing host paths. Restore remains an explicit downtime
operation: it verifies the selected pair, refuses a live or non-quiescent gateway, creates a
verified pre-restore rollback pair, and atomically replaces the active database.

Follow the complete [backup and restore runbook](operations/backup-and-restore.md). A recovery
set is incomplete without the matching encryption master key, recovery secret, deployment
configuration, immutable image digest, database, and manifest. Keep secrets separate from the
database backup and protect backup access as carefully as live access.

## Upgrade

1. Read the release notes and compatibility changes.
2. Back up and verify the recovery set.
3. Pull the immutable version tag and record its digest.
4. Let the release's migration step complete before serving traffic.
5. Check readiness, authentication, a representative read, and a safe mutation.
6. Retain the previous verified digest and pre-upgrade backup until the observation
   period ends.

Moving tags are convenience aliases. For a controlled upgrade, pin the digest that
the GitHub Release and attestation identify.

## Rollback

Never overwrite a published image tag. Roll back by selecting a previously verified
version or digest. Application rollback may also require restoring the pre-upgrade
database when migrations are not backward compatible; do not start older code against
a newer schema unless the release notes explicitly permit it.

Once encrypted credentials are stored, restoring the database also requires the
matching master key. A successful container start without decryptable credentials is
not a successful recovery.

## Privacy and diagnostics

Omnifin sends no external analytics or phone-home telemetry by default. Current logs
and future operational data should be treated as private. As later phases add users,
viewing activity, media metadata, connector URLs, audit records, and correlation
traces, sanitize diagnostic bundles before sharing them in a public issue.
