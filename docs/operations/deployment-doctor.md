# Deployment doctor

The deployment doctor is a read-only preflight from the same immutable image that runs Omnifin. It
checks the deployed runtime, private control plane, public HTTPS boundary, SQLite posture, and backup
directory before an operator exposes or upgrades an installation.

It complements the browser setup guide. The browser flight check reports configuration state; the
doctor also makes bounded requests through the configured public origin and private Compose network.
Neither replaces a backup restore rehearsal or a representative authenticated media operation.

## Run the preflight

Start the normal `gateway` and `web` services first, then run:

```sh
docker compose run --rm --no-deps maintenance doctor
```

The command exits with:

- `0` when every check is ready;
- `78` when the report was generated but one or more checks need attention;
- `64` for an invalid command invocation; or
- `70` when the maintenance process cannot generate a trustworthy report.

The doctor accepts no URL, path, header, certificate, or insecure-mode argument. It uses only the
deployment's configured `OMNIFIN_BASE_URL`, fixed private gateway endpoints, database mount, backup
mount, runtime mode, and image reference. Normal certificate and hostname validation always applies,
and cross-origin or same-origin redirects are not followed.

## Understand the report

The single JSON line is deliberately safe to retain in private operational records:

```json
{
  "operation": "doctor",
  "status": "ok",
  "checks": [
    { "id": "runtime", "state": "ready" },
    { "id": "image", "state": "ready" },
    { "id": "gateway", "state": "ready" },
    { "id": "public_boundary", "state": "ready" },
    { "id": "storage", "state": "ready" },
    { "id": "backup", "state": "ready" }
  ],
  "generatedAt": "2026-08-01T12:00:00.000Z",
  "readyCount": 6,
  "schemaVersion": 1,
  "state": "ready",
  "total": 6
}
```

An attention check adds one fixed `code`. The report never contains origins, hostnames, addresses,
paths, image references, header values, environment values, database contents, response bodies, or
secret-derived values.

| Check             | What is verified                                                                    |
| ----------------- | ----------------------------------------------------------------------------------- |
| `runtime`         | The maintenance image is running with production safeguards.                        |
| `image`           | `OMNIFIN_IMAGE` is pinned to an immutable `sha256` digest.                          |
| `gateway`         | Private liveness and database readiness return the strict bounded response shape.   |
| `public_boundary` | Canonical HTTPS is reachable without redirects and returns required protections.    |
| `storage`         | SQLite is file-backed, readable, internally consistent, and has a migration ledger. |
| `backup`          | The backup directory is private and readable, writable, and searchable.             |

Use the fixed attention code to choose the runbook action:

- `runtime_not_production`: deploy a tagged runtime image through the production Compose file.
- `image_reference_not_immutable`: replace a moving tag with the release's published digest.
- `gateway_unavailable`, `gateway_unready`, or `gateway_response_invalid`: inspect gateway health and
  readiness before serving traffic; do not publish raw responses.
- `public_origin_invalid`, `public_origin_unavailable`, `public_response_invalid`, or
  `public_headers_invalid`: correct the canonical URL, certificate, reverse proxy route, redirect
  policy, or security-header forwarding.
- `storage_not_persistent`, `storage_unavailable`, or `storage_integrity_failed`: stop the rollout and
  inspect the selected volume, migration state, and most recent verified recovery set.
- `backup_directory_unavailable` or `backup_directory_not_private`: restore the documented bind mount,
  ownership, access, and `0700` mode before creating a backup.

## Public-path limitations

The public check originates inside the maintenance container. Some routers cannot resolve a public
homelab name back to the same host or do not support hairpin NAT. In that case
`public_origin_unavailable` does not prove the public service is down; it proves that this required
vantage point could not reach it.

Repeat the check from an external client that uses ordinary DNS and certificate trust:

```sh
curl --fail --silent --show-error \
  --dump-header omnifin-health.headers \
  --output /dev/null \
  https://media.example.test/healthz
```

Confirm status `200`, no redirect, and the CSP, HSTS, permissions, referrer, frame, and content-type
headers described in the [reverse proxy runbook](reverse-proxy.md). Delete the captured header file
after the check because infrastructure headers are installation-specific. Do not weaken TLS or add an
insecure doctor override to bypass a certificate failure.

## Boundaries the doctor cannot prove

The doctor does not read the encryption key or recovery secret, decrypt connector credentials,
perform sign-in, mutate an upstream service, create a backup, or prove a backup can be restored. It
also cannot establish that a host volume is durable beyond the container-visible filesystem.

After a ready report, complete the [first-run checklist](../first-run.md), create and verify an online
backup, rehearse the [restore procedure](backup-and-restore.md) on an isolated deployment, and verify
an authenticated read plus a permission-checked mutation.
