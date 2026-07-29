# Development guide

This guide takes a contributor from a clean checkout to a reviewable change. Omnifin
is pre-release, so check the repository's declared tool versions before relying on a
globally installed runtime.

## Prerequisites

- Node.js matching the package `engines` declaration
- pnpm matching the `packageManager` declaration
- Docker with the Compose plugin for container and integration checks
- Git configured to create cryptographically signed commits

## Start locally

```sh
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

Place the generated value in `OMNIFIN_ENCRYPTION_KEY` before starting. The example
configuration is for local development. Use isolated test accounts and service
instances. Never point mutation tests at a personal media library or reuse production
credentials. Root environment files are not loaded automatically by the separate
application processes, so export the file into the current shell before starting:

```sh
set -a
. ./.env
set +a
pnpm dev
```

The current workspace starts the application shells, health and readiness endpoints,
safe provider metadata, OIDC browser routes, RP-initiated logout, provider-initiated
back- and front-channel logout, individual and account-wide local session
revocation, recovery access,
migrations, direct Jellyfin sign-in, password and Quick Connect pairing for pending OIDC users,
the permission-checked OIDC provider and role-mapping control room, and connector fixture/probe
tooling. Account and provider administration are available as pre-release development surfaces.
The versioned gateway API can administer encrypted connector records, validate capabilities, and
guard enablement and deletion. It exposes normalized Seerr search and media details for principals with
`media.view`, identity-delegated, idempotent Seerr request creation for principals with
`request.create`, and read-only Radarr/Sonarr title provenance for principals with
`acquisition.manage`. It also exposes permission-gated, read-only qBittorrent and SABnzbd queue
telemetry for principals with `downloads.manage` and a bounded Radarr/Sonarr acquisition calendar
for principals with `media.view`. Recovery access can inspect and repair Jellyfin connector records
without seeing or mutating other service configuration. A pinned isolated Authentik gate exercises
authorization, role mapping, RP logout, and back-channel logout. The browser connector control room
and global discovery, request, acquisition-provenance, manual release, Indexer Intelligence,
system-health, download-queue, and acquisition-calendar flows are pre-release development
surfaces. The same is
true of Jellyfin playback and progress, Continue Watching, issue reporting, Bazarr subtitle search
and download, and guarded Jellyfin library maintenance. The protected live compatibility baseline,
monitoring controls and broader acquisition mutations remain unavailable.

The web application and gateway are separate processes. Browser traffic must still
follow the intended same-origin route through the web application; bypassing the
gateway hides security and integration defects.

## Required checks

Run the relevant focused test while iterating, then run the complete local gate before
requesting review:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
pnpm migration:smoke
pnpm --filter @omnifin/gateway db:check
pnpm --filter @omnifin/gateway db:generate
pnpm security:audit
pnpm license:check
node --test scripts/ci/*.test.mjs scripts/integration/*.test.mjs
actionlint .github/workflows/*.yml
node scripts/ci/check-workflow-pins.mjs --remote
docker compose config --quiet
pnpm container:smoke --build
```

`db:generate` must leave the tracked schema and migration files unchanged. Review
`git status --short` immediately afterward; generated drift is a failing gate, not an
artifact to accept without a matching, reviewed schema change. `actionlint` is also
run in CI and can be installed from its checksum-verified release or package-manager
formula.

The remote pin check performs unauthenticated public `git ls-remote` lookups and
verifies each pinned action SHA against the version tag documented beside it. It does
not read GitHub credentials. Run it whenever a workflow action is added or updated.

Security CI pins Trivy `v0.70.0`. Its SARIF pass reports every severity and retains
unfixed findings, while separate table-format passes block fixable high or critical
vulnerabilities and high or critical secret or infrastructure findings. Do not make a
local or hosted check pass by adding broad skip paths, ignored statuses, or unbounded
finding exclusions; follow the exception requirements in the
[security model](security-model.md) when a scanner result is demonstrably inapplicable.

User-interface changes also require Storybook and browser evidence:

```sh
pnpm --filter @omnifin/web build:storybook
pnpm test:storybook
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
pnpm lighthouse
```

Use `pnpm --filter @omnifin/web storybook` separately for interactive visual review;
it starts a long-running local development server rather than a finite quality check.

Container, compatibility, and Lighthouse checks may require Docker or the dedicated
CI environment. A pull request must not waive a failing check merely because it passes
on one workstation.

Connector fixture work must keep `scripts/integration/readiness.json` truthful. A
strict fixture check succeeds only for a profile reviewed as `ready`. The deterministic
OIDC and isolated Authentik profiles are enforced; live identity profiles remain
pending and fail closed:

```sh
pnpm test:integration --service jellyfin --mode fixture --strict
pnpm test:integration --service oidc --mode fixture --strict
pnpm test:integration --service authentik --mode fixture --strict
```

Do not copy live credentials into a pull-request workflow or local fixture. Scheduled,
manual, and canary checks use the protected GitHub `integration` environment after the
repository opt-in is enabled. A release uses that environment whenever its reviewed
coverage profile requires live evidence, independent of the scheduling opt-in.

Phase release claims are separate from global readiness. Advance
`scripts/integration/release-coverage.json` only in the phase-gate pull request, keep
profiles cumulative, and advance each selected readiness entry in the same reviewed
change. The policy permits truthful `v0.x` phase releases while mechanically requiring
the complete fixture and live matrix for `v1.0.0` and later.

## Change structure

Prefer a vertical slice that delivers one observable workflow through contracts,
authorization, connector behavior, interface states, and tests. Avoid implementing a
large data layer with no usable path or an interface backed only by unrealistic mock
data.

Shared browser/gateway contracts use runtime validation. Raw upstream shapes remain
inside connectors. Connector fixtures must include success, missing capability,
invalid credentials, permission denied, timeout, malformed data, and recovery where
the service can produce those states.

For an interface slice, complete the three passes in the
[design quality bar](design-quality.md). Include deterministic stories for every
meaningful state and update visual baselines only after inspecting the rendered
difference.

## Commit and pull-request conventions

Commit messages and squash-merge titles follow Conventional Commits, for example:

```text
feat(auth): add account-link revocation
fix(prowlarr): preserve disabled-until timestamp
docs(deploy): clarify master-key backup
```

Keep refactors separate from behavior changes when practical. Sign commits with a
verified GPG, SSH, or S/MIME signature. Pull requests should explain user impact,
security and migration consequences, evidence, and rollback.

Use neutral, purpose-based branch names under `feature/`, `fix/`, `phase/`, or
`release/`. Branch names, commits, pull requests, documentation, releases, and package
metadata must describe the project change itself and must not include editor,
automation, or implementation-tool attribution.

## Data and migrations

Schema changes require a forward migration, migration smoke test from the last
released schema, fresh-install test, backup/restore consideration, and an explicit
rollback note. Never edit an already released migration. Test data must not contain
real tokens, hostnames, users, viewing history, or media paths.

## Security expectations

Read the [security model](security-model.md) before changing authentication, sessions,
roles, connector egress, media proxying, secrets, audit records, or release workflows.
Treat every upstream payload and browser field as untrusted. Do not log values simply
because a local fixture is harmless.

Report discovered vulnerabilities privately according to
[SECURITY.md](../SECURITY.md), including when the issue was found while working on an
unrelated change.

## Documentation

A change is not complete until a fresh reader can use or operate it. Update the
architecture when a boundary moves, authentication when an identity invariant
changes, compatibility when verification evidence changes, and the changelog through
the release process. Avoid documenting a capability as supported before its live
matrix gate passes.
