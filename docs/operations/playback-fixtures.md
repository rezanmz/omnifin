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

This fixture proves deterministic media construction, stream selection, seeking, HLS
segmentation, and software transcoding. The isolated live Jellyfin matrix remains a
separate release gate for Jellyfin API negotiation, direct play, progress updates,
reconnect behavior, and browser playback against a running server.
