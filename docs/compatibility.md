# Service compatibility

Omnifin uses capability discovery rather than assuming a product name implies a
fixed API. This page records the target matrix and the evidence required before a
combination is described as supported.

> [!NOTE]
> There is no verified public compatibility baseline yet. Every entry below is a
> target for pre-release integration work, not a support claim.

| Service                           | Intended use                                                    | Current status                                                             |
| --------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Jellyfin                          | Identity, libraries, playback, watch state, scans, metadata     | Isolated 10.10.7–10.11.11 identity/catalogue/playback matrix; live pending |
| Authentik                         | OIDC sign-in, group claims, front/back-channel logout           | Isolated gate ready; live baseline pending                                 |
| Standards-compliant OIDC provider | Discovery, code flow with PKCE, claims, logout when advertised  | Isolated standards gate ready; live baseline pending                       |
| Seerr                             | Discovery, routed requests, approvals, issues, user context     | Contracts plus isolated request/review gate ready; live pending            |
| Radarr                            | Movie monitoring, calendar, search, releases, queue, history    | Isolated reads plus monitoring restore gate ready; live pending            |
| Sonarr                            | Series monitoring, calendar, search, releases, queue, history   | Isolated reads plus monitoring restore gate ready; live pending            |
| Bazarr                            | Subtitle status, search, and download                           | Isolated embedded search/download gate ready; live pending                 |
| Prowlarr                          | Indexer status, statistics, failures, sync, safe tests          | Isolated reads plus exact safe-test gate ready; live pending               |
| qBittorrent                       | Queue, rates, exact pause/resume, front promotion, safe removal | Isolated 5.2.0 gate ready; live baseline pending                           |
| SABnzbd                           | Queue, rates, exact pause/resume, front promotion, safe removal | Isolated 5.0.4 gate ready; live baseline pending                           |

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
All deterministic fixture suites are marked ready. OIDC is covered by protocol and gateway
contract fixtures plus a pinned Dex browser harness for discovery, PKCE S256, immutable identity,
JIT provisioning, explicit role mapping, and local logout fallback when optional provider logout is
not advertised. Authentik separately runs a pinned, isolated upstream authorization-code browser
harness with advertised RP-initiated and back-channel logout. Fixture readiness is development evidence and
does not establish a public live-support baseline.

The generic harness uses Dex 2.45.1 as a standards test oracle, not as a public product support
claim. Its closed report records only the provider version and fixed check names after deterministic
teardown. See the [standards-generic OIDC fixture runbook](operations/oidc-provider-fixture.md).

The Seerr fixture gate includes normalized request-destination discovery for Radarr and
Sonarr, standard/4K filtering, partial destination failures, delegated user context, and
explicit server/profile/root/language mutation fields. It also exercises bounded media
ratings, validated YouTube trailer references, recommendations, person biographies and
credits, and partial optional-intelligence failure. Gateway evidence separately proves that
raw paths and numeric routing identifiers are replaced with expiring, user-bound opaque
references before reaching the browser, and that provider URLs and raw upstream payloads do
not cross the gateway. A separate fresh Seerr 3.4.1 instance runs on an internal network with one
bounded HTTPS metadata fixture. The production adapter must resolve the exact delegated identity,
create one pending request, reject its duplicate, list it for review, decline it, and verify the
fresh declined state. The closed report is written only after all service, identity, metadata,
database, credential, certificate, and request state is removed. See the
[isolated Seerr request runbook](operations/seerr-service-fixture.md). Live routing and intelligence
compatibility remain pending.

The protected connector aggregate also creates one deterministic, copyright-free media fixture and
distributes it to fresh digest-pinned Jellyfin 10.10.7 and 10.11.11 instances on separate
GitHub-hosted runners. Omnifin's production identity connector must complete public discovery,
password authentication, invalid-password rejection, Quick Connect approval, mismatched-secret
rejection, polling, and authentication. Its production playback connector must then complete direct
range playback, a seeked HLS transcode, alternate audio and subtitle selection, progress
persistence, and playback renegotiation after a server restart. Its production user-media connector
must also search the imported fixture through the exact paired user's catalogue endpoint and return
one normalized playable movie. The sanitized evidence records the
exact Jellyfin image, version, and normalized checks without retaining service, account, Quick
Connect, token, media, path, or credential identifiers. The range is fixture-verified as of
2026-07-31; it remains a target rather than a public support claim until protected live evidence
passes.

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
normalized reads before the connector aggregate succeeds. Radarr and Sonarr restore one exact
monitoring change, Prowlarr tests one private provider, and Bazarr resolves a generated
copyright-free media target, selects its built-in embedded-subtitle result, downloads it, and
verifies the extracted SubRip artifact. Passing evidence is written only after deterministic
teardown and cannot contain credentials, URLs, ports, paths, identifiers, media names, logs, or
upstream payloads. See the [isolated service fixture runbook](operations/servarr-service-fixtures.md).
These remain isolated development checks; live support claims remain pending.

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
`v1` requires the complete fixture and live service matrix.

The weekly and manually dispatched compatibility canary is separate from that protected live
installation baseline. It uses no repository or environment secrets. At the start of each run it
selects the newest product-specific stable version tag from each allowlisted repository, resolves
that exact tag to an immutable digest, then
starts fresh Jellyfin, Seerr, Servarr, download-client, Authentik, and generic OIDC fixtures on
GitHub-hosted runners. The production adapters perform the established identity, playback,
request, acquisition, subtitle, indexer, and queue checks. Each job fails if its container,
network, or volume set is not restored after teardown. The retained aggregate contains only the
commit, verification time, exact image references, observed versions, normalized checks, statuses,
and bounded error categories. A main-branch regression opens or updates one labelled issue; a later
green run closes it. Canary results remain disposable-fixture evidence rather than a public
installation support claim until the separately protected live evidence records exact versions and
dates.

## Reporting a compatibility problem

Use the compatibility issue form and include Omnifin version or image digest,
upstream product and exact version, the capability that failed, sanitized gateway
diagnostics, and reproduction steps. Never include API keys, cookies, user tokens,
OIDC assertions, private hostnames, or media paths.
