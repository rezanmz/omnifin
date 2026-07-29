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

The runner uses the official Jellyfin 10.11.11 image pinned by multi-architecture
digest. Docker runs with networking disabled, a read-only root filesystem, no Linux
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

The protected gate then starts that same Jellyfin image with fresh private configuration
and cache directories. It completes the first-run flow with ephemeral credentials,
imports the fixture, and calls Omnifin's production playback connector. The gate requires
successful direct-play negotiation, an authenticated 4 KiB range response, French audio
and English subtitle selection, a seeked HLS transcode and real media segment, exact
progress persistence, and successful playback renegotiation after restarting Jellyfin.
The second uploaded report contains only normalized pass evidence and versions; it omits
server, user, session, media, device, path, port, and credential identifiers.

This isolated gate proves deterministic media construction and Omnifin-to-Jellyfin
playback behavior without depending on copyrighted media or a maintainer's server. The
protected live compatibility matrix remains a separate release gate for installations
outside the CI network, and the Playwright browser matrix separately verifies player
interaction and browser behavior.
