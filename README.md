# Omnifin

**A cinematic control plane for a self-hosted media stack.**

Omnifin is an open-source web application for discovering, requesting, acquiring,
playing, and maintaining media without moving between a collection of unrelated
administration tools. It is designed around Jellyfin and the surrounding media
automation ecosystem, with the operational depth of a control room and the calm,
focused experience of a premium streaming product.

> [!IMPORTANT]
> Omnifin is pre-release software under active development. There is no stable
> production release yet, and configuration, storage, and API contracts may change.
> Follow the [roadmap](docs/roadmap.md) for verified milestone status.

## Why Omnifin?

A capable home media stack often spans Jellyfin, Seerr, Radarr, Sonarr, Bazarr,
Prowlarr, and one or more download clients. Each service has its own interface,
credentials, permissions, failure states, and mental model. Omnifin is intended to
provide one deliberate experience across that system while preserving the useful
depth of each service.

The product is guided by three equal release requirements:

- **Complete workflows:** discovery, requests, acquisition, playback, and library
  operations should work end to end.
- **Defence in depth:** upstream administrator credentials stay on the server,
  every mutation is authorized locally, and sensitive actions are auditable.
- **Exceptional experience:** loading, empty, degraded, denied, error, and responsive
  states receive the same care as the happy path.

## Intended capabilities

The current roadmap covers:

- OIDC sign-in for providers such as Authentik, plus Jellyfin credentials and Quick
  Connect.
- Explicit, proof-of-control pairing between an OIDC identity and a Jellyfin user.
- Local `viewer`, `requester`, `operator`, and `admin` authorization independent of
  broad upstream API-key permissions.
- Unified discovery, search, requests, approvals, calendars, queues, and manual
  release selection.
- Jellyfin playback, watch progress, subtitle management, and library operations.
- Prowlarr indexer intelligence and title-level acquisition provenance.
- Capability-aware integration with Jellyfin, Seerr, Radarr, Sonarr, Bazarr,
  Prowlarr, qBittorrent, and SABnzbd.

These are target capabilities, not a claim that every workflow is available today.
See the [compatibility matrix](docs/compatibility.md) for validation status.

## Architecture at a glance

Omnifin is a TypeScript monorepo with a Next.js application, a Fastify gateway,
and shared contract and connector packages. The first interface primitives remain
app-local until the design-system API stabilizes during Phase 2. The current
development checkpoint provides storage-backed health checks, browser-safe provider
discovery, an OIDC Authorization Code flow with PKCE, opaque local sessions,
break-glass recovery, direct Jellyfin password and Quick Connect authentication with
encrypted identity links, CSRF-protected password and Quick Connect pairing for pending OIDC users,
RP-initiated provider logout and provider-initiated back- and front-channel logout,
normalized contracts, connector probes, migration tooling, and the application shell
and sign-in experience. The gateway also provides a permission-checked connector
administration API with encrypted credentials, guarded transport policy, capability
snapshots, optimistic revisions, and audited lifecycle changes.
Phase 3 adds permission-checked Seerr discovery, requests, acquisition recovery,
Prowlarr intelligence, a read-only Radarr/Sonarr release calendar, and qBittorrent/SABnzbd queue
reads through normalized, browser-safe contracts and responsive operational workspaces.
The interface supports light, dark, and live system appearance preferences through an
adaptive liquid-material hierarchy that keeps navigation and floating controls
translucent while preserving solid, readable content surfaces.

