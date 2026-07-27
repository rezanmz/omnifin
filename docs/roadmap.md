# Roadmap

Omnifin advances through verified vertical phases. A phase is complete only when its
functional, security, integration, visual, accessibility, performance, and
documentation gates are green. Dates are intentionally omitted; quality evidence,
not a calendar, controls release readiness.

## Status legend

- **In development:** implementation or verification is active.
- **Planned:** accepted scope without completion evidence.
- **Verified:** all listed phase gates have passed for a tagged release.

No phase is currently marked verified. The repository is pre-release.

## Phase 0 — Public project foundation

**Status: In development**

- Public repository, AGPL-3.0-only licensing, governance, architecture, support, and
  security documentation
- pnpm TypeScript workspace, strict checks, test harnesses, migrations, structured
  redacted logging, health endpoints, Docker image, and Compose deployment
- Protected branch and release-tag policy, pinned CI actions, dependency automation,
  and a reviewed automatic-release path

**Gate:** a clean checkout can install, check, test, build, migrate, start, and report
health using documented commands; repository settings match the contribution model.

## Phase 1 — Identity and secure control plane

**Status: In development**

- Multiple-provider OIDC discovery and code flow with PKCE, including Authentik
- Jellyfin credentials and Quick Connect
- Explicit OIDC-to-Jellyfin account pairing and lifecycle controls
- Local roles and permissions, recovery access, opaque session rotation, logout, and
  audit records
- Encrypted connector configuration, capability negotiation, and partial-failure
  contracts

**Gate:** OIDC threat model, live Authentik integration, account-link takeover tests,
CSRF/session tests, recovery rehearsal, and secret-leak inspection all pass.

## Phase 2 — Design system and dashboard

**Status: In development**

- Cinematic token system, editorial typography, artwork-derived palettes, and
  production interface primitives
- Application shell, dashboard, exact skeletons, authentication and account-linking
  screens, and responsive navigation
- Storybook state coverage and interaction tests before route assembly

**Gate:** visual regression, WCAG 2.2 AA checks, keyboard and directional navigation,
reduced motion, Lighthouse and 250 KiB compressed JavaScript budgets, and manual inspection across
desktop, tablet, mobile, and 10-foot layouts pass.

## Phase 3 — Discovery, requests, and acquisition

**Status: In development**

- Seerr and metadata discovery, global search, granular requests, and approvals
- Radarr and Sonarr calendar, queue, monitoring, searches, and manual releases
- Prowlarr Indexer Intelligence (implemented; protected live evidence pending)
- qBittorrent and SABnzbd live queues
- Title-level Acquisition Provenance and exact-target automatic-search recovery
  (implemented); manual release recovery remains in development

**Gate:** isolated safe-write tests, idempotency, live-update resilience,
rejection-reason fidelity, and degraded-service behavior pass for the supported
matrix.

## Phase 4 — Playback and library operations

**Status: Planned**

- Jellyfin playback negotiation, direct play and HLS, range proxying, tracks,
  subtitles, bitrate control, progress, and Continue Watching
- Player issue reporting
- Bazarr subtitle search and download
- Jellyfin scans, unmatched-media handling, and metadata artwork editing

**Gate:** generated copyright-free fixtures verify seeking, reconnects, audio and
subtitle switching, progress accuracy, token isolation, transcoding, and supported
browser behavior.

## Phase 5 — Hardening and public release

**Status: Planned**

- Full compatibility matrix, threat-model-driven security review, load testing,
  container scans, backup and restore, migration and rollback rehearsals
- Verified installation, operation, troubleshooting, and contribution documentation
- Multi-architecture images with SBOM, provenance, signatures, and attestations

**Gate:** all product requirements, OIDC flows, service matrix, security controls,
release evidence, and design-quality criteria pass.

Completed phase gates may receive `v0.x` releases. `v1.0.0` is reserved for the full
verified product, not merely a stable build pipeline.
