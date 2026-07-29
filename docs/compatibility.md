# Service compatibility

Omnifin uses capability discovery rather than assuming a product name implies a
fixed API. This page records the target matrix and the evidence required before a
combination is described as supported.

> [!NOTE]
> There is no verified public compatibility baseline yet. Every entry below is a
> target for pre-release integration work, not a support claim.

| Service                           | Intended use                                                    | Current status                                              |
| --------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Jellyfin                          | Identity, libraries, playback, watch state, scans, metadata     | Identity/playback isolated gates ready; live pending        |
| Authentik                         | OIDC sign-in, group claims, front/back-channel logout           | Isolated gate ready; live baseline pending                  |
| Standards-compliant OIDC provider | Discovery, code flow with PKCE, claims, logout when advertised  | Target; verification pending                                |
| Seerr                             | Discovery, requests, approvals, issues, user context            | Search/request fixtures ready; live baseline pending        |
| Radarr                            | Movie monitoring, calendar, search, releases, queue, history    | Contracts and isolated read gate ready; live pending        |
| Sonarr                            | Series monitoring, calendar, search, releases, queue, history   | Contracts and isolated read gate ready; live pending        |
| Bazarr                            | Subtitle status, search, and download                           | Contracts and isolated empty-state gate ready; live pending |
| Prowlarr                          | Indexer status, statistics, failures, sync, safe tests          | Contracts and isolated read gate ready; live pending        |
| qBittorrent                       | Queue, rates, exact pause/resume, front promotion, safe removal | Isolated 5.2.0 gate ready; live baseline pending            |
| SABnzbd                           | Queue, rates, exact pause/resume, front promotion, safe removal | Isolated 5.0.4 gate ready; live baseline pending            |

Seerr is the primary request-management target. Compatibility with older Jellyseerr
and Overseerr installations is capability-based and will be listed only after it is
demonstrated in the integration matrix. Tautulli remains an optional Plex-oriented
integration rather than a Jellyfin dependency.

## Definition of supported

A service version becomes supported only after automated and documented checks cover:

- version and capability discovery;
- authentication and health;
- representative reads and explicitly safe mutations;
- polling or event behavior where applicable;
- invalid credentials and permission errors;
- timeouts, cancellation, retry, and recovery;
- malformed or version-shifted responses; and
- deterministic teardown without leftover media or credentials.

The published matrix will name the oldest supported version and latest verified
version. “Latest” without a recorded version and verification date is not sufficient.

## Verification cadence

Pull requests run the affected deterministic fixture matrix in
`.github/workflows/integration.yml`; that workflow has no access to live service
credentials. Its required `Connector integration` gate reflects fixture evidence only.
All deterministic fixture suites are marked ready. OIDC is covered by protocol and
gateway contract fixtures; Authentik additionally runs a pinned, isolated upstream
authorization-code browser harness. Fixture readiness is development evidence and
does not establish a public live-support baseline.

The protected connector aggregate also creates a deterministic, copyright-free media fixture and
imports it into a fresh digest-pinned Jellyfin instance. Omnifin's production connector must then
complete direct range playback, a seeked HLS transcode, alternate audio and subtitle selection,
progress persistence, and playback renegotiation after a server restart. The sanitized evidence
records the exact Jellyfin image and version without retaining service, account, media, path, or
credential identifiers.

The same aggregate starts current digest-pinned qBittorrent 5.2.0 and SABnzbd 5.0.4 instances on
separate internal Docker networks. Synthetic queue items must pass production-adapter
authentication, version discovery, normalized reads, invalid-credential rejection, observed exact
pause/resume, front-of-queue promotion, preserve-files removal, and teardown. The closed reports
omit native item IDs,
credentials, ports, paths, and logs. See the
[download-client fixture runbook](operations/download-client-fixtures.md). These disposable checks
are stronger than mocked transport contracts, but they remain development evidence rather than a
public installation support claim.

Fresh digest-pinned Radarr 6.3.0.10514, Sonarr 4.0.19.2979, Prowlarr 2.5.2.5491, and Bazarr 1.6.0
instances also run on one private network per service. Omnifin's production adapters must pass
exact version discovery, authentication, invalid-key rejection, and their service-specific
normalized empty-state reads before the connector aggregate succeeds. Passing evidence is written
only after deterministic teardown and cannot contain credentials, URLs, ports, paths, identifiers,
logs, or upstream payloads. See the
[isolated service fixture runbook](operations/servarr-service-fixtures.md). This remains read-only
development evidence; live support and safe mutation claims remain pending.

Scheduled and manual probes run in `.github/workflows/integration-live.yml` only from
`main` and only through the protected `integration` environment. Until the repository
variable `OMNIFIN_LIVE_INTEGRATION_ENABLED` is exactly `true`, the workflow reports a
pending status and does not consume environment secrets. Once enabled, every selected
profile must also be `ready` in the schema-validated coverage ledger; strict mode fails
closed on a pending entry before making a probe. All live entries are currently
pending, so there is no verified live baseline.

The stable release workflow applies the strict cumulative matrix declared by its
reviewed phase profile. A Phase 0 release has no live compatibility claim; later
profiles enter the same protected environment for every capability they claim, and
`v1` requires the complete fixture and live service matrix. The weekly canary uses the
protected configuration to evaluate new upstream releases and open a labelled
compatibility issue on regression. Fixture results remain development evidence rather
than a public support claim until live evidence records exact versions and dates.

## Reporting a compatibility problem

Use the compatibility issue form and include Omnifin version or image digest,
upstream product and exact version, the capability that failed, sanitized gateway
diagnostics, and reproduction steps. Never include API keys, cookies, user tokens,
OIDC assertions, private hostnames, or media paths.