All upstream access crosses the gateway boundary. The current Phase 1 implementation runs a
pinned, isolated Authentik authorization, role-mapping, RP-logout, and back-channel logout gate;
the public compatibility baseline remains pending until protected live evidence records exact
versions and dates. Permission checks cover every implemented administrative and self-service
surface, including a deliberately Jellyfin-only recovery path. The browser connector control room,
identity-delegated media requests, Radarr/Sonarr acquisition provenance, exact-target automatic
and manual release recovery, Prowlarr Indexer Intelligence, and a read-only multi-client download
queue and acquisition calendar are available as pre-release development surfaces. Phase 4 also
provides Jellyfin playback negotiation and protected media proxying, progress reporting and
Continue Watching, player issue reports, Bazarr subtitle operations, and guarded Jellyfin library
maintenance. Request review, monitoring controls, broader acquisition mutations, and live events
remain later pre-release work.
Reusable upstream credentials, token responses, identity assertions, and raw upstream
API payloads stay behind the gateway boundary. During OIDC sign-in, the browser does
carry the provider's transient, one-time `code`, `state`, or error parameters to the
callback; PKCE, one-shot transaction consumption, `no-store` responses, and the
restrictive referrer policy limit that exposure. Reverse proxies must not persist
authentication callback query strings in access logs.

The default deployment is a single-node Docker Compose installation backed by
SQLite. One immutable image contains both process entry points, allowing the web and
gateway services to be upgraded together without introducing an external database.

Read the [architecture overview](docs/architecture.md) for trust boundaries and
design decisions.

## Development preview

Prerequisites are Node.js, pnpm, and Docker with Compose. Until the first supported
container release is published, run Omnifin from source:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

Place the generated value in `OMNIFIN_ENCRYPTION_KEY` before starting. The example
environment file documents local-only defaults; do not reuse its settings for an
internet-accessible installation. The application processes do not load the root
environment file automatically, so export it into the development shell before
starting:

```sh
set -a
. ./.env
set +a
pnpm dev
```

See the [development guide](docs/development.md) for checks and repository conventions,
or the [deployment guide](docs/deployment.md) for the intended production model.

## Documentation

- [Architecture](docs/architecture.md) — components, trust boundaries, data, and
  failure handling
- [Authentication](docs/authentication.md) — OIDC, Jellyfin pairing, roles, sessions,
  and recovery
- [Discovery](docs/discovery.md) — normalized Seerr search, permissions, errors, and
  browser behavior
- [Media requests](docs/media-requests.md) — delegated Seerr identity, idempotency,
  normalized mutations, and audits
- [Acquisition provenance](docs/acquisition-provenance.md) — normalized Radarr and
  Sonarr title history, partial failure, and operator access
- [Indexer Intelligence](docs/indexer-intelligence.md) — normalized Prowlarr
  telemetry, application sync, failures, and safe tests
- [Download queues](docs/download-queues.md) — normalized qBittorrent and SABnzbd
  telemetry, partial failure, polling, and secret isolation
- [Acquisition calendar](docs/acquisition-calendar.md) — normalized Radarr and Sonarr
  release timing, pagination, partial failure, and privacy boundaries
- [Design quality](docs/design-quality.md) — the visual, interaction, accessibility,
  and performance bar
- [Compatibility](docs/compatibility.md) — service targets and verification policy
- [Deployment](docs/deployment.md) — secrets, TLS, backups, upgrades, and rollback
- [Development](docs/development.md) — local setup, checks, and contribution workflow
- [Roadmap](docs/roadmap.md) — phased delivery and release gates
- [Release process](docs/release-process.md) — versions, images, provenance, and
  verification
- [Security model](docs/security-model.md) — assets, threats, and security invariants

## Community and support

Use [GitHub Discussions](https://github.com/rezanmz/omnifin/discussions) for questions,
ideas, and setup conversations. Use
[GitHub Issues](https://github.com/rezanmz/omnifin/issues) for reproducible defects and
scoped feature proposals. Please read [SUPPORT.md](SUPPORT.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a report or pull request.

Security vulnerabilities must be reported privately according to
[SECURITY.md](SECURITY.md), never in a public issue.

## License

Omnifin is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). If you run a
modified version for users over a network, the license requires you to offer those
users the corresponding source code for that version.

Omnifin is an independent project. Product names and trademarks belong to their
respective owners; integration does not imply endorsement.
