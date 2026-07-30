# Release process

This document defines how a reviewed change becomes a verifiable GitHub Release and
container image. Stable releases fail closed: the workflow does not publish a GitHub
Release or a stable container tag until the exact candidate digest has passed every
release gate.

## Repository prerequisites

Before the first release:

- protect `main`, require pull requests, and require the stable `CI`, `Security`, and
  `Connector integration` checks;
- protect `v*` tags and allow only the release automation identity to create them;
- create a `release` environment restricted to protected `main` deployments and store
  `RELEASE_PLEASE_TOKEN` there as a narrowly scoped fine-grained personal access token
  that can manage repository contents, issues, and pull requests; every job that can
  publish, sign, attest, promote, or finalize a release also enters this environment;
- before selecting a release profile with live requirements, create an `integration`
  environment restricted to protected `main`, configure upstream URLs as environment
  variables and credentials as environment secrets, and retain any required deployment
  review policy;
- set `OMNIFIN_RELEASE_AUTOMATION_ENABLED=true` only after the protected release token
  is configured and tested; and
- make the `ghcr.io/rezanmz/omnifin` package public.

The dedicated Release Please token is mandatory and must not be a repository-level
secret. The protected environment keeps it unavailable to branch-selected workflows.
Pull requests created with it emit ordinary `pull_request` events, so release pull
requests receive the same CI and security checks as every other change. The workflow
intentionally has no label-based or `workflow_dispatch` fallback that could substitute
a weaker check run.

Until `OMNIFIN_RELEASE_AUTOMATION_ENABLED` is exactly `true`, the Release Please
workflow reports that automation is pending and does not enter the `release`
environment. Similarly, live integration remains pending until
`OMNIFIN_LIVE_INTEGRATION_ENABLED=true`; enabling it does not bypass the reviewed
coverage ledger. Exact protected configuration names are listed in the
[integration runner guide](../scripts/integration/README.md).

GHCR may initially create a package as private even when its linked repository is
public. If the first candidate stops at anonymous verification, a package owner must
change its visibility to public before retrying. Stable tags will not have been
created; the edge workflow likewise does not move `edge` or create its immutable SHA
alias before anonymous candidate verification succeeds.

## Version source

Squash-merged pull-request titles follow Conventional Commits. Release Please uses
those titles to maintain a release pull request containing the proposed semantic
version and changelog. The version is reviewed as code; merging ordinary feature
changes does not publish a stable release by itself.

Completed phase gates may publish `v0.x` versions. `v1.0.0` requires the full product,
identity, compatibility, security, and interface-quality gates in the roadmap.

## Default-branch images

After both `CI` and `Security` have successful `push` runs for the same current
`main` commit, automation may publish:

- `edge`, a moving integration image; and
- `sha-<commit>`, an immutable source-specific image.

These images are for validation and are not stable release channels.

Edge publication is candidate-first. It pushes only a unique candidate tag, attaches
provenance and a keyless signature, then pulls and smoke-tests that digest without
registry credentials. Only that verified digest may be copied to `sha-<commit>` and
`edge`; an existing SHA tag is accepted only when it already resolves to the same
digest. A final anonymous pull verifies the promoted aliases.

## Stable release trust boundary

The publishing workflow accepts only a stable `vMAJOR.MINOR.PATCH` tag, the matching
version, and a full commit SHA. It verifies all of the following before building:

- successful `CI` and `Security` `push` workflow runs whose source is the exact
  supplied SHA, protected `main`, and this repository;
- the workflow definition is running from `main` and `main` is protected;
- an unpublished, non-prerelease GitHub Release draft exists for the exact tag;
- the Git tag resolves to the supplied commit;
- the commit is an ancestor of `main`;
- `package.json` and `.release-please-manifest.json` contain the supplied version; and
- the version is newer than every published stable release.

Manual image-publishing dispatches have the same requirements and cannot infer the
source SHA from a mutable ref. A global release concurrency lock, a second GitHub
Release check, and a comparison against every stable SemVer tag already in GHCR
prevent overlapping or partially finalized releases from moving `latest` backward.

