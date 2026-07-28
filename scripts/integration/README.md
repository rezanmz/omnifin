# Integration runner

The integration runner has two deliberately distinct profiles:

- `fixture` runs deterministic adapter or authentication contract tests from
  this repository after building the selected package's workspace dependencies.
  It does not claim that an upstream service was started.
- `live` probes explicitly configured upstream services. The current live gate
  covers authentication where required, health/version discovery, response
  shape validation, and OIDC metadata. Prowlarr additionally verifies the read
  surfaces used by Indexer Intelligence. Safe mutations run only in disposable
  fixtures until isolated live service environments are provisioned.

Run one service or the full matrix:

```sh
node scripts/integration/run.mjs --service jellyfin
node scripts/integration/run.mjs --all
node scripts/integration/run.mjs --all --mode live
node scripts/integration/compatibility.mjs --output compatibility.json
node scripts/integration/release-coverage.mjs --version 0.1.0
node scripts/integration/release-gate.mjs --version 0.1.0 --mode fixture
```

Use `--strict` when a gate must fail for any unconfigured, unimplemented, or
not-ready profile. Strict mode validates the ledger schema and rejects a
`pending` service before running its probe; configuration alone cannot turn
pending coverage into a release claim. Reports contain only service names,
profile names, versions, normalized status values, check names, normalized
error categories, and bounded test-file basenames on fixture failure. Assertion
messages, filesystem paths, URLs, credentials, headers, cookies, and raw
upstream payloads are never included.

`readiness.json` is the reviewed coverage ledger. It must contain exactly every
known service, both `fixture` and `live` profiles, and only the states `pending`
or `ready`. Pull requests run `.github/workflows/integration.yml` with fixture
data and no secrets. They execute affected services marked fixture-ready with
strict enforcement. Affected pending suites are reported separately and are
not counted as verified coverage, allowing their implementation to land in
reviewed increments. The pull request that changes a suite from `pending` to
`ready` places it in the strict matrix immediately, so that transition cannot
pass with missing, skipped, or failing tests. A pending-only change still runs
the established ready fixture baseline. The one-time empty-repository
foundation PR is limited to the already ready fixture services. The OIDC and
isolated Authentik fixtures are ready and enforced. Authentik readiness combines
the strict harness contract selected by the matrix with the dedicated browser flow
that starts the pinned upstream provider in the same pull-request workflow.

The same protected aggregate also generates the copyright-free
[playback fixture](../../docs/operations/playback-fixtures.md) with the FFmpeg build
from an immutable official Jellyfin image. It verifies seeking, alternate audio,
embedded captions, and HLS transcoding without claiming live Jellyfin API coverage.

Scheduled and manual live checks run separately in
`.github/workflows/integration-live.yml`. They execute only from `main`, enter
the protected `integration` environment, and activate only after the repository
variable `OMNIFIN_LIVE_INTEGRATION_ENABLED=true` confirms that the isolated
upstream environment has been provisioned. The weekly compatibility canary and
any release profile that requires live evidence use the same protected
configuration. All live entries intentionally remain pending; no live support
baseline is claimed.

`release-coverage.json` separately declares which ready capabilities a phase
release claims. Coverage is cumulative and validated against `readiness.json`:

| Release profile           | Required fixture coverage               | Required live coverage                  |
| ------------------------- | --------------------------------------- | --------------------------------------- |
| `phase0`                  | Current connector contract fixtures     | None                                    |
| `phase1` and `phase2`     | All connector and identity fixtures     | OIDC, Authentik, Jellyfin               |
| `phase3` through `phase5` | Full service matrix                     | Full service matrix                     |
| `v1`                      | Full service matrix, enforced by schema | Full service matrix, enforced by schema |

The selected profile is reviewed in the release source. Its required entries
must be marked `ready`; pending services outside that profile do not prevent a
truthful `v0.x` phase release and are not claimed by it. A version of `1.0.0` or
later is rejected unless the explicit `v1` profile is selected, and the `v1`
schema cannot omit a service. Release checks are strict and ignore
`OMNIFIN_LIVE_INTEGRATION_ENABLED`; when the selected profile has live
requirements, the workflow enters the protected `integration` environment and
fails on an unconfigured or pending probe.

Configure these non-secret values as variables on the protected `integration`
environment:

| Service or policy    | Environment variable             |
| -------------------- | -------------------------------- |
| OIDC                 | `OMNIFIN_OIDC_ISSUER_URL`        |
| Authentik            | `OMNIFIN_AUTHENTIK_ISSUER_URL`   |
| Jellyfin             | `OMNIFIN_JELLYFIN_URL`           |
| Seerr                | `OMNIFIN_SEERR_URL`              |
| Radarr               | `OMNIFIN_RADARR_URL`             |
| Sonarr               | `OMNIFIN_SONARR_URL`             |
| Prowlarr             | `OMNIFIN_PROWLARR_URL`           |
| Bazarr               | `OMNIFIN_BAZARR_URL`             |
| qBittorrent          | `OMNIFIN_QBITTORRENT_URL`        |
| SABnzbd              | `OMNIFIN_SABNZBD_URL`            |
| Isolated HTTP opt-in | `OMNIFIN_INTEGRATION_ALLOW_HTTP` |

Configure credentials as environment secrets, never repository variables:

| Service     | Environment secret                                                 |
| ----------- | ------------------------------------------------------------------ |
| Seerr       | `OMNIFIN_SEERR_API_KEY` (optional for the current discovery probe) |
| Radarr      | `OMNIFIN_RADARR_API_KEY`                                           |
| Sonarr      | `OMNIFIN_SONARR_API_KEY`                                           |
| Prowlarr    | `OMNIFIN_PROWLARR_API_KEY`                                         |
| Bazarr      | `OMNIFIN_BAZARR_API_KEY`                                           |
| qBittorrent | `OMNIFIN_QBITTORRENT_USERNAME`, `OMNIFIN_QBITTORRENT_PASSWORD`     |
| SABnzbd     | `OMNIFIN_SABNZBD_API_KEY`                                          |

All live integration endpoints must use HTTPS. Isolated container test environments
may opt into HTTP by setting `OMNIFIN_INTEGRATION_ALLOW_HTTP=true` exactly; do not
use that override against an untrusted network.
