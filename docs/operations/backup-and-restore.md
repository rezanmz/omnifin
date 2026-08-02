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

Before creating the first backup or beginning an upgrade, run the read-only
[deployment doctor](deployment-doctor.md). Its backup check verifies only the mount's privacy and
access posture; the backup and restore commands below remain the source of recovery evidence.

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

## Schedule verified backups with bounded retention

Omnifin provides a one-shot retention command for a host scheduler. It does not run a cron daemon,
background timer, or privileged helper inside the application image:

```sh
docker compose run --rm --no-deps maintenance \
  backup-retained --retain 14
```

The retention count must be an integer from `2` through `365`. Each invocation creates a
collision-resistant UTC-named database and manifest beneath the configured
`OMNIFIN_BACKUP_DIRECTORY`, verifies the new pair independently, and only then evaluates older
recovery points. The command recognizes exact `omnifin-auto-*.sqlite` pairs whose manifests carry the
managed-retention marker written by this operation. Manual backups, notes, directories, and other
foreign files are never retention targets; a generated-looking manual pair causes attention instead
of being adopted or removed.

Before removing a generated pair, Omnifin requires both files to be private regular files and
revalidates the manifest, database digest, SQLite integrity, foreign keys, migration count, and schema
digest. A missing file, symlink, tamper, invalid manifest, excessive directory population, or
filesystem failure produces an `attention` result and stops further pruning. The newly verified pair
is preserved. A 15-minute overlap window can temporarily keep more than the requested count so
concurrent scheduler starts cannot delete one another's recovery points; a later successful run
converges retention.

Successful output has `status: "ok"` and exit code `0`. A verified new backup with retention requiring
operator attention has `status: "attention"` and exit code `75`; treat that as a failed scheduled job,
but do not discard the new pair. Usage errors exit `64`, and failures before a usable result exit `70`.
Output contains safe basenames, counts, digests, and enumerated reason codes, never configured host
paths.

Attention reasons are deliberately actionable without exposing the host:

| Reason                               | Operator response                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `retention_set_invalid`              | Inspect generated-looking pairs for a missing file, symlink, permission issue, or tamper; verify retained pairs individually.           |
| `retention_scan_failed`              | Check backup-directory availability, ownership, mount health, and host storage logs; the new verified pair remains available.           |
| `retention_scan_limit_exceeded`      | Move unrelated material out of the backup directory; the scan stops at 10,000 entries.                                                  |
| `retention_candidate_limit_exceeded` | Archive older generated pairs outside the active directory; at most 730 are evaluated.                                                  |
| `retention_delete_failed`            | Check directory ownership, permissions, capacity, and filesystem health; no current pair was intentionally removed.                     |
| `retention_cleanup_failed`           | An expired pair was retired but hidden cleanup remains; inspect the private directory without wildcard deletion.                        |
| `retention_rollback_failed`          | Stop scheduling, preserve the directory, and recover the reported unavailable pair from its hidden retired companion before continuing. |

Never clear an attention state with a broad `rm`, filename glob, or permission relaxation. Record a
directory listing privately, verify every visible pair, and move questionable files to separately
protected quarantine before the next scheduled run.

Keep the deployed `OMNIFIN_IMAGE` pinned to an immutable digest in the Compose environment used by the
scheduler. Retention limits local recovery points; it does not create an off-host copy. Replicate each
successful pair plus the separately protected encryption key, recovery secret, configuration, and
image digest to independent authenticated storage.

### systemd timer

Use a dedicated unprivileged account that can run only the required container workflow. Install
`/etc/systemd/system/omnifin-backup.service` with the deployment directory adjusted for the host:

```ini
[Unit]
Description=Create and verify an Omnifin recovery point
Requires=docker.service
After=docker.service
ConditionPathIsDirectory=/srv/omnifin

[Service]
Type=oneshot
User=omnifin
Group=omnifin
WorkingDirectory=/srv/omnifin
UMask=0077
ExecStart=/usr/bin/docker compose run --rm --no-deps maintenance backup-retained --retain 14
TimeoutStartSec=30m
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
```

Access to a rootful Docker socket is effectively host-administrator access even when the scheduler
account has no login shell. Do not add a broad interactive user to the Docker group for this job;
protect the dedicated account and socket accordingly, or use an equivalently isolated rootless
container runtime with paths adapted to that host.

Install `/etc/systemd/system/omnifin-backup.timer`:

```ini
[Unit]
Description=Schedule verified Omnifin recovery points

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=30m
Persistent=true
Unit=omnifin-backup.service

[Install]
WantedBy=timers.target
```

Then validate and enable it:

```sh
sudo systemd-analyze verify \
  /etc/systemd/system/omnifin-backup.service \
  /etc/systemd/system/omnifin-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now omnifin-backup.timer
sudo systemctl start omnifin-backup.service
sudo systemctl status omnifin-backup.service
```

systemd does not start a second instance of the same active oneshot service. Route unit failures to the
host's existing alerting and periodically review `journalctl -u omnifin-backup.service` for a single
structured result.

### cron with an overlap lock

When systemd is unavailable, prepare a private lock owned by the scheduler account:

```sh
sudo install -d -m 0700 -o omnifin -g omnifin /srv/omnifin/.locks
sudo install -m 0600 -o omnifin -g omnifin /dev/null \
  /srv/omnifin/.locks/backup.lock
```

Add a crontab entry for that account. Keep the command on one line in the actual crontab:

```cron
17 3 * * * cd /srv/omnifin && /usr/bin/flock --nonblock /srv/omnifin/.locks/backup.lock /usr/bin/docker compose run --rm --no-deps maintenance backup-retained --retain 14
```

Do not append `|| true`: a non-zero exit is the alert signal. Confirm that cron delivery or the host's
job monitor records failures, and run the command interactively once before relying on the schedule.
The external lock prevents normal overlap; Omnifin's internal overlap grace remains a final fail-safe,
not the primary scheduler lock.

At least quarterly, copy a selected recovery set to an isolated host and complete the restore exercise
below. Backup creation, verification, and retention are not proof that the encryption key, image,
configuration, and external copy can recover the installation together.

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
