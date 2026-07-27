# Discovery

Omnifin's first media workflow is a read-only global search backed by one enabled Seerr
connector. The gateway owns upstream credentials and response normalization; the browser
never receives a Seerr API key or an unvalidated upstream payload.

This is a pre-release development surface, not a public Seerr compatibility claim. The
[compatibility matrix](compatibility.md) remains authoritative for supported versions.

## Request path and authorization

The browser calls the same-origin `GET /api/discovery/search` route. The web process
forwards the request to `GET /v1/discovery/search` on the private gateway and forwards
only the opaque session cookie. The gateway requires an active principal with
`media.view` before it reads connector configuration or contacts Seerr.

The query contract is deliberately bounded:

| Parameter  | Requirement                                           |
| ---------- | ----------------------------------------------------- |
| `query`    | Trimmed text between 2 and 200 characters             |
| `language` | BCP 47-style two-letter language with optional region |
| `page`     | Integer from 1 through 500                            |

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

## Failure model

The public API uses the common structured error envelope with a safe code, message, and
request correlation identifier. The browser maps those responses into deliberate states:

| Condition                              | Browser behavior                          |
| -------------------------------------- | ----------------------------------------- |
| Session absent or expired              | Sign-in action without clearing the page  |
| `media.view` missing                   | Permission explanation                    |
| No unambiguous enabled Seerr connector | Configuration guidance                    |
| Upstream rate limit                    | Retryable cooling-down state              |
| Timeout or unavailable service         | Offline state; current page is preserved  |
| Invalid normalized response            | Fail-closed rejection; raw data is hidden |

Search requests debounce by default for 240 milliseconds. Revising the query, closing the
console, or unmounting the component aborts obsolete work. The gateway forwards cancellation
to the connector transport where possible.

## Interaction and quality contract

The search console supports `Command-K` or `Control-K`, arrow keys, Home, End, Escape,
mouse, touch, and directional focus. Desktop and 10-foot layouts pair the result list with
a stable preview pane; mobile presents a compact result-only surface so the underlying
dashboard and fixed navigation remain usable. Pointer and keyboard selection update the
same preview state without changing row geometry.

Reusable stories cover prompt, loading, results, empty, not-configured, rate-limited, and
signed-out states. Route-level tests cover the normalized network boundary, keyboard flow,
automated accessibility checks, reduced motion, and deterministic desktop and mobile visual
baselines.
