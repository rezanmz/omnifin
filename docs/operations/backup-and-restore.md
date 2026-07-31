# Backup and restore runbook

Omnifin backups contain account links, sessions, audit history, connector configuration,
and encrypted service credentials. Treat every backup as sensitive even though protected
values remain encrypted. Keep the matching encryption key, recovery secret, Compose
configuration, and immutable image reference in a separate protected recovery set.

The maintenance command creates an online SQLite backup through SQLite's backup API. It
then runs database and foreign-key integrity checks and writes a private manifest containing
the database size, SHA-256 digest, schema digest, migration count, SQLite version, image
reference, and creation time. Neither the source path nor other host paths are recorded.

## Prepare private backup storage

The maintenance container runs as numeric user and group `65532` and refuses to write to a
directory accessible by group or other users. Prepare the bind-mounted directory before the
first operation:

```sh
install -d -m 0700 backups
```

On a native Linux host, set the directory owner to `65532:65532` if the container runtime does
not map the current owner to the container user:

```sh
sudo chown 65532:65532 backups
```

Set `OMNIFIN_BACKUP_DIRECTORY` when the private directory is not `./backups`. Compose refuses
to create the host path implicitly so a typo cannot silently place recovery data elsewhere.

## Create and verify an online backup

Choose a new filename for every backup. Existing database or manifest files are never
overwritten.

```sh
docker compose run --rm --no-deps maintenance \
  backup --output /backups/omnifin-2026-07-28.sqlite

docker compose run --rm --no-deps maintenance \
  verify --input /backups/omnifin-2026-07-28.sqlite
```

A successful operation emits one JSON object containing only safe metadata and basenames.
Retain both files:

- `omnifin-2026-07-28.sqlite`
- `omnifin-2026-07-28.sqlite.manifest.json`

Copy the pair to independently protected storage, record the exact deployed image digest,
and verify the copied pair again before relying on it. A checksum protects against accidental
damage; it is not a substitute for access control or an authenticated storage system.

## Rehearse a restore

Test recovery on an isolated host or isolated Compose project before testing it against the
primary deployment. Supply the same encryption key as the selected backup, pin the recorded
image digest, and place the selected database and manifest in the private backup directory.

The restore command intentionally requires downtime. It refuses to proceed without an
explicit confirmation, refuses when the configured gateway health endpoint responds, and
refuses when SQLite WAL or shared-memory sidecars show that storage is not quiescent.

```sh
docker compose stop web gateway

docker compose run --rm --no-deps maintenance \
  restore \
  --input /backups/omnifin-2026-07-28.sqlite \
  --rollback-output /backups/pre-restore-2026-07-28.sqlite \
  --confirm-gateway-stopped

docker compose up -d gateway
docker compose exec -T gateway \
  /nodejs/bin/node /opt/omnifin/bin/healthcheck.mjs http://127.0.0.1:4000/readyz
docker compose up -d web
```

The pre-restore rollback database and its manifest are created and fully synced before the
selected backup is staged, checked against its previously verified digest and schema, and
atomically replaces the active database. Keep that pair until the restored
deployment passes readiness, authentication, connector decryption, a representative read,
and a permission-checked mutation. A running container is not sufficient proof that the
matching encryption key was supplied.

If the maintenance command reports `database_not_quiescent`, do not delete SQLite sidecar
files. Confirm that every process using the volume is stopped and investigate an unclean
shutdown before retrying. If it reports `gateway_still_running`, stop the gateway and repeat
the operation. Other failures leave the active database untouched unless replacement had
already occurred; in that case the command automatically reinstates the verified rollback or
fails closed with both errors preserved.

An interrupted restore can leave `omnifin.db.maintenance.lock` in the data volume. Gateway
startup deliberately refuses that state. After confirming that the gateway is stopped and no
restore process remains, clear only that marker through the maintenance command; do not remove
database, WAL, or shared-memory files:

```sh
docker compose run --rm --no-deps maintenance \
  unlock --confirm-gateway-stopped
```

## Upgrade and rollback rehearsal

Before an upgrade:

1. Verify a fresh backup pair and record the current image digest.
2. Pull the new image by immutable digest.
3. Stop the web process, then replace and start the gateway.
4. Wait for `/readyz`; do not start the web process if migration or storage readiness fails.
5. Start the web process and verify sign-in, linked services, representative reads, and a safe
   mutation.
6. Retain the old digest and pre-upgrade recovery set through the observation period.

Never start older application code against a newer database unless the release notes state
that the schema is backward compatible. Otherwise restore the matching pre-upgrade backup
while selecting the previously verified image digest. Published tags remain immutable;
rollback selects an earlier version or digest rather than moving a tag.

### Automated release rehearsal

Before stable aliases can move, the release workflow performs the same safety sequence with
bounded synthetic state on a GitHub-hosted runner. It resolves the previous stable image and
candidate to immutable digests, creates an OIDC provider through the previous image's real recovery
API, creates and verifies a private backup, then starts the candidate against that persisted data.
After candidate health, migration, and state checks pass, the runner preserves and verifies the
candidate database as the automatic rollback set, restores the previous backup, and proves the
exact previous image can still read the original provider state.

The initial-release exception is fail-closed: it is available only when the registry has no stable
version tags and the repository has no published release. A missing or inconsistent `latest` alias
after any stable publication blocks promotion instead of silently skipping the rehearsal.

The job removes its generated credentials, database, backups, volumes, network, and containers even
when a check fails. Its retained report contains only the two image digests, schema digests,
migration counts, normalized check names, and status. It contains no provider identifiers, client
secret, recovery secret, database digest, path, log, or raw API response. This protects release
promotion from an untested schema transition; it does not replace a deployment-specific rehearsal
with representative data and external services.
