# Service compatibility

Omnifin uses capability discovery rather than assuming a product name implies a
fixed API. This page records the target matrix and the evidence required before a
combination is described as supported.

> [!NOTE]
> There is no verified public compatibility baseline yet. Every entry below is a
> target for pre-release integration work, not a support claim.

| Service                           | Intended use                                                   | Current status                                       |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Jellyfin                          | Identity, libraries, playback, watch state, scans, metadata    | Target; verification pending                         |
| Authentik                         | OIDC sign-in, group claims, front/back-channel logout          | Isolated gate ready; live baseline pending           |
| Standards-compliant OIDC provider | Discovery, code flow with PKCE, claims, logout when advertised | Target; verification pending                         |
| Seerr                             | Discovery, requests, approvals, issues, user context           | Search/request fixtures ready; live baseline pending |
| Radarr                            | Movie monitoring, calendar, search, releases, queue, history   | Target; verification pending                         |
| Sonarr                            | Series monitoring, calendar, search, releases, queue, history  | Target; verification pending                         |
| Bazarr                            | Subtitle status, search, and download                          | Target; verification pending                         |
| Prowlarr                          | Indexer status, statistics, failures, sync, safe tests         | Target; verification pending                         |
| qBittorrent                       | Queue, rates, progress, pause/resume, safe removal             | Target; verification pending                         |
| SABnzbd                           | Queue, history, rates, progress, pause/resume, safe removal    | Target; verification pending                         |

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
