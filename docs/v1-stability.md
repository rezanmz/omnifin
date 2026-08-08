# v1 stability gate

This document is the authoritative scope and evidence gate for the first stable
Omnifin v1 release. The goal is confidence for a home-lab operator: a supported
installation can be installed, operated, upgraded, repaired, and recovered without
guessing about data or upstream side effects. Stable v1 does not require every item in
the product roadmap.

All `v0.x` releases are pre-v1 previews and are not supported as stable releases. V1
support remains pending until one exact candidate satisfies every applicable item in
this document.

## Incremental delivery policy

V1 work is published incrementally rather than remaining on an unpublished integration
branch:

1. each completed phase receives its own reviewed pull request from a pushed branch;
2. the pull request merges only after its phase gate and required GitHub checks pass;
3. merged checkpoints may be published as GitHub prereleases using the
   `v1.0.0-alpha.N`, `v1.0.0-beta.N`, and `v1.0.0-rc.N` progression; and
4. only the exact release candidate that satisfies the complete checklist below may be
   promoted to stable `v1.0.0`.

Prerelease publication provides visible, installable progress. It is not a stable-v1
support claim, does not waive an incomplete evidence tier, and must identify the exact
source SHA and image digest it publishes.

## Version and upgrade boundary

The direct-upgrade floor is `v0.12.0`. The exact v1 candidate must prove a data-safe
direct upgrade from a real `v0.12.0` database. Installations older than `v0.12.0` are
outside the direct-upgrade promise; this gate makes no claim that they can upgrade
directly to v1.

## Stable scope

