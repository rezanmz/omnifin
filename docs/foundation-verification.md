# Public-project foundation verification

Phase 0 establishes the releaseable project boundary. It does not claim that every
media service or live deployment profile is supported. The foundation gate proves
that the repository, build, deployment, and release controls needed for incremental
public releases are present and continuously enforced.

## Machine-enforced contract

`pnpm foundation:check` validates the following reviewed invariants:

- public governance, security, support, contribution, architecture, deployment, and
  release documents are present as ordinary repository files;
- the pnpm workspace remains private, strict TypeScript is enabled, and the root
  verification commands required by CI remain wired;
- the single Docker image supplies hardened web, gateway, and maintenance roles;
  the gateway is not published, the default web socket is loopback-only, both live
  roles have health checks, and encryption and recovery credentials use explicit
  Compose secret inputs;
- committed SQLite migrations exist;
- the initial Release Please configuration remains reviewed, draft-first, and
  pre-1.0; and
- the selected `phase0` release profile requires ready deterministic fixtures while
  making no live-service compatibility claim.

The CI `Quality` job runs this contract on pull requests, merge queues, and protected
`main` pushes. Its companion policy tests prove that missing governance, unsafe
gateway publication, inflated compatibility claims, or disconnected CI wiring fail
closed.

## Runtime evidence

The remaining Phase 0 evidence is produced by independent required jobs rather than
duplicated inside the static contract:

| Requirement                                                                                                          | Required evidence                |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Formatting, lint, types, unit tests, and documentation links                                                         | `CI / Quality`                   |
| Normalized connector contracts                                                                                       | `CI / Contract tests`            |
| SQLite migration history and clean apply                                                                             | `CI / Migration smoke`           |
| Production build                                                                                                     | `CI / Production build`          |
| Immutable image startup, health, migrations, and representative API read                                             | `CI / Container build and smoke` |
| Source, dependency, license, secret, IaC, image, and SBOM policy                                                     | `Security`                       |
| Deterministic service fixtures                                                                                       | `Connector integration`          |
| Protected-main multi-architecture image, signature, provenance, scan, anonymous digest smoke, and alias verification | `Edge image`                     |

Repository rules require the stable `CI`, `Security`, and `Connector integration`
checks before merge. The protected `release` environment contains the release
automation credential, and publishing jobs fail closed until exact-main gates and the
selected release-coverage profile pass.

## Scope boundary

Phase 0 is sufficient for a truthful `v0.x` foundation release. OIDC, Authentik,
Jellyfin, and the broader media stack already have deterministic development
coverage, but their public live-support baselines remain pending. Later phase gates
must record the exact upstream versions, verification dates, safe mutations, and
degraded behavior before the compatibility page describes those combinations as
supported. `v1.0.0` remains structurally blocked until the complete `v1` fixture and
live profiles are ready.
