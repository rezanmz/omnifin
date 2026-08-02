# First-run runbook

This runbook takes a verified release bundle or reviewed source checkout to its first local Omnifin
administrator. Omnifin remains pre-release software until `v1.0.0`; each tagged phase release
supports only the capabilities and upstream versions stated in its notes and compatibility matrix.

## 1. Prepare the deployment

Choose a canonical public origin and a Jellyfin server that Omnifin can reach. Production cookies
and OIDC require HTTPS. The bundled Compose file publishes only the web process on loopback; place a
maintained TLS reverse proxy in front of it and do not publish the gateway. Use the
[reverse proxy runbook](operations/reverse-proxy.md) for one-host Caddy and Nginx examples, exact
trusted-hop behavior, live-event settings, and public verification.

For a tagged release, first verify the downloaded `SHA256SUMS`, create the local environment file
from the digest-pinned template, and generate two independent file-backed secrets:

```sh
sha256sum --check SHA256SUMS
cp omnifin.env.example .env
chmod 0600 .env
install -d -m 0700 secrets
umask 077
openssl rand -base64 32 | tr -d '\n' > secrets/omnifin_encryption_key
openssl rand -base64 48 | tr -d '\n' > secrets/omnifin_recovery_secret
chmod 0444 secrets/omnifin_encryption_key secrets/omnifin_recovery_secret
```

Compose bind-mounts local secret files without changing their host ownership, while the Omnifin
image runs as an unprivileged numeric user. The files are therefore read-only for every identity,
but other host users cannot traverse the `0700` directory to read them. Keep that directory owned
by the deployment account and do not loosen its permissions.

For a reviewed source checkout, use `.env.example` instead. Never copy a release environment file
between versions: its `OMNIFIN_IMAGE` value intentionally binds it to one verified image digest.

The release environment template points Compose at those two paths through
`OMNIFIN_ENCRYPTION_KEY_FILE` and `OMNIFIN_RECOVERY_SECRET_FILE`. The secret values stay out of
`.env` and are mounted read-only into the gateway. Also set:

```dotenv
OMNIFIN_BASE_URL=https://omnifin.example.net
OMNIFIN_JELLYFIN_URL=https://jellyfin.example.net
OMNIFIN_SECURE_COOKIES=true
OMNIFIN_INSECURE_LOOPBACK_PREVIEW=false
```

For a deliberately trusted private-network Jellyfin URL using plain HTTP, set
`OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED=true`. Prefer HTTPS and restrict network paths in either
case. Keep `.env`, `secrets/`, and their contents private; never commit them, and store the
encryption key and recovery secret separately from the SQLite backup. Prepare the bind-mounted
backup directory for the numeric runtime identity:

```sh
sudo install -d -m 0700 -o 65532 -g 65532 backups
```

## 2. Start and verify

For a tagged release bundle, pull and start the exact digest from its environment file:

```sh
docker compose --env-file .env --file compose.yaml pull
docker compose --env-file .env --file compose.yaml up --detach --wait
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
curl --fail --silent --show-error http://127.0.0.1:3000/api/runtime
docker compose --env-file .env --file compose.yaml exec -T gateway \
  /nodejs/bin/node /opt/omnifin/bin/healthcheck.mjs http://127.0.0.1:4000/readyz
```

Source-checkpoint reviewers use `docker compose up --detach --build --wait` from the repository root
instead. Do not add `--build` to release-bundle commands: the bundle deliberately contains no build
context and must run the already verified image.

The web check proves liveness. The runtime response must report the selected release version,
`stable`, `verified`, and a full revision whose corresponding-source URL ends in that same revision.
The private gateway check additionally reaches the process that owns SQLite and upstream secrets.
Open `<OMNIFIN_BASE_URL>/about` to inspect and copy the same privacy-safe identity without signing
in. Inspect `docker compose ps` and sanitized logs if any check fails; do not substitute a guessed
version when the runtime identity is unavailable.

After the public HTTPS origin and immutable image digest are configured, run the read-only
[deployment doctor](operations/deployment-doctor.md):

```sh
docker compose run --rm --no-deps maintenance doctor
```

Resolve every attention result or document an externally verified hairpin-network exception before
exposing the installation. A ready doctor report does not replace the backup and recovery exercise
below.

## 3. Establish the first administrator

