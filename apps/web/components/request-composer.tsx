"use client";

import type { DiscoveryMovieResult, DiscoverySeriesResult } from "@omnifin/contracts/discovery";
import type { MediaRequestInput } from "@omnifin/contracts/requests";
import {
  BadgeCheck,
  Check,
  CircleAlert,
  Clapperboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  MediaRequestClientError,
  createMediaRequestIdempotencyKey,
  mediaRequestClient,
  type MediaRequestClient,
  type MediaRequestCreation,
  type MediaRequestEligibility,
} from "../lib/media-requests";

export type RequestableMedia = DiscoveryMovieResult | DiscoverySeriesResult;

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { creation: MediaRequestCreation; kind: "success" }
  | { error: MediaRequestClientError; kind: "error" };

export interface RequestComposerProperties {
  client?: MediaRequestClient;
  media: RequestableMedia | null;
  onCreated?: (creation: MediaRequestCreation) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const ELIGIBILITY_COPY: Record<
  Exclude<MediaRequestEligibility["status"], "ready">,
  { action: string | null; detail: string; title: string }
> = {
  forbidden: {
    action: null,
    detail: "Your current role can browse media, but it cannot create acquisition requests.",
    title: "Requester access required",
  },
  link_required: {
    action: "Link Jellyfin account",
    detail: "Pair your own Jellyfin identity so Seerr can preserve your permissions and quotas.",
    title: "Finish account pairing",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before any request details were sent.",
    title: "Sign in to continue",
  },
  unavailable: {
    action: "Try again",
    detail: "The gateway could not verify your session. Your selections are still here.",
    title: "Identity check is offline",
  },
};

const ERROR_COPY: Record<MediaRequestClientError["kind"], { detail: string; title: string }> = {
  already_exists: {
    detail: "Seerr already has a matching request. The existing acquisition remains unchanged.",
    title: "Already requested",
  },
  configuration: {
    detail: "The Seerr connection is not ready for safe writes. An operator can check its health.",
    title: "Request path unavailable",
  },
  denied: {
    detail: "Seerr declined this request for your linked Jellyfin identity.",
    title: "Request not permitted",
  },
  forbidden: {
    detail: "Your role changed before the request was submitted.",
    title: "Permission changed",
  },
  identity: {
    detail: "The paired Jellyfin identity could not be matched safely in Seerr.",
    title: "Identity needs attention",
  },
  invalid_response: {
    detail: "The response did not match Omnifin’s public contract, so it was not displayed.",
    title: "Response rejected",
  },
  no_seasons: {
    detail: "Every selected season is already available or requested.",
    title: "No seasons to request",
  },
  pending: {
    detail: "The original attempt may still be settling. Retrying uses the same request identity.",
    title: "Outcome still pending",
  },
  rate_limited: {
    detail: "The request limit was reached. Wait a moment, then begin a fresh attempt.",
    title: "Requests are cooling down",
  },
  signed_out: {
    detail: "Your session ended before the request could be confirmed.",
    title: "Session ended",
  },
  unavailable: {
    detail: "The gateway or Seerr could not complete the request. No duplicate will be created.",
    title: "Request interrupted",
  },
};

function resultMeta(media: RequestableMedia) {
  return [media.kind === "movie" ? "Movie" : "Series", media.year]
    .filter((value) => value !== null)
    .join(" · ");
}

function initialEligibility(): MediaRequestEligibility | { status: "loading" } {
  return { status: "loading" };
}

function RequestComposerSkeleton() {
  return (
    <div aria-label="Checking request access" className="request-composer__skeleton" role="status">
      <span />
      <div>
        <i />
        <i />
      </div>
      <div>
        <i />
        <i />
        <i />
      </div>
      <span className="sr-only">Checking your request permissions and linked identity.</span>
    </div>
  );
}

export function RequestComposer({
  client = mediaRequestClient,
  media,
  onCreated,
  onOpenChange,
  open,
}: RequestComposerProperties) {
  const dialogReference = useRef<HTMLDialogElement>(null);
  const idempotencyKeyReference = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [eligibility, setEligibility] = useState<MediaRequestEligibility | { status: "loading" }>(
    initialEligibility,
  );
  const [eligibilityAttempt, setEligibilityAttempt] = useState(0);
  const [is4k, setIs4k] = useState(false);
  const [seasonMode, setSeasonMode] = useState<"all" | "specific">("all");
  const [seasons, setSeasons] = useState<number[]>([]);
  const [seasonDraft, setSeasonDraft] = useState("1");
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });

  useEffect(() => {
    const dialog = dialogReference.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !media) return;
    const controller = new AbortController();
    void client
      .loadEligibility(controller.signal)
      .then(setEligibility)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setEligibility({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [client, eligibilityAttempt, media, open]);

  if (!media) return null;

  function resetAttempt() {
    setSubmission({ kind: "idle" });
  }

  function updateFormat(nextIs4k: boolean) {
    if (submission.kind === "submitting") return;
    idempotencyKeyReference.current = null;
    setIs4k(nextIs4k);
    setSubmission({ kind: "idle" });
  }

  function updateSeasonMode(mode: "all" | "specific") {
    if (submission.kind === "submitting") return;
    idempotencyKeyReference.current = null;
    setSeasonMode(mode);
    setSubmission({ kind: "idle" });
  }

  function addSeason() {
    const value = Number(seasonDraft);
    if (!Number.isInteger(value) || value < 0 || value > 10_000 || seasons.includes(value)) return;
    idempotencyKeyReference.current = null;
    setSeasons((current) => [...current, value].sort((left, right) => left - right));
    setSeasonDraft(String(value + 1));
    setSubmission({ kind: "idle" });
  }

  function removeSeason(season: number) {
    idempotencyKeyReference.current = null;
    setSeasons((current) => current.filter((candidate) => candidate !== season));
    setSubmission({ kind: "idle" });
  }

  async function submit() {
    if (!media || eligibility.status !== "ready" || submission.kind === "submitting") return;
    const input: MediaRequestInput =
      media.kind === "movie"
        ? { is4k, kind: "movie", tmdbId: media.tmdbId }
        : {
            is4k,
            kind: "series",
            seasons: seasonMode === "all" ? "all" : seasons,
            tmdbId: media.tmdbId,
          };
    if (input.kind === "series" && Array.isArray(input.seasons) && input.seasons.length === 0) {
      return;
    }
    idempotencyKeyReference.current ??= createMediaRequestIdempotencyKey();
    setSubmission({ kind: "submitting" });
    try {
      const creation = await client.create(input, {
        csrfToken: eligibility.snapshot.csrfToken,
        idempotencyKey: idempotencyKeyReference.current,
      });
      setSubmission({ creation, kind: "success" });
      onCreated?.(creation);
    } catch (error) {
      const normalized =
        error instanceof MediaRequestClientError
          ? error
          : new MediaRequestClientError(
              "unavailable",
              "request_failed",
              "The request could not be completed.",
              "same_key",
            );
      if (normalized.retryMode === "new_key") idempotencyKeyReference.current = null;
      setSubmission({ error: normalized, kind: "error" });
    }
  }

  const specificSeasonsMissing =
    media.kind === "series" && seasonMode === "specific" && seasons.length === 0;

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="request-composer"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onOpenChange(false);
      }}
      ref={dialogReference}
    >
      <div className="request-composer__glass">
        <div className="request-composer__header">
          <div>
            <span className="request-composer__eyebrow">
              <Radio aria-hidden="true" /> Acquisition request
            </span>
            <h2 id={titleId}>Compose request</h2>
          </div>
          <button
            aria-label="Close request composer"
            className="request-composer__close"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="request-composer__body">
          <section className="request-composer__media" aria-label="Selected title">
            <div aria-hidden="true" className="request-composer__art">
              <span />
              <i>{media.title.slice(0, 1)}</i>
            </div>
            <div>
              <span>{resultMeta(media)}</span>
              <h3>{media.title}</h3>
              <p id={descriptionId}>
                Review the exact request before it is delegated through your linked Jellyfin
                identity.
              </p>
            </div>
          </section>

          {eligibility.status === "loading" ? (
            <RequestComposerSkeleton />
          ) : eligibility.status !== "ready" ? (
            <section className="request-composer__gate" role="status">
              <span className="request-composer__gate-icon">
                {eligibility.status === "link_required" ? (
                  <Link2 aria-hidden="true" />
                ) : (
                  <LockKeyhole aria-hidden="true" />
                )}
              </span>
              <span>Identity gate</span>
              <h3>{ELIGIBILITY_COPY[eligibility.status].title}</h3>
              <p>{ELIGIBILITY_COPY[eligibility.status].detail}</p>
              {eligibility.status === "unavailable" ? (
                <button
                  className="request-composer__primary"
                  onClick={() => {
                    setEligibility(initialEligibility());
                    setEligibilityAttempt((attempt) => attempt + 1);
                  }}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" /> Try again
                </button>
              ) : eligibility.status === "signed_out" ? (
                <a className="request-composer__primary" href="/login">
                  Sign in
                </a>
              ) : eligibility.status === "link_required" ? (
                <a className="request-composer__primary" href="/link/jellyfin">
                  <Link2 aria-hidden="true" /> Link Jellyfin account
                </a>
              ) : null}
            </section>
          ) : submission.kind === "success" ? (
            <section className="request-composer__success" role="status">
              <span className="request-composer__success-mark">
                <Check aria-hidden="true" />
              </span>
              <span>Request {submission.creation.request.status}</span>
              <h3>The signal is in motion</h3>
              <p>
                {submission.creation.replayed
                  ? "The earlier successful outcome was safely recovered without creating a duplicate."
                  : "Seerr accepted the request using your paired Jellyfin identity."}
              </p>
              <dl>
                <div>
                  <dt>Request</dt>
                  <dd>{submission.creation.request.id.replace("request:", "#")}</dd>
                </div>
                <div>
                  <dt>Profile</dt>
                  <dd>{submission.creation.request.is4k ? "4K" : "Standard"}</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{submission.creation.request.status}</dd>
                </div>
              </dl>
              <button
                className="request-composer__primary"
                onClick={() => onOpenChange(false)}
                type="button"
              >
                Done
              </button>
            </section>
          ) : (
            <form
              className="request-composer__form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="request-composer__identity">
                <BadgeCheck aria-hidden="true" />
                <span>
                  <small>Requesting as</small>
                  <strong>{eligibility.snapshot.jellyfinDisplayName}</strong>
                </span>
                <i>{eligibility.snapshot.principal.role}</i>
              </div>

              <fieldset className="request-composer__field">
                <legend>Quality profile</legend>
                <div className="request-composer__segments">
                  <button aria-pressed={!is4k} onClick={() => updateFormat(false)} type="button">
                    <Clapperboard aria-hidden="true" />
                    <span>
                      <strong>Standard</strong>
                      <small>Fastest match</small>
                    </span>
                  </button>
                  <button aria-pressed={is4k} onClick={() => updateFormat(true)} type="button">
                    <Sparkles aria-hidden="true" />
                    <span>
                      <strong>4K</strong>
                      <small>When available</small>
                    </span>
                  </button>
                </div>
              </fieldset>

              {media.kind === "series" ? (
                <fieldset className="request-composer__field">
                  <legend>Episodes</legend>
                  <div className="request-composer__segments request-composer__segments--compact">
                    <button
                      aria-pressed={seasonMode === "all"}
                      onClick={() => updateSeasonMode("all")}
                      type="button"
                    >
                      <span>
                        <strong>All available</strong>
                        <small>Entire series</small>
                      </span>
                    </button>
                    <button
                      aria-pressed={seasonMode === "specific"}
                      onClick={() => updateSeasonMode("specific")}
                      type="button"
                    >
                      <span>
                        <strong>Specific</strong>
                        <small>Choose seasons</small>
                      </span>
                    </button>
                  </div>
                  {seasonMode === "specific" ? (
                    <div className="request-composer__season-picker">
                      <label htmlFor={`${titleId}-season`}>Season number</label>
                      <div>
                        <input
                          id={`${titleId}-season`}
                          inputMode="numeric"
                          max={10_000}
                          min={0}
                          onChange={(event) => setSeasonDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addSeason();
                            }
                          }}
                          type="number"
                          value={seasonDraft}
                        />
                        <button onClick={addSeason} type="button">
                          <Plus aria-hidden="true" /> Add
                        </button>
                      </div>
                      {seasons.length > 0 ? (
                        <div
                          aria-label="Selected seasons"
                          className="request-composer__season-chips"
                        >
                          {seasons.map((season) => (
                            <button
                              aria-label={`Remove season ${season}`}
                              key={season}
                              onClick={() => removeSeason(season)}
                              type="button"
                            >
                              S{String(season).padStart(2, "0")} <X aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p role="status">Add at least one season to continue.</p>
                      )}
                    </div>
                  ) : null}
                </fieldset>
              ) : null}

              {submission.kind === "error" ? (
                <div className="request-composer__error" role="alert">
                  <CircleAlert aria-hidden="true" />
                  <div>
                    <strong>{ERROR_COPY[submission.error.kind].title}</strong>
                    <span>{ERROR_COPY[submission.error.kind].detail}</span>
                  </div>
                  {submission.error.retryMode === "none" ? null : (
                    <button onClick={resetAttempt} type="button">
                      Review
                    </button>
                  )}
                </div>
              ) : null}

              <div className="request-composer__footer">
                <p>
                  <LockKeyhole aria-hidden="true" /> Your upstream credentials never enter this
                  browser.
                </p>
                <button
                  className="request-composer__primary"
                  disabled={specificSeasonsMissing || submission.kind === "submitting"}
                  type="submit"
                >
                  {submission.kind === "submitting" ? (
                    <>
                      <LoaderCircle aria-hidden="true" /> Sending securely…
                    </>
                  ) : (
                    <>
                      Send request <Sparkles aria-hidden="true" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}
