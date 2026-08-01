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
docker compose --env-file .env --file compose.yaml exec -T gateway \
  /nodejs/bin/node /opt/omnifin/bin/healthcheck.mjs http://127.0.0.1:4000/readyz
```

Source-checkpoint reviewers use `docker compose up --detach --build --wait` from the repository root
instead. Do not add `--build` to release-bundle commands: the bundle deliberately contains no build
context and must run the already verified image.

The web check proves liveness. The private gateway check additionally reaches the process that owns
SQLite and upstream secrets. Inspect `docker compose ps` and sanitized logs if either check fails.

## 3. Establish the first administrator

Open `<OMNIFIN_BASE_URL>/recovery` directly. It is intentionally absent from the ordinary login
screen, sitemap, and application navigation.

1. Enter the recovery secret from the deployment.
2. Choose password or Jellyfin Quick Connect.
3. Authenticate as an account that is currently an administrator in Jellyfin.
4. Confirm that Omnifin opens an active session and reports the local role as `admin`.

Password proof is exchanged directly with Jellyfin and discarded immediately. Quick Connect is
bound to the exact recovery browser session. In both cases, Omnifin verifies Jellyfin's explicit
administrator policy, stores only the returned token encrypted at rest, and performs user creation,
role assignment, recovery-session replacement, and auditing in one SQLite transaction.

If Jellyfin is unavailable or the account is not an administrator, Omnifin leaves the short-lived
recovery session intact for another attempt. If an active Omnifin administrator already exists, the
bootstrap is refused. Signing in through the normal Jellyfin button does not bootstrap authority;
new direct accounts are local viewers regardless of their upstream Jellyfin role.

After the administrator session is active, open **Account & access → Setup guide**. The guide reads
only normalized, browser-safe administration contracts and separates the two essential readiness
checks—your verified Jellyfin identity and a validated Jellyfin service—from optional stack
extensions. It never displays connector addresses, credentials, external identifiers, raw upstream
responses, or the recovery path. If one upstream service fails validation, independently verified
steps remain visible alongside the affected service's normalized attention state and are not
promoted into a false success.

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
