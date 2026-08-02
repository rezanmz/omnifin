# Runtime build identity

Every Omnifin installation exposes a small, public build identity so an operator can establish what
is running before signing in or sharing a support report. Open `/about` on the normal web origin, or
read the same normalized contract through the same-origin proxy:

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/api/runtime
```

The response contains only:

- schema version `1`;
- build channel: `development`, `edge`, or `stable`;
- SemVer application version;
- full lowercase source commit, or `null` for development;
- `AGPL-3.0-only` license identifier;
- immutable corresponding-source URL for published builds; and
- `verified` or `development` verification state.

It contains no installation identifier, image digest, host data, path, connector state, account,
session, cookie, IP address, or telemetry value. `GET /v1/runtime` on the private gateway and
`GET /api/runtime` on the web origin are deliberately session-free, bounded, rate-limited, and
publicly cacheable. Raw build environment and container labels never reach the browser.

## Identity rules

A stable identity is accepted only with a stable `MAJOR.MINOR.PATCH` version, a full 40-character
revision, and an HTTPS source URL ending in `/tree/<revision>` or `/commit/<revision>`. An edge
identity has the same immutable-source requirement and an `edge` SemVer prerelease identifier.
Development builds require a `dev` prerelease, a null revision, and the explicit `development`
verification state. Any inconsistent combination prevents the gateway from starting and produces
only the sanitized `runtime_identity_invalid` configuration code.

Release and protected-main workflows pass identity values as Docker build arguments. The image
bakes the closed JSON contract into `/opt/omnifin/build-identity.json` as a read-only file and also
records the public values in OCI labels and image environment for offline inspection. The gateway
prefers the baked file; runtime environment overrides cannot replace it. A reviewed source checkout
without that file uses the explicit unverified development identity.

The container smoke harness reads the image configuration, starts the real gateway, and requires
the public endpoint to return the exact same closed identity without a session cookie. Edge and
stable promotion cannot proceed until that check passes against the anonymously pulled image
digest.

## Operator verification

For an installed release:

1. Open `/about` and confirm **Release verified**.
2. Compare the displayed version with the selected GitHub Release.
3. Follow **View corresponding source** only when you intend to open the public source host; loading
   the About page itself makes no external request.
4. Use **Copy support identity** to copy only the version, channel, revision, and license. Add the
   immutable image digest separately when a support or security report needs it.
5. Treat **Development build**, **Not release-verified**, or an unavailable identity as a reason to
   confirm how the installation was built before relying on release support claims.

The runtime identity proves the artifact's declared source relationship; it does not replace digest
pinning, checksum verification, keyless signature verification, SBOM review, or the release
attestations described in the [release process](release-process.md).
