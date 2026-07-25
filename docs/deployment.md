# Deployment guide

This guide describes the intended supported single-node deployment and the decisions
an operator must make safely. Omnifin is currently pre-release; do not treat an
untagged image or default branch build as a production support promise.

> [!IMPORTANT]
> Phase 0 is a source-built foundation preview, not an operable media control plane. It
> can start the web and gateway processes, initialize and migrate SQLite, report health,
> expose browser-safe provider metadata, and render the interface preview. It cannot
> sign users in, configure OIDC or connectors, create sessions, enforce application
> roles, perform upstream operations, or provide break-glass recovery. Sections marked
> as future requirements define the supported deployment contract for later phases.

## Deployment model

The Phase 0 Compose file establishes the intended topology: web and gateway processes
run from the same source-built image, only the web service is published, and the
gateway owns the SQLite volume. Communication with configured upstream services is a
later-phase capability; the current repository contains connector contracts and probe
tooling, but the runtime has no administrative configuration or operational API.

The production image is distroless and runs without a shell or package manager as a
numeric non-root user. Use the application health endpoints and structured logs for
normal diagnosis; do not install troubleshooting tools into a running release image.

Set `OMNIFIN_DISPLAY_PROFILE=ten-foot` when the interface is viewed primarily from
television distance. The default `standard` profile remains appropriate for desktop,
tablet, and handheld use.

The reserved public image location is `ghcr.io/rezanmz/omnifin`. Do not assume that an
image or public package exists until a verified release or default-branch publication
is visible in the repository. Versioned installation instructions will begin with the
first verified release. Avoid `edge` for persistent installations; it follows the
default branch and may include migrations that have not passed a release gate.

## Requirements for a future supported deployment

Before operating a release that advertises the corresponding capabilities, prepare:

- a canonical HTTPS public URL;
- a persistent volume with sufficient free space and reliable backups;
- a randomly generated encryption master key supplied through a secret, not embedded
  in Compose configuration;
- a separately generated break-glass recovery secret;
- dedicated connector credentials where upstream services support them; and
- exact OIDC callback and logout URLs when using an identity provider.

Keep the master key and recovery secret outside the database backup. Anyone holding
both the database and master key may be able to recover upstream credentials.

Phase 0 requires an encryption key to start, but does not yet store usable OIDC client
secrets, Jellyfin access tokens, connector credentials, sessions, or recovery grants.
Supplying future-facing settings early does not activate those features.

The optional Phase 0 `OMNIFIN_JELLYFIN_URL` setting exposes only browser-safe,
unavailable provider metadata. It must be a canonical HTTPS URL without embedded
credentials, a query, or a fragment. An operator who deliberately targets a trusted
private-network HTTP endpoint must also set
`OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED=true`; this acknowledgement does not enable
authentication or any media operation.

## Target production network layout

Terminate TLS at a maintained reverse proxy and forward only to the web service. Do
not publish the gateway port to an untrusted network. Preserve the canonical host and
scheme so origin checks, secure cookies, and OIDC redirects remain correct. The
fronting proxy must replace, rather than append to, client-supplied forwarding
headers. The bundled gateway trusts exactly the single private web-service hop; do
not make the hop count configurable in the public Compose path.

Once upstream configuration is implemented, restrict gateway egress to DNS and the
configured identity and media services where practical. Approve private-network
connector destinations deliberately. Never grant access to cloud metadata addresses,
unrelated administration networks, or a generic forward proxy.

Production deployments should use valid certificates end to end where possible.
Insecure HTTP and self-signed upstream certificates weaken connector identity and
must require an explicit, service-specific administrative acknowledgement.

## Phase 0 source-preview verification

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

4. Confirm provider discovery returns only safe metadata and marks every unimplemented
   login method unavailable.
5. Confirm the interface identifies itself as a foundation preview and does not offer
   working account or connector setup.
6. Confirm telemetry is disabled and inspect logs for accidental private values.

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

For a future supported release, a complete recovery set must contain a transactionally
consistent SQLite backup, the matching encryption master key, deployment configuration,
and any required Docker secrets. Protect and rotate backup access as carefully as live
access.

Phase 0 has no supported in-application backup or restore operation. For disposable
source-preview data, stop the gateway before copying SQLite. Future supported releases
must provide and document a transactionally safe procedure; record the running image
digest and schema version with every recovery set.

## Future supported-release upgrade

1. Read the release notes and compatibility changes.
2. Back up and verify the recovery set.
3. Pull the immutable version tag and record its digest.
4. Let the release's migration step complete before serving traffic.
5. Check readiness, authentication, a representative read, and a safe mutation.
6. Retain the previous verified digest and pre-upgrade backup until the observation
   period ends.

Moving tags are convenience aliases. For a controlled upgrade, pin the digest that
the GitHub Release and attestation identify.

## Future supported-release rollback

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
