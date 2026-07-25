# Security model

Omnifin is designed to concentrate administrative access to several services, so a
completed deployment will have a larger compromise impact than a read-only media
client. This model defines the assets, adversaries, boundaries, and invariants used in
design and review.

> [!IMPORTANT]
> Phase 0 implements defensive foundations including input schemas, origin checks,
> security headers, redacted logging, encrypted-value primitives, SQLite migrations,
> and connector destination validation. It does not yet accept authentication,
> establish sessions, link identities, configure connectors, proxy media, perform
> upstream mutations, or write product audit events. Controls for those surfaces below
> are mandatory implementation requirements, not claims of current protection.

For vulnerability reporting, follow [SECURITY.md](../SECURITY.md).

## Protected assets

- OIDC client credentials, authorization responses, and identity assertions
- Jellyfin user tokens and connector API credentials
- session tokens, CSRF material, and recovery secrets
- role assignments, identity links, and authorization policy
- private media metadata, paths, history, and viewing activity
- the ability to request, grab, delete, import, scan, or edit media
- audit history and the integrity of migrations and release artifacts

## Assumed adversaries

The design considers an unauthenticated internet client, a low-privilege authenticated
user, a malicious media or metadata payload, a compromised or misconfigured upstream
service, an attacker who can induce server-side requests, and an observer with access
to application logs or a database backup. A host-level compromise is outside the
application boundary; operators must still patch and isolate the host.

## Required security invariants

1. The browser never receives reusable upstream credentials.
2. Every upstream mutation requires a local permission check at the gateway.
3. Identity linking requires current proof of control; mutable profile claims are
   not proof.
4. Sessions are server-side, revocable, rotated, and bounded by inactivity and
   absolute expiry.
5. State-changing browser requests require origin and CSRF validation.
6. Connector egress is limited to administrator-approved destinations and resists
   SSRF and redirect bypasses.
7. Sensitive stored values use authenticated encryption with a key outside the
   database.
8. Logs, diagnostics, and error responses redact credentials, cookies, assertions,
   media paths, and private upstream payloads.
9. Security-relevant actions leave durable, attributable audit records.
10. Releases are reproducible enough to bind source, image digest, provenance, SBOM,
    signature, and attestation.

## Required threat controls

| Threat                        | Primary controls                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Session theft or fixation     | Secure HttpOnly cookies, rotation, bounded lifetime, revocation, HSTS                             |
| Login CSRF or callback replay | PKCE S256, state, nonce, one-time transactions, exact issuer validation                           |
| Account-link takeover         | Fresh Jellyfin proof, immutable IDs, uniqueness checks, no email auto-linking                     |
| Privilege escalation          | Default viewer JIT role, explicit claim mappings, named local permissions, audit                  |
| Cross-site request forgery    | SameSite cookie, strict origin checks, session-bound CSRF token                                   |
| SSRF through connector setup  | Scheme/host validation, resolved-address checks, redirect policy, explicit local-network approval |
| Credential disclosure         | Gateway isolation, authenticated encryption, redaction, response schemas, secret scans            |
| Malicious upstream content    | Schema parsing, output encoding, content-type controls, media proxy allowlists                    |
| Destructive replay            | Idempotency keys or current-state preconditions, authorization, audit, safe confirmation UX       |
| Supply-chain compromise       | Locked dependencies, pinned actions, review gates, CodeQL, SBOM, provenance, signatures           |

## Browser protections

Phase 0 web and gateway code emits Content Security Policy, HSTS for secure requests,
`nosniff`, frame restrictions, restrictive referrer policies, and minimal permissions
policies. Current product routes do not accept reusable upstream credentials. Later
identity and connector flows must never place credentials in query strings, local
storage, client logs, analytics, or error-reporting services. External telemetry is off
by default.

When media proxying is implemented, responses must enforce an approved upstream
origin, safe content types, byte-range limits, authorization on every request, and
cache rules that do not expose one user's protected content to another.

## Operational controls

Future supported deployments should place Omnifin on a segmented network with only
required egress to configured services, terminate HTTPS at a maintained reverse proxy,
protect host and backup access, and use distinct least-privilege connector credentials
where an upstream service supports them. Internet-facing access should sit behind rate
limiting and normal infrastructure monitoring.

When implemented, audit records must support investigation without replacing host
logs, and their retention and export must preserve user privacy. Once product data is
stored, a database backup may contain private metadata and encrypted secrets while the
master key separately enables decryption; both require protection.

## Vulnerability scanning policy

The pinned Trivy scanner produces a complete SARIF report for source and container
scans, including low, medium, unfixed, and fixable findings. Reporting is separate from
enforcement: CI fails on fixable high or critical vulnerabilities and independently
fails on high or critical secret and infrastructure findings. Unfixed vulnerabilities
remain visible and are reevaluated by scheduled scans as upstream fixes become
available; excluding them from the blocking pass is not a risk acceptance or a report
suppression.

Do not add directory-wide, file-wide, status-wide, or severity-wide ignores to make a
check green. A future false-positive exception must identify the exact finding and
affected package or path, explain the deployment-specific reasoning, include an expiry,
and receive security review in the same pull request.

## Review gates

A security-sensitive feature is not complete until it has:

- a threat-model update covering spoofing, tampering, repudiation, disclosure,
  denial of service, and elevation of privilege;
- negative tests for invalid credentials, permissions, replay, timeout, and malformed
  upstream data;
- a secret-leak inspection across logs, responses, browser storage, and build output;
- an account and session lifecycle test where applicable; and
- review of dependency, container, infrastructure, and migration changes.
