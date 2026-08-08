# Media library catalogue

Omnifin exposes a normalized catalogue for the Jellyfin account explicitly paired to the current
session. It does not use an administrator-wide library query and it never accepts a Jellyfin user
identifier from the browser.

`GET /v1/media/library` requires `media.view` and accepts these bounded query parameters:

| Parameter | Values                                           | Default  |
| --------- | ------------------------------------------------ | -------- |
| `kind`    | `all`, `movies`, or `series`                     | `all`    |
| `sort`    | `recent`, `title`, or `year`                     | `recent` |
| `query`   | one to 100 visible characters                    | omitted  |
| `limit`   | one to 50 items                                  | `30`     |
| `cursor`  | a previously returned opaque continuation cursor | omitted  |

Each result contains movie or series title metadata, optional movie watch state, and protected
artwork paths, and an opaque media reference suitable for Omnifin's playback routes. Raw Jellyfin
item IDs, the paired user ID, tokens, server URLs, connector IDs, filesystem paths, and upstream
payloads are not returned.

Selecting a catalogue card is an information action, not a playback action. Omnifin resolves the
opaque reference through `GET /v1/media/library/:referenceId` and returns normalized title facts.
Movie details include the paired user's playback state. Series details include at most 100 season
summaries; no episode payload is embedded in the title response.

Series episodes are read only after a season is selected through
`GET /v1/media/library/:referenceId/seasons/:seasonNumber/episodes`. The endpoint returns at most 50
episodes and an encrypted continuation cursor. That cursor is bound to the current user, Jellyfin
link revision, title reference, season number, and page size. It cannot be replayed for another
series, season, account, or pairing. Episode responses contain fresh opaque playback references;
the browser never learns Jellyfin's series, season, or episode identifiers.

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

## Personal playback state

`POST /v1/media/library/:referenceId/playback-state` changes the paired user's own Jellyfin state.
It requires `playback.history.self.manage`, a valid same-origin CSRF context, and a bounded
`Idempotency-Key`. Supported actions are `mark_watched`, `mark_unwatched`, and `reset_progress`.
The gateway always supplies the paired Jellyfin user ID itself; the browser cannot select another
account. Marking a title unwatched follows Jellyfin's native semantics, while resetting progress
sets the saved playback position to zero without changing the watched flag.

Each accepted operation and its connector-generation snapshot are durably reserved before connector
I/O. Reusing a key with the same request returns the stored normalized response, while reusing it
with different input fails with a conflict. The dispatch boundary is committed before the Jellyfin
setter is called. A timed-out mutation is reconciled through exact paired-user playback readback;
an already-matching state succeeds, while a proven opposite state permits one state-set retry. An
unreadable or still-unconfirmed state remains reconciliation-required and is never blindly
redispatched. Successful and failed mutations create an atomic audit record containing only the
action, outcome, actor/session, request correlation, and a privacy-preserving IP digest. The audit
record deliberately excludes media references, titles, upstream item IDs, positions, and other
viewing-history data.

## Private viewing history

`GET /v1/media/history` returns recent movie and episode activity for the explicitly paired
Jellyfin user. It requires `playback.history.self.manage` and accepts bounded `kind`, `state`,
`range`, `limit`, and encrypted `cursor` parameters. Defaults are all media, all activity states,
the previous 30 days, and 30 entries. Completed activity is ordered by Jellyfin's last-played time;
resumable activity uses the current saved position. Omnifin does not copy playback activity into a
competing history database.

The first page fixes an exact date cutoff. Continuation cursors bind that cutoff and the last raw
Jellyfin boundary to the current Omnifin user, identity link revision, filters, and page size. Newer
activity therefore does not shift or duplicate later pages, and relinking or changing a filter
invalidates the cursor. Entries expose only normalized title context, protected artwork paths,
current playback state, and fresh opaque media references. A healthy empty result, temporary
upstream unavailability, signed-out caller, and permission denial remain distinct response states.

## Viewer experience

`/library` is the user-facing catalogue. It provides bounded search, movie and series filters,
recent/title/year sorting, opaque continuation paging, movie watch progress, series and season
hierarchy, and lazy-loaded theater playback behind an explicit play or resume action. Opening a
card always shows title information first. The page never receives the Jellyfin user ID, connector
address, API token, raw item ID, or filesystem path. Artwork and streams remain on Omnifin's
authenticated origin.

Movie and episode detail surfaces provide explicit mark-watched, mark-unwatched, and reset-progress
controls. “Play from beginning” is a one-time playback choice and never silently clears the saved
Jellyfin position. `/history` provides the same protected playback entry points in a private,
date-grouped activity view with media, completion, and time-range filters. It distinguishes loading,
empty, partial-page, offline, signed-out, and permission-denied states without exposing technical
connector details.

The interface has deliberate loading, empty, unavailable, signed-out, and permission-denied
boundaries. Desktop cards leave headroom for their raised hover and focus treatment; the catalogue
grid remains directly on the adaptive page backdrop so it does not become a separate opaque panel.
Keyboard and directional navigation share the same title-card, season-tab, episode, and explicit
play order. Touch layouts keep visible 44-pixel actions, and reduced-motion mode removes
nonessential transforms and shimmer. Light, dark, and system appearance preferences use the same
liquid-material hierarchy.

Administrative scan, match, metadata, and artwork work remains separate at
`/operations/library`, so viewer navigation does not expose operator controls by accident.

Administrative Jellyfin writes use the same encrypted external-mutation journal and exact connector
generation snapshot. Scan, item refresh, and artwork apply have no exact immediate postcondition, so
an ambiguous failure after dispatch is terminally `uncertain` and the same operation is not sent
again. Metadata updates use exact field readback: a matching requested patch succeeds, and a proven
mismatch permits one setter retry before remaining reconciliation-required.

Guarded removal retains its encrypted reviewed preview and stage repair data. One opaque target lock
serializes the parent title while monitoring, organized-file, and manager-record writes each receive
their own dispatch record. Recovery proves the exact stage postcondition (unmonitored, exact file
absent, manager record absent, or Jellyfin item absent) before repairing the visible operation. It
never repeats a destructive stage whose outcome is not proven; unresolved operations continue to
surface `reconcile_required` with `outcome_unknown` and retain their lock and encrypted repair data.

The disposable Jellyfin compatibility runner imports the generated copyright-free media fixture
and exercises this production catalogue client with the exact paired user on both targeted
Jellyfin versions. It validates normalized output and emits only a closed, identifier-free result.
This fixture evidence does not replace the protected live compatibility gate described in the
[compatibility policy](compatibility.md).
