# Contributing to Omnifin

Thank you for helping build Omnifin. Contributions are welcome across code, design,
testing, documentation, compatibility fixtures, and accessibility review.

## Before you begin

- Read the [roadmap](docs/roadmap.md) and search existing issues and discussions.
- Use a discussion for an early idea or setup question.
- Open an issue before a large architectural change so scope and migration impact can
  be agreed before significant work.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Maintainers may decline work that broadens the trust boundary, duplicates a planned
capability, cannot be verified safely, or makes the interface more complex without a
clear user workflow.

## Set up the project

The [development guide](docs/development.md) covers prerequisites, local startup,
checks, fixtures, and migration expectations. Use isolated test services and accounts;
never run connector mutation tests against a personal or production media library.

## Make a focused change

Prefer one vertical, reviewable outcome. A complete feature includes contracts,
authorization, connector behavior, interface states, tests, observability, and
documentation where those layers apply.

For user-interface work, follow the [design quality bar](docs/design-quality.md).
Normal, loading, empty, offline, error, permission-denied, unsupported, reduced-motion,
and responsive states are part of the feature rather than follow-up polish.

For authentication, sessions, secrets, connector destinations, media proxying,
auditing, or release infrastructure, update the threat model and include negative
tests. The [security model](docs/security-model.md) defines non-negotiable invariants.

## Test and document

Start with the core package gate while iterating:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Before opening a pull request, run the complete checklist in the
[development guide](docs/development.md#required-checks), including documentation,
migration and schema drift, dependency and license policy, workflow policy, Compose,
and container startup checks. User-interface work also requires the listed Storybook,
browser, accessibility, visual, and Lighthouse evidence. Describe any check that
requires a dedicated CI environment and any test that could not be run.

Update documentation in the same pull request. Do not label a connector version
supported until the compatibility gate has produced evidence.

## Commits and pull requests

- Use Conventional Commit subjects, such as `feat(auth): add session revocation`.
- Cryptographically sign commits with GPG, SSH, or S/MIME.
- Keep generated files, migrations, lockfile changes, and visual baselines intentional.
- Do not include secrets or private media data in repository content or history.
- Allow maintainers to squash merge the pull request with a Conventional Commit title.

The pull request template asks for user impact, risk, evidence, accessibility,
security, migrations, and rollback. A checkbox is not evidence; link the relevant test
run, screenshot, story, fixture, or measurement.

## Review and licensing

Pull requests require green checks. The project initially permits maintainer merges
without an external approval so a solo maintainer is not blocked; review requirements
will increase when additional maintainers are active.

By submitting a contribution, you agree that it is licensed under the repository's
[GNU Affero General Public License v3.0 only](LICENSE). You retain copyright in your
contribution.
