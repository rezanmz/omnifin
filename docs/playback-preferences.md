# Playback preferences

Omnifin keeps each user's playback defaults with their Omnifin identity. Open
**Account & access → Playback defaults** to choose ordered audio and subtitle languages,
subtitle behavior, accessibility-track intent, and separate home and remote quality ceilings.
The same screen is available from the profile menu.

Preferences are semantic. Omnifin stores language tags and roles such as original audio,
forced subtitles, SDH/CC, and commentary—not a Jellyfin stream index from one file. Before
each play, the gateway returns a bounded set of normalized tracks and the browser resolves the
profile deterministically against that set. If a preferred track is unavailable, Jellyfin's valid
selected or default track wins. The player explains the effective choice.

Changing audio, subtitles, or quality in the theater is a **this-play-only** override. It does not
silently replace the account profile. Account defaults can be reset from the settings screen.

## Quality and network policy

Quality values are ceilings, not promises of a particular delivery method. Jellyfin and browser
codec support still decide whether the result is direct play, remux, or transcode. Supported
ceilings are deliberately bounded to 2, 4, 10, 20, 40, or 80 Mbps. Home policy may also allow
Source/Original.

Automatic network selection uses Fastify's resolved client address only after the configured proxy
chain has supplied trusted attribution. A private web-container address is never treated as proof
that a remote browser is at home. If an expected forwarding hop is missing or malformed, Omnifin
uses the remote ceiling. Operators should configure the exact proxy counts described in the
[reverse-proxy guide](operations/reverse-proxy.md); users may choose a manual home or remote policy
when automatic classification is not suitable for their topology.

## Storage and privacy

`GET /v1/playback/preferences` and CSRF-protected `PUT /v1/playback/preferences` are self-only,
session-authenticated routes. Updates use revision compare-and-swap so two browsers cannot silently
overwrite each other. Responses are private and non-cacheable.

SQLite stores a versioned, bounded JSON profile keyed by the Omnifin user ID. It does not store IP
addresses, device fingerprints, media identifiers, Jellyfin track IDs, connector credentials, or
tokens. A Jellyfin relink therefore keeps the same person's semantic preferences without applying
file-specific state from the former link. Corrupt or unsupported stored data fails closed rather
than being returned to the browser.

Episode autoplay, skip-marker, and still-watching controls remain part of the versioned contract for
the upcoming Up Next workflow. They are not shown as settings until that workflow enforces them, so
the interface never presents a control that has no playback effect.
