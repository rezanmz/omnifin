# Roadmap

Omnifin advances through verified vertical phases. A phase is complete only when its
functional, security, integration, visual, accessibility, performance, and
documentation gates are green. Dates are intentionally omitted; quality evidence,
not a calendar, controls release readiness.

## Status legend

- **In development:** implementation or verification is active.
- **Planned:** accepted scope without completion evidence.
- **Verified:** all listed phase gates have passed for a tagged release.

Phase 0 is verified for the first pre-release; all product phases remain in development
or planned.

## Phase 0 — Public project foundation

**Status: Verified**

- Public repository, AGPL-3.0-only licensing, governance, architecture, support, and
  security documentation
- pnpm TypeScript workspace, strict checks, test harnesses, migrations, structured
  redacted logging, health endpoints, Docker image, and Compose deployment
- Protected branch and release-tag policy, pinned CI actions, dependency automation,
  and a reviewed automatic-release path

**Gate:** a clean checkout can install, check, test, build, migrate, start, and report
health using documented commands; repository settings match the contribution model.

The machine-enforced contract and independent gate mapping are recorded in
[Public-project foundation verification](foundation-verification.md). Phase 0 does not
claim live-service compatibility; those profiles remain gated by later phases.

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

- Seerr and metadata discovery, global search, normalized movie and series details,
  best-effort rating/trailer/recommendation intelligence, person context, granular requests
  with opaque destination/profile/root/language routing, and operator approvals (implemented
  with deterministic contracts; protected live evidence pending)
- Radarr and Sonarr read-only calendar, exact whole-title monitoring, searches, and manual releases
  (implemented; protected live evidence pending), plus broader queue mutations
- Prowlarr Indexer Intelligence (implemented; protected live evidence pending)
- qBittorrent and SABnzbd live queues with exact-item pause/resume, verified front-of-queue
  promotion, and downloaded-file-preserving removal (implemented with deterministic contracts and
  isolated digest-pinned upstream gates; protected live evidence and broader queue mutations
  pending)
- Unified Radarr, Sonarr, and Prowlarr health plus path-free Radarr/Sonarr capacity telemetry
  (implemented with isolated real-service read gates; protected live evidence pending)
- Title-level Acquisition Provenance and exact-target automatic-search recovery
  plus manual release recovery (implemented; protected live evidence pending)

**Gate:** isolated safe-write tests, idempotency, live-update resilience,
rejection-reason fidelity, and degraded-service behavior pass for the supported
matrix.

## Phase 4 — Playback and library operations

**Status: In development**

- Jellyfin playback negotiation, direct play and HLS, range proxying, tracks,
  subtitles, bitrate control, progress, and Continue Watching (implemented;
  protected live evidence pending)
- Player issue reporting plus a unified local/Seerr resolve and reopen workbench
  (implemented; protected live evidence pending)
- Bazarr subtitle search and download (implemented with an isolated real-service empty-state gate;
  protected live mutation evidence pending)
- Jellyfin scans, unmatched-media handling, and metadata artwork editing (implemented;
  protected live evidence pending)

**Gate:** generated copyright-free fixtures verify seeking, reconnects, audio and
subtitle switching, progress accuracy, token isolation, transcoding, and supported
browser behavior.

## Phase 5 — Hardening and public release

**Status: Planned**

- Full compatibility matrix, threat-model-driven security review, load testing,
  container scans, backup and restore (implemented; protected release evidence pending),
  migration and rollback rehearsals
- Verified installation, operation, troubleshooting, and contribution documentation
- Multi-architecture images with SBOM, provenance, signatures, and attestations

**Gate:** all product requirements, OIDC flows, service matrix, security controls,
release evidence, and design-quality criteria pass.

Completed phase gates may receive `v0.x` releases. `v1.0.0` is reserved for the full
verified product, not merely a stable build pipeline.
