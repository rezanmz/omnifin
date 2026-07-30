# Isolated Radarr, Sonarr, Prowlarr, and Bazarr fixtures

The protected connector workflow starts a fresh Radarr, Sonarr, Prowlarr, or Bazarr instance for
every pull request. Each LinuxServer image is pinned by a release tag and immutable
multi-architecture index digest. The service receives no repository or environment secrets, runs
as the runner's unprivileged UID and GID with `no-new-privileges`, and has bounded CPU, memory, and
process resources.

Before creating the private network, the runner acquires the exact digest in a separate bounded
step. Only explicit transient registry or network categories can retry, at most twice after the
initial attempt with fixed 5-second and 15-second delays. Authentication, authorization, missing
manifest, unsupported-platform, unknown daemon, and policy failures stop immediately. Container
startup then uses Docker's local-only image policy, so it cannot perform an implicit pull. Raw
registry and Docker diagnostics remain captured and private; public failure evidence contains only
`image_pull_failed`, `image_pull_transient_exhausted`, or the existing bounded startup code.
Adapter, authentication, assertion, and teardown failures are never retried.

The Linux gate attaches each instance to its own internal Docker network without published ports.
That network has no default route to unrelated containers or the public internet. Docker Desktop
cannot route its host directly to a Linux bridge, so the local macOS path uses the connector's
explicit test transport seam to execute a bounded HTTP request from inside the service container.
The service is never bound to the host or a LAN interface. Hosted Linux evidence continues to
exercise Omnifin's production DNS-pinned transport directly against the private container address.
The macOS transport supplies transient request headers over standard input, so the generated API
key is not placed in subprocess arguments.

Radarr, Sonarr, and Prowlarr also receive a pinned, unprivileged Node fixture sidecar on that same
internal network. The sidecar is read-only, resource-bounded, has no published port, and cannot
route to the public internet. A short-lived fixture CA is generated inside the temporary directory;
only its certificate is mounted into Radarr or Sonarr. Docker network aliases direct the exact
`api.radarr.video`, `skyhook.sonarr.tv`, `services.sonarr.tv`, and `thexem.info` names to the private
HTTPS fixture. The latter two return exact empty scene-mapping responses required by Sonarr's
first-series event path, so title provisioning does not depend on TMDB, TVDB, SkyHook, XEM, or any
other public service. Prowlarr receives a private Newznab capability endpoint on the same sidecar.
The CA private key, leaf key, fixture databases, and all native identifiers are destroyed during
teardown.

Run a fixture after building the production adapters:

```sh
pnpm --filter @omnifin/connectors... build
pnpm fixture:servarr-service --service radarr --output artifacts/integration/servarr-services/radarr/report.json
pnpm fixture:servarr-service --service sonarr --output artifacts/integration/servarr-services/sonarr/report.json
pnpm fixture:servarr-service --service prowlarr --output artifacts/integration/servarr-services/prowlarr/report.json
pnpm fixture:servarr-service --service bazarr --output artifacts/integration/servarr-services/bazarr/report.json
```

The runner waits for the private first-run configuration, reads the generated API key without
printing it, and calls the production adapter. Every service must pass exact version discovery,
successful authentication, and invalid-key rejection. Radarr and Sonarr also exercise normalized
system-health, empty-calendar, and storage reads. Each then provisions one bounded synthetic title
with search disabled and verifies monitoring through the production adapter: initial read, one
state change, a fresh read, restoration, and a final read of the original state. No search, grab,
import, file, quality-profile, tag, path, delete, or media mutation is permitted. Prowlarr exercises
normalized system health, indexer intelligence, application sync, and failure history against fresh
empty state, provisions one private Newznab provider with RSS and automatic search disabled, and
runs the production adapter's exact-provider safe test. Bazarr first requires the typed
empty-library result. Its existing pinned service container then generates a two-second
copyright-free MKV with one English SubRip stream inside the mounted fixture directory. The gate
enables only Bazarr's built-in `embeddedsubtitles` provider, seeds one bounded local media/profile
record through a fixed stdin-only program, restarts the same container, and uses Omnifin's
production adapter to resolve the exact title, search, select, and download that embedded stream.
The gate passes only when exactly one bounded external SubRip artifact contains the deterministic
fixture marker. The media, seed program, database, configuration, and resulting subtitle never
leave the transient directory or enter an artifact.

Successful teardown is part of the gate. The service and sidecar containers, internal network,
generated database, configuration, API key, short-lived certificates and keys, and transient logs
are removed before passing evidence is written. If cleanup fails, the fixture fails rather than
publishing a passing report.

The uploaded report has a closed schema containing only the service name, exact normalized
version, immutable image reference, fixed check names, and pass status. API keys, URLs, ports,
container names, paths, native identifiers, upstream payloads, and logs cannot be represented.
Failure evidence is limited to a normalized stage code.

These checks are real-service development evidence for bounded monitoring changes, a provider safe
test, and one offline embedded-subtitle search/download path. They do not establish a public
installation compatibility baseline or prove public subtitle-provider compatibility, acquisition
searches, grabs, imports, general file changes, timeouts, or recovery against an operator's
deployment. Those claims remain gated by the protected live matrix and its exact-version evidence.
