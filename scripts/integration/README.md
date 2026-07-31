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

The Radarr and Sonarr fixture profiles include exact-target acquisition search,
title-monitoring reads, and editor updates. They assert that monitoring writes
contain only the selected movie or series identifier and the desired boolean;
file, path, profile, tag, and queue fields are never sent. Live profiles remain
read-only until disposable upstream environments are available.

The qBittorrent and SABnzbd contract profiles include bounded queue reads plus exact-item pause,
resume, front-of-queue promotion, and preserve-files removal shapes. qBittorrent contracts cover
both the version 5 `stop`/`start` and version 4 `pause`/`resume` endpoints plus `topPrio`; SABnzbd
contracts bind every action to one validated `nzo_id` and promotion to position zero. The protected
aggregate additionally starts both current digest-pinned upstream services in isolated internal
networks, seeds synthetic queue items, and exercises the production adapters. It requires observed
pause/resume and promotion state, exact removal, credential rejection, preserved fixture bytes,
sanitized evidence, and deterministic teardown. See the
[download-client fixture runbook](../../docs/operations/download-client-fixtures.md). Protected live
profiles remain pending until external compatibility environments record versioned evidence.

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
foundation PR is limited to the already ready fixture services. The OIDC and isolated Authentik
fixtures are ready and enforced. The protected aggregate also runs a digest-pinned Dex browser
fixture for generic discovery, PKCE S256, immutable identity, JIT provisioning, explicit role
mapping, and safe local logout when the provider advertises no logout endpoint. See the
[standards-generic OIDC fixture runbook](../../docs/operations/oidc-provider-fixture.md). Authentik readiness combines
the strict harness contract selected by the matrix with the dedicated browser flow
that starts the pinned upstream provider in the same pull-request workflow.

The same protected aggregate also generates the copyright-free
[playback fixture](../../docs/operations/playback-fixtures.md) with the FFmpeg build
from an immutable official Jellyfin image. It verifies seeking, alternate audio,
embedded captions, and HLS transcoding without claiming live Jellyfin API coverage.

The aggregate also runs the
[isolated download-client fixtures](../../docs/operations/download-client-fixtures.md) against
current digest-pinned qBittorrent and SABnzbd images. These checks use synthetic torrent and NZB
metadata on internal Docker networks, call the production adapters, and upload only a closed,
identifier-free pass report.

The aggregate separately runs the
[isolated Seerr request fixture](../../docs/operations/seerr-service-fixture.md). A fresh official
Seerr instance uses one private HTTPS metadata fixture while the production adapter resolves a
delegated identity, creates one pending request, rejects its duplicate, reviews it, and declines it.
The internal network has no external route, and passing evidence is written only after teardown.

Run the focused generic identity-provider gate with:

```sh
pnpm build
pnpm --filter @omnifin/web exec playwright install chromium
pnpm test:oidc-provider --skip-build --output artifacts/integration/oidc-provider/report.json
```

The generic and Authentik browser fixtures complement one another: the generic provider proves the
no-logout-capability fallback, while Authentik proves RP-initiated and back-channel logout when
advertised. Neither changes the pending protected live support baseline.

Scheduled and manual live checks run separately in
`.github/workflows/integration-live.yml`. They execute only from `main`, enter
the protected `integration` environment, and activate only after the repository
variable `OMNIFIN_LIVE_INTEGRATION_ENABLED=true` confirms that the isolated
upstream environment has been provisioned. Release profiles that require live evidence use that
protected configuration. All live entries intentionally remain pending; no live support baseline
is claimed.

`.github/workflows/compatibility.yml` is a separate secret-free latest-stable canary. It resolves
only reviewed upstream repositories and stable tag formats, selects the newest stable version tag,
binds that exact tag to an immutable digest before any pull, and reuses these harnesses in disposable
GitHub-hosted jobs. Its closed
aggregate records exact images, versions, checks, outcomes, verification time, and bounded failure
categories. It never turns fixture evidence into a live installation support claim.

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
