# Generated playback fixtures

Omnifin's protected integration workflow generates its playback corpus from
mathematical video patterns, synthesized sine tones, and repository-authored caption
text. It downloads no artwork, film, television, music, subtitle, or other media
content. Generated outputs are temporary test artifacts and are not distributed in the
application image.

Run the same isolated generation and transcode check locally:

```sh
pnpm fixture:media --output artifacts/media/playback-fixture
```

The runner generates media with the official Jellyfin 10.11.11 image pinned by
multi-architecture digest. Docker runs with networking disabled, a read-only root filesystem, no Linux
capabilities, no privilege escalation, a PID limit, a private temporary filesystem,
and only a private staging directory mounted writable. Validated files are published
atomically into the selected artifact directory only after every generation and
inspection check passes. The bundled Jellyfin FFmpeg and FFprobe binaries perform every
encode and inspection.

The source MP4 contains a 12-second 640×360 H.264 test pattern, English and French AAC
tone tracks, and English and French embedded captions. The gate verifies exact stream
counts, codecs, languages, dimensions, frame rate, duration, and bounded file size. It
then verifies two independent playback operations:

- a 320×180 HLS VOD transcode with bounded transport-stream segments and a complete
  playlist; and
- a two-second seek from the middle of the source while selecting the alternate French
  audio track.

The uploaded JSON evidence contains only the immutable image reference, file basenames,
sizes, SHA-256 digests, normalized stream metadata, and segment count. It contains no
host path, media path from an installation, account identity, token, cookie, or upstream
response.

The protected gate then distributes that single generated fixture to two independent
GitHub-hosted runners. One starts Jellyfin 10.10.7 as the oldest targeted version and the
other starts Jellyfin 10.11.11 as the latest version verified on 2026-07-31. Both official
images are pinned by their multi-architecture digest and run with fresh private
configuration and cache directories.

Container creation normally runs once. A narrowly allowlisted Docker daemon, networking,
or host-port allocation failure may receive one retry after 250 milliseconds. The harness
force-removes any partial container before retrying and again after retry exhaustion; stable
configuration and policy failures stop immediately. Public evidence exposes only the bounded
`container_start_failed`, `container_start_retry_exhausted`, and applicable cleanup categories.
Raw daemon diagnostics, runner paths, generated container names, ports, and network identifiers
remain private.

Each version completes the first-run flow with ephemeral credentials and then calls
Omnifin's production identity and playback connectors. The gate requires public version
discovery, password authentication, invalid-password rejection, Quick Connect
initiation, mismatched-secret rejection, administrator approval, polling, and final
Quick Connect authentication. It then imports the fixture and requires successful
direct-play negotiation, an authenticated 4 KiB range response, French audio and English
subtitle selection, a seeked HLS transcode and real media segment, exact progress
persistence, and playback renegotiation after restarting Jellyfin. The uploaded reports
contain only normalized booleans, versions, and immutable image references; they omit
server, user, session, Quick Connect, media, device, path, port, token, and credential
identifiers.

This isolated matrix proves deterministic media construction and Omnifin-to-Jellyfin
identity and playback behavior across the targeted range without depending on copyrighted
media, a maintainer's server, or local container capacity. It remains development evidence:
the protected live compatibility matrix is a separate release gate for installations
outside the CI network, and the Playwright browser matrix separately verifies player
interaction and browser behavior.
