# Media library catalogue

Omnifin exposes a normalized catalogue for the Jellyfin account explicitly paired to the current
session. It does not use an administrator-wide library query and it never accepts a Jellyfin user
identifier from the browser.

`GET /v1/media/library` requires `media.view` and accepts these bounded query parameters:

| Parameter | Values                                           | Default  |
| --------- | ------------------------------------------------ | -------- |
| `kind`    | `all`, `movies`, or `episodes`                   | `all`    |
| `sort`    | `recent`, `title`, or `year`                     | `recent` |
| `query`   | one to 100 visible characters                    | omitted  |
| `limit`   | one to 50 items                                  | `30`     |
| `cursor`  | a previously returned opaque continuation cursor | omitted  |

Each result contains playable movie or episode metadata, watch position, played state, protected
artwork paths, and an opaque media reference suitable for Omnifin's playback routes. Raw Jellyfin
item IDs, the paired user ID, tokens, server URLs, connector IDs, filesystem paths, and upstream
payloads are not returned.

Pagination cursors are encrypted and bound to the Omnifin user, current Jellyfin identity link,
link revision, search text, filter, sort order, and page size. Relinking or revoking Jellyfin makes
an existing cursor invalid. Changing any query field while reusing a cursor also fails closed with
`media_library_cursor_invalid`; the response never echoes the rejected cursor.

The response has an explicit state:

- `complete` contains one or more catalogue items and may contain a continuation cursor;
- `empty` is a healthy Jellyfin response with no matching items; and
- `unavailable` contains no media or cursor and one bounded, browser-safe partial failure.

Operational upstream failures become the normalized `unavailable` state. A missing, disabled, or
invalid Jellyfin pairing returns a safe `503` boundary error. Signed-out callers and principals
without `media.view` are rejected before connector I/O. Responses are private and use
`Cache-Control: no-store`.

The disposable Jellyfin compatibility runner imports the generated copyright-free media fixture
and exercises this production catalogue client with the exact paired user on both targeted
Jellyfin versions. It validates normalized output and emits only a closed, identifier-free result.
This fixture evidence does not replace the protected live compatibility gate described in the
[compatibility policy](compatibility.md).
