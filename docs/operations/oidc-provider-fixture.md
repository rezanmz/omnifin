# Standards-generic OIDC fixture

The protected connector workflow runs a second identity-provider gate alongside Authentik. It
starts Dex 2.45.1 from an immutable multi-architecture image digest and drives Omnifin's production
OIDC routes through a real browser. Dex is a standards interoperability oracle for this test; it is
not a product support claim or a recommended production identity provider.

The fixture creates a fresh SQLite-backed provider, Omnifin database, certificate authority,
provider client, encryption key, recovery secret, ports, and Docker project for every run. The
provider is read-only apart from bounded tmpfs storage, drops all Linux capabilities, runs with
`no-new-privileges`, publishes only one random loopback port, and uses a dedicated disposable
network. Its fixed mock connector does not contact an upstream identity source. Docker Desktop
cannot route the host into an internal bridge, so the bridge is not marked `internal`; the harness
does not treat that topology as proof of network egress denial.

The runner places two certificate-verifying TLS endpoints in front of the loopback web and provider
processes. Omnifin trusts only the generated one-run certificate authority. Discovery must report
the exact issuer, Authorization Code flow, PKCE S256, RS256 signing, and the required OpenID scope.
The provider deliberately does not advertise RP-initiated or back-channel logout, exercising the
optional-capability boundary independently of Authentik's advertised logout coverage.

Run the complete focused gate after building the applications and installing Playwright Chromium:

```sh
pnpm build
pnpm --filter @omnifin/web exec playwright install chromium
pnpm test:oidc-provider --skip-build --output artifacts/integration/oidc-provider/report.json
```

Omit `--skip-build` to let the harness build the workspace itself. The browser check requires:

- fresh discovery and normalized capability negotiation;
- Authorization Code flow with Omnifin's PKCE S256 transaction;
- fresh, opaque state and nonce values bound to each successful transaction;
- exact issuer validation and standard profile, email, and group claims;
- reuse of the immutable `(issuer, sub)` identity across sign-ins;
- JIT provisioning as `viewer` with media access denied pending Jellyfin pairing;
- elevation only after an explicit `groups` role mapping is configured;
- mapped and remapped session convergence read through the post-callback browser origin before the
  harness inspects the rotated HttpOnly cookie, preventing a separate request context from
  supplying stale authentication state under runner load;
- local session revocation and a same-origin logout redirect when no provider logout endpoint is
  advertised; and
- absence of generated client, recovery, and encryption secrets from captured browser, application,
  and provider output.

Teardown is part of the gate. The browser, web process, gateway, TLS proxy, provider container,
network, databases, certificates, and generated secrets are removed before a successful report is
written. The closed report contains only fixed check names, the provider version, mode, schema
version, service name, and pass status. Failure reports expose one normalized stage category; URLs,
ports, identities, claims, paths, cookies, assertions, credentials, logs, and request payloads cannot
be represented.

Authentik remains the isolated product-specific gate for an issuer that advertises RP-initiated and
back-channel logout. Neither isolated gate establishes the public live compatibility baseline. That
baseline remains blocked on protected external evidence with exact provider versions and dates.