Open `<OMNIFIN_BASE_URL>/recovery` directly. It is intentionally absent from the ordinary login
screen, sitemap, and application navigation.

1. Enter the recovery secret from the deployment.
2. Choose either **Set up or claim with OIDC** or Jellyfin password/Quick Connect.
3. For OIDC, validate and enable the provider, then use **Continue with OIDC**. For Jellyfin,
   authenticate as an account that is currently an administrator upstream.
4. Confirm that Omnifin reports the local role as `admin`.

Password proof is exchanged directly with Jellyfin and discarded immediately. Quick Connect is
bound to the exact recovery browser session. In both cases, Omnifin verifies Jellyfin's explicit
administrator policy, stores only the returned token encrypted at rest, and performs user creation,
role assignment, recovery-session replacement, and auditing in one SQLite transaction.

The OIDC alternative is also bound to the exact CSRF-proven recovery session, provider, PKCE state,
and callback. It can create the first administrator even when provider JIT provisioning is disabled.
Until that administrator separately pairs Jellyfin, only identity, connector, role, audit, session,
and recovery administration are available; library, playback, request, acquisition, download, and
other media mutations remain denied.

If a provider is unavailable or Jellyfin does not confirm administrator policy for the Jellyfin
path, Omnifin leaves the short-lived recovery session intact for another attempt. If an Omnifin
administrator already exists or a recovery-proven OIDC administrator is awaiting Jellyfin pairing,
bootstrap is refused. Ordinary OIDC and Jellyfin sign-in never bootstrap authority.

After the administrator session is active, open **Account & access → Setup guide**. The guide reads
only normalized, browser-safe administration contracts and separates the two essential readiness
checks—your verified Jellyfin identity and a validated Jellyfin service—from optional stack
extensions. It never displays connector addresses, credentials, external identifiers, raw upstream
responses, or the recovery path. If one upstream service fails validation, independently verified
steps remain visible alongside the affected service's normalized attention state and are not
promoted into a false success.

After the services you use are enabled, run the guide's **Post-install flight check**. It performs
fresh, upstream-read-only checks for every configured OIDC provider and media connector, keeps
partial failures isolated, and offers a privacy-safe JSON download. Resolve every attention result
before an upgrade observation period ends. The [stack verification runbook](operations/stack-verification.md)
describes the report's privacy boundary and explains why it is local diagnostic evidence rather
than a public compatibility claim.

## 4. Configure identity and services

From the administrator session, use the live setup guide as the index for these actions:

1. Open **Account & access → Identity providers** to configure Authentik or another standards-based
   OIDC issuer. Register the exact callback and logout URLs shown before enabling the provider.
2. Add exact claim-to-role mappings only after a viewer-default sign-in succeeds. Never map a broad
   group to `admin` as a first test.
3. Open **Service connections**, add one upstream service at a time, run its safe validation, inspect
   the capability snapshot, and only then enable it.
4. Sign out and verify both ordinary Jellyfin and OIDC login paths. OIDC users must prove control of
   their Jellyfin account before media access.

OIDC is recommended for homes that already operate an identity provider, but it is not part of the
core-ready boundary. Radarr, Sonarr, Prowlarr, Bazarr, Seerr, qBittorrent, and SABnzbd are similarly
optional: connect only the services present in the deployment. A partially configured group remains
visible as partial rather than making the whole application appear unavailable.

## 5. Rehearse recovery and backups

Recovery sessions expire after 15 minutes, are rate-limited, and are revoked whenever the gateway
starts. Verify that `/recovery` remains unlinked, incorrect secrets receive an opaque denial, and a
gateway restart invalidates an issued recovery session. Rotate the recovery secret and recreate the
gateway after an incident or any possible disclosure.

Create and verify a database backup only after the first administrator exists. A usable recovery set
contains the SQLite backup and manifest, the immutable image digest, deployment configuration, and
the matching encryption key and recovery secret stored separately. Follow the
[backup and restore runbook](operations/backup-and-restore.md) before the installation holds data you
cannot replace.

After the manual restore rehearsal succeeds, configure the runbook's one-shot
`backup-retained` command through a host systemd timer or an overlap-locked cron entry. Alert on every
non-zero exit and keep an independently protected off-host copy; local retention alone is not a
recovery strategy.
