# Stack verification report

Omnifin's setup guide includes an administrator-run stack verification for post-install,
post-configuration, and post-upgrade checks. It performs a fresh check of every configured OIDC
provider and media connector through the same destination, TLS, credential, discovery, timeout, and
response-validation boundaries used by normal administration.

This is a local diagnostic. It does not promote an upstream version into Omnifin's public support
matrix and does not replace the protected live-compatibility gate in
[compatibility.md](../compatibility.md).

## Run a verification

1. Sign in as a full Omnifin administrator. A recovery session or a role with only some connector
   permissions cannot run this broad diagnostic.
2. Open **Account & access → Setup guide**.
3. Under **Post-install flight check**, select **Run stack verification**.
4. Resolve any disabled, unreachable, rejected, timed-out, or unsupported service result.
5. Run the check again, then download the safe JSON if you need a durable upgrade record or a
   shareable support attachment.

Only one run may be active per administrator session, and the endpoint permits two starts per
minute. Up to four upstream checks run concurrently. A slow or unavailable service cannot hide the
results for the rest of the stack.

## What the check changes

The upstream operations are read-only. Connector probes and OIDC discovery do not request media
mutations, library changes, queue actions, or provider configuration changes.

The gateway does refresh each service's local last-known health snapshot and writes the existing
minimal validation audit event. It does not persist or log the assembled report. The response is
non-cacheable, and the browser creates the JSON download only after an explicit user action.

## Report contents

The versioned report uses a closed schema and a canonical order:

1. OpenID Connect
2. Jellyfin
3. Seerr
4. Radarr
5. Sonarr
6. Prowlarr
7. Bazarr
8. qBittorrent
9. SABnzbd

For each service kind, the report contains only bounded configured, enabled, attempted, and ready
counts; normalized capability names; narrowly validated version strings; and allowlisted finding
codes. A configured but disabled service is not counted as ready. A service is `partial` when at
least one, but not every, configured instance is ready.

Treat upstream version and error fields as untrusted. Omnifin exports a version only when it matches
a narrow 64-character product-version grammar. Any other value is omitted and represented by the
`version_redacted` finding. Raw upstream messages never reach the report.

The report does not contain:

- connector or provider IDs, names, or URLs;
- usernames, identity subjects, claim values, email addresses, or Jellyfin user IDs;
- credentials, tokens, cookies, OIDC assertions, or recovery material;
- media titles, upstream media IDs, download names, media paths, or filesystem paths;
- raw upstream payloads, raw exceptions, request IDs, IP data, or audit metadata; or
- database, host, proxy, or secret-file locations.

The list of service kinds and their aggregate counts necessarily describes the shape of the stack.
Review that bounded inventory before posting a report publicly.

## API boundary

The browser calls `POST /api/admin/setup/verification`, which proxies to the private gateway's
`POST /v1/admin/setup/verification`. The request requires an exact canonical origin, a valid
server-side session, the session's CSRF header, `connectors.manage`, and
`recovery.oidc.manage`. Success responses use `Cache-Control: no-store` and the
`omnifin-stack-verification` format at schema version 1.

Do not automate the endpoint as an availability monitor. Use the private `/healthz` and `/readyz`
checks for service supervision and the [deployment doctor](deployment-doctor.md) for the host,
public-origin, image, database, and backup boundaries.