Source tests and migrations run without package-write or OIDC permissions. The exact
source selects a cumulative phase profile in `release-coverage.json`; every capability
claimed by that profile must be `ready` in the schema-validated ledger. A profile with
live requirements runs only inside the protected `integration` environment, while a
truthful Phase 0 profile with no live claims does not consume that environment. The
multi-architecture build, SPDX generation, and SBOM validation then run without
registry credentials and produce an OCI archive with a recorded digest. Jobs that
receive GHCR credentials do not check out the repository and never execute repository
scripts. GitHub exposes drafts only to callers with push access, so the draft-metadata
preflight and the final pre-promotion recheck receive `contents: write`; both execute a
pinned API action without checking out repository code, and the preflight contains no
mutation. All other pre-promotion source, build, scan, and verification jobs retain
read-only or empty contents permissions unless their stated artifact or registry
responsibility requires more.

## Candidate, evidence, and promotion

The release sequence is:

1. Resolve the reviewed phase profile, run its strict fixture requirements, and run its
   live requirements in the protected environment when the profile declares any.
2. Build a `linux/amd64` and `linux/arm64` OCI archive without registry credentials.
3. Publish it under a unique `candidate-<version>-<run>-<attempt>` tag and require the
   registry digest to equal the archive digest. The full version tag must be absent.
4. Attach BuildKit provenance, an SPDX SBOM attestation, a GitHub artifact attestation,
   and a keyless signature to that digest.
5. From fresh jobs with no `packages` permission or registry credentials, scan both the
   `linux/amd64` and `linux/arm64` manifests by the published digest. Retain complete
   reports, fail on fixable high or critical vulnerabilities, and separately fail on
   high or critical secret and infrastructure findings.
6. From a fresh job with an empty Docker credential directory, resolve the candidate
   tag, pull the digest anonymously, verify its signature and platforms, and run the
   container smoke harness.
7. Recheck release ordering and full-version-tag absence, then point the full, minor,
   major, and `latest` tags at that exact verified digest.
8. From another anonymous job, resolve every stable tag and pull the full version.
9. Publish the GitHub Release and record the coverage profile and container digest in
   its notes.

For version `1.4.2`, successful promotion creates:

- `1.4.2`, which is immutable;
- `1.4`, which advances only with newer releases;
- `1`, which advances only with newer releases; and
- `latest`, which always identifies the newest published stable release.

The workflow refuses to overwrite an existing full-version tag, including on a
rerun. Moving aliases are never created before candidate SBOM, signature, two-platform
vulnerability policy, smoke, and public-access verification succeed.

## Verification coverage

The digest smoke harness verifies the rootless runtime, gateway liveness and
readiness, a representative versioned API read, migration-backed startup, and web
health. Pull-request CI also loads its locally built image and runs this same harness,
so an image that merely compiles cannot satisfy `CI`. The reviewed phase fixture matrix
and migration rehearsal run as source gates before a stable image is built. Strict mode
rejects every selected service/profile still marked `pending` in `readiness.json`, even
if URLs or credentials are present. Pending future-phase capabilities do not block a
`v0.x` release that does not claim them. Conversely, `1.0.0` and later structurally
require the explicit `v1` profile, whose fixture and live lists must contain every
service. Compatibility, backup/restore, and broader release rehearsals remain
phase-gate requirements documented in the roadmap.

The retained release evidence includes the portable SPDX document and checksum,
two-platform candidate scan reports, sanitized fixture and applicable live integration
reports, BuildKit provenance, the keyless signature, GitHub attestations, the coverage
profile in the image metadata, and both the profile and digest in the GitHub Release
notes.

## Failure and recovery

A failure before promotion may leave only a uniquely tagged candidate digest. It does
not create or move stable tags. Fixes land through normal review and produce a new
patch version.

If a registry or GitHub failure occurs after any stable tag is created, do not rerun
promotion over the full-version tag. Verify the existing digest, finish only the
non-registry release bookkeeping if appropriate, and open an incident record. If the
artifact itself is faulty, publish a new patch release. Operators roll back to a
previously verified version or digest rather than relying on a rewritten tag.
