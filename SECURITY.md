# Security policy

Omnifin is designed to handle identity assertions, session state, media history, and
credentials that may carry administrative access to several services. The current
pre-release code exposes OIDC authentication, local sessions, recovery access,
Jellyfin pairing, connector administration, media operations, and authentication audit
records. These surfaces remain pre-v1 and unsupported as stable. The gateway, storage,
identity, connector, and release boundaries are security-sensitive. Please report
suspected vulnerabilities privately and avoid testing against systems or data you do
not own.

## Supported versions

There is no supported stable release yet. All `v0.x` releases are pre-v1 previews and
are not supported as stable release lines. During pre-release development, security
fixes are made on the default branch and may be included in the next tagged preview.
V1 support remains pending the scope, security review, and exact-candidate evidence in
the [v1 stability gate](docs/v1-stability.md). Once a stable release passes that gate,
this section will list its supported release line and end of security support.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/rezanmz/omnifin/security/advisories/new>

Do not open a public issue, discussion, or pull request before a fix and disclosure
plan are agreed.

Include, when available:

- affected version, image digest, or commit;
- component and deployment assumptions;
- impact and the attacker's required access;
- reproducible steps or a minimal proof of concept;
- whether secrets or personal data may have been exposed;
- mitigations already tested; and
- a safe way to credit you, or a request to remain anonymous.

Never send real API keys, passwords, cookies, session values, recovery secrets, OIDC
tokens, private media records, or an unredacted database. Use synthetic values and an
isolated environment.

## What to expect

Maintainers will make a best-effort acknowledgement, validate the report, determine
severity and affected versions, coordinate a fix, and agree on a disclosure timeline.
Complex reports or maintainer availability can affect timing; please use the private
advisory thread for status rather than disclosing the issue publicly.

Validated reports may result in a security advisory, patched release, updated
container digest, release notes, and credit when desired. A fix is not considered
complete until regression tests and a secret-exposure review pass.

## Safe-harbor intent

Good-faith research should:

- remain within accounts, media, services, and infrastructure you own or have explicit
  permission to test;
- minimize data access and stop once impact is demonstrated;
- avoid persistence, denial of service, social engineering, privacy violations, and
  supply-chain disruption;
- give maintainers reasonable time to investigate and remediate; and
- comply with applicable law.

The project intends not to pursue action against good-faith research that follows
these guidelines. This statement does not authorize testing of third-party services
or waive their policies.

## Security design

The public [security model](docs/security-model.md) describes assets, trust boundaries,
threats, and required controls. It intentionally omits exploitable operational details
and live configuration.
