# Isolated download-client fixtures

The protected connector workflow starts fresh qBittorrent and SABnzbd instances for every pull
request. The instances use LinuxServer images pinned by release tag and multi-architecture index
digest. They receive no repository or environment secrets, run on a unique internal Docker network,
publish no host ports, have CPU, memory, and process limits, and are destroyed with their private
configuration after the check. The runner reaches the Web UI directly through the one private
container address; Docker documents that the host retains this access on an internal network while
the container has no default route to any other network.

Image acquisition is separate from container launch. The runner pulls the exact digest with three
attempts at most, using fixed 5-second and 15-second delays only for explicit transient registry or
network categories. Authentication, authorization, missing manifest, unsupported-platform,
unknown daemon, and policy failures stop immediately. The container then starts with Docker's
local-only image policy, preventing an implicit pull. Raw registry and Docker diagnostics remain
private; uploaded failure evidence exposes only a bounded acquisition or startup category. Queue,
authentication, adapter, assertion, and cleanup failures are never retried.

Both images run as the host runner's unprivileged UID and GID. Their private `/run` tmpfs is owned by
that identity so the s6 supervisor can initialize while Docker's `no-new-privileges` restriction
remains enabled. The fixture does not use LinuxServer's root-time `PUID`/`PGID` remapping path.

Run either fixture after building the production adapters:

```sh
pnpm --filter @omnifin/connectors... build
pnpm fixture:download-client --service qbittorrent --output artifacts/integration/download-clients/qbittorrent/report.json
pnpm fixture:download-client --service sabnzbd --output artifacts/integration/download-clients/sabnzbd/report.json
```

The qBittorrent runner pre-seeds a randomly generated credential using qBittorrent's current
PBKDF2-SHA-512 configuration format, enables queue ordering, then creates two small deterministic
torrents whose trackers are loopback-only. The plaintext credential is never written to logs or
evidence and disappears with the private fixture directory. The SABnzbd runner uploads two
repository-generated NZBs with synthetic message identifiers to an instance that has no news
servers. The internal network has no route to the public internet, so neither fixture can retrieve
third-party content.

Each runner calls Omnifin's production adapter over the host's private interface and requires:

- successful authentication and exact version discovery;
- rejection of an invalid credential;
- a normalized read containing the seeded queue items in a known non-leading order;
- exact-item promotion followed by the target observed at queue position zero;
- exact-item resume followed by an observed non-paused state;
- exact-item pause followed by an observed paused state;
- coordinated pause/resume of two explicit items with both outcomes observed;
- exact-item removal followed by observed absence; and
- preservation of a byte-for-byte fixture file after removal.

Promotion sends qBittorrent one validated info hash through `topPrio`; SABnzbd receives one
validated `nzo_id` through `mode=switch` and position zero. Removal sends qBittorrent one validated
info hash and `deleteFiles=false`; SABnzbd receives one validated `nzo_id` and no `del_files`
parameter, matching SABnzbd's documented preserve-files default. Coordinated checks issue two
bounded exact-item calls and never use a client-native wildcard or bulk command, matching the
gateway coordinator's safety boundary.

The uploaded report is validated against a closed allowlist. It contains only the service name,
normalized server version, immutable image reference, fixed check names, and pass status. Native
queue identifiers, cookies, temporary passwords, API keys, URLs, ports, container names, host or
media paths, logs, and upstream payloads cannot be represented by its schema. Failure output is
limited to a normalized stage code; private Docker or upstream diagnostics remain ephemeral.

This is isolated real-service development evidence. It does not establish a public installation
compatibility baseline: protected live probes must still record exact supported versions and dates
before the compatibility table can make that claim.
