# Discovery

Omnifin's discovery workflow combines global search with normalized movie and series
details backed by one enabled Seerr connector. The gateway owns upstream credentials and
response normalization; the browser never receives a Seerr API key or an unvalidated
upstream payload.

This is a pre-release development surface, not a public Seerr compatibility claim. The
[compatibility matrix](compatibility.md) remains authoritative for supported versions.

## Request path and authorization

The browser calls the same-origin `GET /api/discovery/search`,
`GET /api/discovery/details/{kind}/{tmdbId}`, and
`GET /api/discovery/people/{tmdbId}` routes. The web process forwards those reads to the
matching `/v1/discovery/*` routes on the private gateway and forwards only the opaque
session cookie. The gateway requires an active principal with `media.view` before it reads
connector configuration or contacts Seerr.

The query contract is deliberately bounded:

| Parameter  | Requirement                                           |
| ---------- | ----------------------------------------------------- |
| `query`    | Trimmed text between 2 and 200 characters             |
| `language` | BCP 47-style two-letter language with optional region |
| `page`     | Integer from 1 through 500                            |

Detail reads accept `movie` or `series` as the media kind, a positive 32-bit TMDB
identifier, and the same optional language format. Person reads accept the same bounded
identifier and language. The kind and identifier must match the normalized upstream result
exactly.

Exactly one enabled Seerr connector must exist. Zero enabled connectors returns a safe
configuration error; multiple enabled connectors fail closed because silently choosing a
service could cross an administrator's intended trust boundary. Credentials are decrypted
only inside the gateway for the duration of the request.

## Normalized response

Responses contain a bounded page of movie, series, and person results. Every result has a
stable Omnifin identifier, source label, TMDB identifier, title, and discriminated `kind`.
Movie and series results may include a year, rating, synopsis, and one of these normalized
availability states:

- `available`
- `partial`
- `requested`
- `processing`
- `unavailable`
- `unknown`

Person results may include a bounded `knownFor` summary. Poster paths, backdrop paths,
internal media identifiers, request objects, raw service errors, credentials, and unknown
upstream fields are rejected or discarded before the response crosses the gateway boundary.

## Normalized media details

Movie and series detail responses add a bounded synopsis, tagline, genres, production
status, runtime, vote summary, availability, and principal cast and crew. Series may also
include bounded season and episode-count summaries. Cast and crew are deduplicated and
limited to 12 entries each; season lists are capped at 100 entries.

The optional intelligence envelope adds at most six normalized ratings, six YouTube trailer
references, and 12 recommendations. Ratings retain an explicit 10- or 100-point scale and
distinguish TMDB, IMDb, Rotten Tomatoes critics, and Rotten Tomatoes audience values. Trailer
references contain only a validated `youtube:{video-id}` token. The browser reconstructs a
YouTube watch URL only after an explicit user action; Omnifin does not embed a third-party
player or receive a provider URL from Seerr.

Person detail responses add a bounded biography, department, birth and death dates,
birthplace, and up to 24 deduplicated movie or series credits. Cast and crew entries in a
media response carry the normalized person identifier needed to open this context. A credit
can navigate back to a normalized media detail without exposing an upstream record.

The response deliberately excludes artwork paths, Seerr media records, request objects,
service URLs, video-provider URLs, and raw TMDB or Seerr payloads. This keeps the browser
contract stable and prevents upstream implementation details from becoming identifiers
elsewhere in Omnifin.

Ratings, recommendations, and person credits are best-effort enrichment. Each collection has
an explicit `ready`, `empty`, or `unavailable` state. A timeout, invalid response, or version
shift in one optional read never hides otherwise valid core media or person details. A failed
core detail read still fails closed.

## Failure model

The public API uses the common structured error envelope with a safe code, message, and
request correlation identifier. The browser maps those responses into deliberate states:

| Condition                              | Browser behavior                            |
| -------------------------------------- | ------------------------------------------- |
| Session absent or expired              | Sign-in action without clearing the page    |
| `media.view` missing                   | Permission explanation                      |
| No unambiguous enabled Seerr connector | Configuration guidance                      |
| Upstream rate limit                    | Retryable cooling-down state                |
| Timeout or unavailable service         | Offline state; current page is preserved    |
| Invalid normalized response            | Fail-closed rejection; raw data is hidden   |
| Optional intelligence source fails     | Core detail plus a scoped unavailable state |

Search requests debounce by default for 240 milliseconds. Revising the query, closing the
console, changing the selected title, or unmounting the component aborts obsolete work.
The gateway forwards cancellation to the connector transport where possible.

## Interaction and quality contract

The search console supports `Command-K` or `Control-K`, arrow keys, Home, End, Escape,
mouse, touch, and directional focus. Desktop and 10-foot layouts pair the result list with
a stable preview pane; mobile presents a compact result-only surface so the underlying
dashboard and fixed navigation remain usable. Pointer and keyboard selection update the
same preview state without changing row geometry.

Movies and series open in a lazy-loaded Liquid Glass detail drawer. The drawer traps focus,
supports Escape and explicit close controls, keeps its header available while content
scrolls, and hands an eligible title to the guarded request composer without exposing an
upstream mutation. Ratings, trailers, related titles, cast, crew, and person credits remain
keyboard- and touch-operable; switching into person context keeps an explicit return path to
the originating title. Its mobile material increases opacity over high-contrast artwork while
retaining translucency and uses the full viewport without horizontal overflow. Recommendation
and credit rails scroll horizontally without expanding or clipping the drawer's text column.

Reusable stories cover prompt, loading, results, empty, not-configured, rate-limited,
signed-out, detail-loading, detail-offline, movie-detail, series-detail, degraded
intelligence, and person-context states.
Route-level tests cover the normalized network boundary, keyboard flow, lower-action
reachability, automated accessibility checks, reduced motion, and deterministic dark and
light desktop and mobile visual baselines.