| Area                            | Required v1 outcome                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Released correctness            | Every behavior exposed and claimed by the candidate works across its normal, denied, degraded, and failure paths. There is no known released correctness regression. This includes [#337](https://github.com/rezanmz/omnifin/issues/337) and the availability correctness tracked in [#330](https://github.com/rezanmz/omnifin/issues/330). |
| Connector identity              | A configured upstream has a durable identity boundary. Changing its endpoint cannot send old tokens or opaque references to the replacement, and dependent links, grants, sessions, and references are invalidated before re-enablement.                                                                                                    |
| Mutation and restore safety     | Each external mutation defines its observable states and safe retry behavior. Read-after-write reconciliation is used where possible; otherwise uncertainty remains visible and is not blindly redispatched. Backup, restore, and rollback fail closed and preserve a recoverable prior state.                                              |
| Data-safe migration             | Startup checks key and schema compatibility before writes, creates a verified pre-migration recovery point, applies versioned migrations, and completes semantic checks before readiness. Empty-volume restore, interruption, disk-full behavior, and newer-schema refusal are proven.                                                      |
| Administrator recovery          | A home-lab operator can replace an inaccessible sole administrator through a narrow ceremony with fresh upstream proof, explicit confirmation, session revocation, and an audit record. Recovery does not become general user administration.                                                                                               |
| Offline key rotation            | A backup-first, offline procedure rotates versioned encryption and pseudonym key domains across every protected value, with interruption recovery and rollback evidence. Online or zero-downtime rekeying is not required for v1.                                                                                                           |
| Bounded runtime, SSE, and media | Shutdown, request cancellation, connector work, SSE replay/backpressure/reconnect behavior, media ranges, transfer concurrency, duration, memory, file descriptors, and WAL growth have enforced limits and fault evidence. A draining runtime stops accepting readiness before its bounded shutdown deadline.                              |
| Operator lifecycle              | Copyable instructions cover fresh install, first administrator, TLS proxying, connector prerequisites, diagnosis, backup and off-host retention, empty-host restore, upgrade, rollback, key and recovery-secret rotation, and troubleshooting. Resource and local-filesystem requirements are explicit.                                     |
| Exact-candidate evidence        | The same source SHA and image digest proposed for promotion pass the advertised architecture, compatibility, browser, migration, recovery, security, supply-chain, and operator gates. A rebuild or moving tag cannot substitute for the candidate.                                                                                         |

A partial implementation is not a v1 support claim. A nonessential surface that cannot
meet this gate must be inaccessible and documented as deferred.

## Conditional scope

- [#309](https://github.com/rezanmz/omnifin/issues/309) is required only as needed to
  preserve the availability invariant: released paths must not present unverified or
  contradictory availability as confirmed availability. Broader availability expansion
  is not independently required for v1.
- [#249](https://github.com/rezanmz/omnifin/issues/249) enters v1 scope only if its
  complete interface, partial-failure repair, and real-stack fault matrix are finished.
  Otherwise the guarded library-removal surface remains disabled and deferred rather
  than shipping as a partial stable promise.

## Explicitly post-v1

The following do not block stable v1:

- [#256](https://github.com/rezanmz/omnifin/issues/256),
  [#257](https://github.com/rezanmz/omnifin/issues/257),
  [#258](https://github.com/rezanmz/omnifin/issues/258), the unwired remainder of
  [#260](https://github.com/rezanmz/omnifin/issues/260), and expansion tracked by
  [#329](https://github.com/rezanmz/omnifin/issues/329),
  [#333](https://github.com/rezanmz/omnifin/issues/333), and
  [#335](https://github.com/rezanmz/omnifin/issues/335);
- high availability and multi-node operation;
- cloud backup exporters;
- Prometheus metrics and distributed tracing; and
- zero-downtime key rotation.

Deferral is not a claim that these items are unimportant. It keeps the first stable
release focused on the safety of the single-node home-lab deployment already described
by the repository.

## Evidence tiers

Evidence is cumulative. A higher tier does not replace a lower one.

| Tier                                       | Required evidence                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contract fixtures                       | Deterministic contracts exercise parsing, normalization, authorization, malformed responses, limits, timeouts, cancellation, and operation-specific success and failure behavior without claiming real-service compatibility.                                              |
| 2. Digest-pinned disposable real upstreams | Fresh real upstream services run from immutable image digests. Production adapters prove exact version and capability discovery, authentication, representative reads, safe mutations, failure behavior, recovery, and deterministic teardown.                             |
| 3. Exact-candidate verticals               | Browser, gateway, maintenance, database, and upstream paths run end to end against the exact candidate digest. The verticals cover identity, connector use, representative media and SSE, mutations, backup/restore, migration, and supported architectures as applicable. |
| 4. Real home-lab rehearsal                 | At least one representative home-lab host runs the exact candidate through a maintained TLS reverse proxy. The rehearsal covers the documented install and operator path, real network behavior, SSE/media proxying, recovery evidence, and sanitized diagnostics.         |

The compatibility matrix must identify the oldest supported and latest verified
upstream versions, capabilities checked, architecture, candidate digest, and verification
date. Tier 4 is one release-wide deployment rehearsal, not a substitute for the
disposable upstream matrix.

## Evidence ownership and expiry

The release evidence index must record, for every required result:

- an accountable owner;
- the tier, covered claim, source SHA, candidate digest, architecture, and exact upstream
  versions or fixture revision;
- the verification and expiry dates;
- the normalized result and a durable artifact link with its checksum; and
- any sanitization or environment limitation relevant to interpreting the result.

The owner is responsible for rerunning evidence before it expires and for narrowing or
removing a claim when it cannot be renewed. Missing, failed, expired, wrong-SHA, or
wrong-digest evidence is a release failure. Evidence produced only for a moving tag or
retained only in an expiring job log is insufficient. Expiry cannot be open-ended:
evidence expires at the declared date or earlier when its source, harness, candidate
digest, covered upstream version, or relevant deployment assumption changes.

## Security exceptions

No high or critical security finding may remain untriaged. When a fix is unavailable,
a release exception is valid only when it is reviewed, limited to the exact candidate,
and contains all of these fields:

| Field        | Required content                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| Finding      | Stable identifier, affected component and version, severity, and source report.                              |
| Reachability | Evidence showing whether and how the candidate can reach the vulnerable path under the supported deployment. |
| Controls     | Existing mitigations, operator constraints, detection, and the condition that ends the exception.            |
| Owner        | One accountable maintainer.                                                                                  |
| Review date  | The date on which the reachability and controls were last reviewed.                                          |
| Expiry       | An absolute date after which the exception cannot satisfy the gate.                                          |

An expired exception, a missing field, or a change that invalidates its reachability
analysis is a no-go. An exception records accepted residual risk; it does not suppress
the finding or make the alert disappear.

## Objective go/no-go checklist

The v1 candidate is a **go** only when every item below is true:

- [ ] Candidate scope is frozen; incomplete nonessential surfaces, including the
      conditional items above, are disabled and documented as deferred.
- [ ] No known released correctness regression remains, including #337 and the #330
      availability invariant.
- [ ] A real `v0.12.0` database passes direct migration, verified pre-migration backup,
      semantic post-checks, empty-volume restore, and matched rollback evidence.
- [ ] Interrupted migration/restore, disk-full, wrong-key, and newer-schema cases fail
      before unsafe writes or preserve a verified recovery path.
- [ ] Restore invalidates ordinary sessions and transient authorization state and
      invalidates or quarantines stale references and nonterminal external operations.
- [ ] Connector replacement, mutation uncertainty, sole-administrator recovery, and
      backup-first offline key rotation pass their fault and rollback cases.
- [ ] SIGTERM with active mutation, SSE, direct playback, HLS, and download work exits
      within 20 seconds without database corruption; disconnect, backpressure, transfer,
      memory, file-descriptor, and WAL limits also pass.
- [ ] All four evidence tiers pass for the exact source SHA and candidate digest, with
      native execution for every architecture advertised as stable.
- [ ] The compatibility matrix names supported capabilities, exact upstream version
      bounds, verification dates, and evidence that has not expired.
- [ ] There is no untriaged high or critical security finding; every accepted exception
      has all required fields and is unexpired.
- [ ] A clean-host operator rehearsal executes the documented install, TLS proxy,
      bootstrap, backup, empty-host restore, upgrade, rollback, and troubleshooting path.
- [ ] The durable evidence index, checksums, SBOM, signatures, attestations, architecture
      results, and recovery reports identify the exact candidate and are operator-verifiable.
- [ ] README, roadmap, compatibility, security support, changelog, release notes, and
      image metadata agree on supported, experimental, and deferred claims.

Any unchecked item is a **no-go**. Promotion may proceed only for the exact candidate
recorded by the completed evidence index.
