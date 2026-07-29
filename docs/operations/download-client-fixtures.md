# Isolated download-client fixtures

The protected connector workflow starts fresh qBittorrent and SABnzbd instances for every pull
request. The instances use LinuxServer images pinned by release tag and multi-architecture index
digest. They receive no repository or environment secrets, run on a unique internal Docker network,
publish no host ports, have CPU, memory, and process limits, and are destroyed with their private
configuration after the check. The runner reaches the Web UI directly through the one private
container address; Docker documents that the host retains this access on an internal network while
the container has no default route to any other network.

Both images run as the host runner's unprivileged UID and GID. Their private `/run` tmpfs is owned by
that identity so the s6 supervisor can initialize while Docker's `no-new-privileges` restriction
remains enabled. The fixture does not use LinuxServer's root-time `PUID`/`PGID` remapping path.

Run either fixture after building the production adapters:

```sh
pnpm --filter @omnifin/connectors... build
pnpm fixture:download-client --service qbittorrent --output artifacts/integration/download-clients/qbittorrent/report.json
pnpm fixture:download-client --service sabnzbd --output artifacts/integration/download-clients/sabnzbd/report.json
```

The qBittorrent runner creates a small deterministic torrent whose tracker is loopback-only. The
SABnzbd runner uploads a repository-generated NZB with a synthetic message identifier to an instance
that has no news servers. The internal network has no route to the public internet, so neither
fixture can retrieve third-party content.

Each runner calls Omnifin's production adapter over the host's private interface and requires:

- successful authentication and exact version discovery;
- rejection of an invalid credential;
- a normalized read containing the one seeded queue item;
- exact-item resume followed by an observed non-paused state;
- exact-item pause followed by an observed paused state;
- exact-item removal followed by observed absence; and
- preservation of a byte-for-byte fixture file after removal.

qBittorrent receives one validated info hash and `deleteFiles=false`. SABnzbd receives one validated
`nzo_id` and no `del_files` parameter, matching SABnzbd's documented preserve-files default. The
test never performs a bulk operation.

The uploaded report is validated against a closed allowlist. It contains only the service name,
normalized server version, immutable image reference, fixed check names, and pass status. Native
queue identifiers, cookies, temporary passwords, API keys, URLs, ports, container names, host or
media paths, logs, and upstream payloads cannot be represented by its schema. Failure output is
limited to a normalized stage code; private Docker or upstream diagnostics remain ephemeral.

This is isolated real-service development evidence. It does not establish a public installation
compatibility baseline: protected live probes must still record exact supported versions and dates
before the compatibility table can make that claim.
