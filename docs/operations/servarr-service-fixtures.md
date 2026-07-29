# Isolated Radarr, Sonarr, Prowlarr, and Bazarr fixtures

The protected connector workflow starts a fresh Radarr, Sonarr, Prowlarr, or Bazarr instance for
every pull request. Each LinuxServer image is pinned by a release tag and immutable
multi-architecture index digest. The service receives no repository or environment secrets, runs
as the runner's unprivileged UID and GID with `no-new-privileges`, and has bounded CPU, memory, and
process resources.

The Linux gate attaches each instance to its own internal Docker network without published ports.
That network has no default route to unrelated containers or the public internet. Docker Desktop
cannot route its host directly to a Linux bridge, so the local macOS path uses the connector's
explicit test transport seam to execute a bounded HTTP request from inside the service container.
The service is never bound to the host or a LAN interface. Hosted Linux evidence continues to
exercise Omnifin's production DNS-pinned transport directly against the private container address.
The macOS transport supplies transient request headers over standard input, so the generated API
key is not placed in subprocess arguments.

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
system-health, empty-calendar, and storage reads. Prowlarr exercises normalized system health,
indexer intelligence, application sync, and failure history against fresh empty state. Bazarr
exercises its normalized library lookup and requires the typed empty-library result.

Successful teardown is part of the gate. The container, internal network, generated database,
configuration, API key, and transient logs are removed before passing evidence is written. If
cleanup fails, the fixture fails rather than publishing a passing report.

The uploaded report has a closed schema containing only the service name, exact normalized
version, immutable image reference, fixed check names, and pass status. API keys, URLs, ports,
container names, paths, native identifiers, upstream payloads, and logs cannot be represented.
Failure evidence is limited to a normalized stage code.

These checks are real-service, read-only development evidence. They do not establish a public
installation compatibility baseline or prove media mutations, indexer tests, subtitle downloads,
timeouts, or recovery against an operator's deployment. Those claims remain gated by the
protected live matrix and its exact-version evidence.
