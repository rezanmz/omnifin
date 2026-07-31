# Isolated Seerr request fixture

The protected connector aggregate runs one disposable, digest-pinned Seerr instance to verify the
production request adapter against a real upstream database and API. This is development evidence;
it does not establish a public live-compatibility baseline.

## Security boundary

The harness creates a unique internal Docker network and publishes no container port. Seerr and a
read-only metadata sidecar are the only network members. The sidecar answers one exact HTTPS TMDB
movie route for a bounded synthetic title, and Seerr trusts only the fixture CA for that request.
The internal network has no external route, so neither service can reach a public metadata provider.

Seerr completes its own migrations before the harness stops it and adds two disposable Jellyfin-style
identities to the empty SQLite database. The seed program validates the migrated schema, runs with
`--network none`, and receives no credential. The transient Seerr API key is generated per run, read
from a mode-0600 env file, and passed to Omnifin's adapter only through container stdin. It is never
placed in a command argument or report.

## Verified behavior

The production `SeerrAdapter` must prove all of the following before the fixture can pass:

- exact version discovery and authenticated access;
- invalid-key rejection;
- resolution of the exact delegated Jellyfin identity;
- one pending movie request for the synthetic title;
- deterministic rejection of a duplicate request;
- normalized pending-review visibility; and
- an administrator decline followed by a fresh normalized read of the declined state.

The passing report contains only the pinned image, normalized Seerr version, service name, fixed
check names, schema version, and pass status. Failure reports contain only a bounded diagnostic code.
Containers, network, certificates, environment file, configuration, database, users, metadata, and
request records are removed before passing evidence is written.

## Running the focused gate

Build the connector and run the harness from the repository root:

```sh
pnpm --filter @omnifin/connectors... build
pnpm fixture:seerr-service --output artifacts/integration/seerr-service/report.json
```

The official Seerr and Node fixture images are pulled by immutable digest. Prefer the protected
GitHub runner for routine verification so local machines do not carry the container layers. A local
run requires Docker, OpenSSL, and enough resources for one Seerr and one small Node container.

On any failure, inspect the single redacted error code first. The harness intentionally does not
publish container logs or upstream payloads because they can contain paths, identifiers, or request
details.
