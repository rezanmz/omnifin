"use client";

import "./request-composer.css";

import type { DiscoveryMovieResult, DiscoverySeriesResult } from "@omnifin/contracts/discovery";
import type {
  MediaRequestInput,
  MediaRequestRoutingDestination,
  MediaRequestRoutingOptionsResponse,
  MediaRequestRoutingSelection,
} from "@omnifin/contracts/requests";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Clapperboard,
  Database,
  HardDrive,
  Languages,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  SlidersHorizontal,
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

type RoutingState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; options: MediaRequestRoutingOptionsResponse }
  | { kind: "error" };

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
  routing: {
    detail: "The selected destination changed or expired. Fresh routing choices are being loaded.",
    title: "Review the request route",
  },
  routing_unavailable: {
    detail:
      "No healthy default destination matches this format. Choose an available route or ask an operator to configure one.",
    title: "No route for this request",
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

function preferredChoice<T extends { isDefault: boolean }>(choices: T[]) {
  return choices.find((choice) => choice.isDefault) ?? choices[0] ?? null;
}

function defaultRoutingSelection(
  destination: MediaRequestRoutingDestination,
): MediaRequestRoutingSelection | null {
  const qualityProfile = preferredChoice(destination.qualityProfiles);
  const rootFolder = preferredChoice(destination.rootFolders);
  if (!qualityProfile || !rootFolder) return null;
  return {
    destination: destination.id,
    languageProfile: preferredChoice(destination.languageProfiles)?.id ?? null,
    qualityProfile: qualityProfile.id,
    rootFolder: rootFolder.id,
  };
}

function readableBytes(bytes: number | null) {
  if (bytes === null) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${units[unit]}`;
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
  const [routingOpen, setRoutingOpen] = useState(false);
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [routingSelection, setRoutingSelection] = useState<MediaRequestRoutingSelection | null>(
    null,
  );
  const [routingState, setRoutingState] = useState<RoutingState>({ kind: "idle" });
  const [routingAttempt, setRoutingAttempt] = useState(0);

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

  useEffect(() => {
    if (!open || !media || eligibility.status !== "ready") return;
    const controller = new AbortController();
    void client
      .loadRoutingOptions(media.kind, is4k, controller.signal)
      .then((options) => {
        const destination = preferredChoice(options.destinations);
        const selection = destination ? defaultRoutingSelection(destination) : null;
        setRoutingSelection(selection);
        if (!selection) setRoutingEnabled(false);
        setRoutingState({ kind: "ready", options });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRoutingEnabled(false);
        setRoutingSelection(null);
        setRoutingState({ kind: "error" });
      });
    return () => controller.abort();
  }, [client, eligibility.status, is4k, media, open, routingAttempt, routingOpen]);

  if (!media) return null;

  function resetAttempt() {
    setSubmission({ kind: "idle" });
  }

  function updateFormat(nextIs4k: boolean) {
    if (submission.kind === "submitting") return;
    idempotencyKeyReference.current = null;
    setIs4k(nextIs4k);
    setRoutingSelection(null);
    setRoutingState({ kind: routingOpen ? "loading" : "idle" });
    setSubmission({ kind: "idle" });
  }

  function updateRoutingSelection(selection: MediaRequestRoutingSelection) {
    if (submission.kind === "submitting") return;
    idempotencyKeyReference.current = null;
    setRoutingEnabled(true);
    setRoutingSelection(selection);
    setSubmission({ kind: "idle" });
  }

  function useSeerrDefaults() {
    if (submission.kind === "submitting") return;
    idempotencyKeyReference.current = null;
    setRoutingEnabled(false);
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
    if (
      !media ||
      eligibility.status !== "ready" ||
      submission.kind === "submitting" ||
      routingState.kind !== "ready"
    ) {
      return;
    }
    const input: MediaRequestInput =
      media.kind === "movie"
        ? {
            is4k,
            kind: "movie",
            ...(routingEnabled && routingSelection && currentRoutingOptions
              ? { routing: routingSelection }
              : {}),
            tmdbId: media.tmdbId,
          }
        : {
            is4k,
            kind: "series",
            ...(routingEnabled && routingSelection && currentRoutingOptions
              ? { routing: routingSelection }
              : {}),
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
      if (normalized.kind === "routing") {
        setRoutingSelection(null);
        setRoutingState({ kind: "loading" });
        setRoutingAttempt((attempt) => attempt + 1);
      }
      setSubmission({ error: normalized, kind: "error" });
    }
  }

  const specificSeasonsMissing =
    media.kind === "series" && seasonMode === "specific" && seasons.length === 0;
  const currentRoutingOptions =
    routingState.kind === "ready" &&
    routingState.options.kind === media.kind &&
    routingState.options.is4k === is4k
      ? routingState.options
      : null;
  const routingIsLoading =
    routingOpen &&
    (routingState.kind === "idle" ||
      routingState.kind === "loading" ||
      (routingState.kind === "ready" && currentRoutingOptions === null));
  const selectedDestination =
    currentRoutingOptions && routingSelection
      ? (currentRoutingOptions.destinations.find(
          (destination) => destination.id === routingSelection.destination,
        ) ?? null)
      : null;
  const selectedQuality = selectedDestination?.qualityProfiles.find(
    (profile) => profile.id === routingSelection?.qualityProfile,
  );
  const automaticDestination = currentRoutingOptions?.destinations.find(
    (destination) => destination.isDefault,
  );
  const automaticQuality = automaticDestination?.qualityProfiles.find(
    (profile) => profile.isDefault,
  );
  const routingSummary =
    routingEnabled && selectedDestination && selectedQuality
      ? `${selectedDestination.label} · ${selectedQuality.label}`
      : automaticDestination && automaticQuality
        ? `Automatic · ${automaticDestination.label} · ${automaticQuality.label}`
        : "Automatic route unavailable";
  const routeUnavailable = routingEnabled
    ? !selectedDestination || !selectedQuality
    : !automaticDestination || !automaticQuality;

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
              <h3>Request received</h3>
              <p>
                {submission.creation.replayed
                  ? "The earlier successful outcome was safely recovered without creating a duplicate."
                  : submission.creation.request.status === "pending"
                    ? "Seerr received the request using your paired Jellyfin identity and is waiting for approval."
                    : "Seerr accepted the request and recorded its verified acquisition route."}
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

              <details
                className="request-composer__routing"
                onToggle={(event) => {
                  const nextOpen = event.currentTarget.open;
                  setRoutingOpen(nextOpen);
                  if (nextOpen) {
                    setRoutingEnabled(true);
                    setRoutingSelection(null);
                    setRoutingState({ kind: "loading" });
                  }
                }}
              >
                <summary>
                  <span className="request-composer__routing-icon">
                    <SlidersHorizontal aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Advanced routing</strong>
                    <small>{routingSummary}</small>
                  </span>
                  <ChevronDown aria-hidden="true" />
                </summary>

                <div className="request-composer__routing-body">
                  {routingIsLoading ? (
                    <div className="request-composer__routing-status" role="status">
                      <LoaderCircle aria-hidden="true" />
                      <span>
                        <strong>Reading request destinations</strong>
                        <small>Matching the selected format against Seerr.</small>
                      </span>
                    </div>
                  ) : routingState.kind === "error" ? (
                    <div className="request-composer__routing-status" role="status">
                      <CircleAlert aria-hidden="true" />
                      <span>
                        <strong>Routing controls are unavailable</strong>
                        <small>
                          Submission is paused until the available routes can be verified.
                        </small>
                      </span>
                      <button
                        onClick={() => {
                          setRoutingEnabled(true);
                          setRoutingState({ kind: "loading" });
                          setRoutingAttempt((attempt) => attempt + 1);
                        }}
                        type="button"
                      >
                        <RefreshCw aria-hidden="true" /> Retry
                      </button>
                    </div>
                  ) : !currentRoutingOptions ||
                    currentRoutingOptions.destinations.length === 0 ||
                    !routingSelection ? (
                    <div className="request-composer__routing-status" role="status">
                      <CircleAlert aria-hidden="true" />
                      <span>
                        <strong>No matching destinations</strong>
                        <small>
                          An operator must configure a healthy destination for this format.
                        </small>
                      </span>
                    </div>
                  ) : selectedDestination ? (
                    <>
                      <div className="request-composer__routing-heading">
                        <span>
                          <Server aria-hidden="true" />
                          Explicit route
                        </span>
                        <button onClick={useSeerrDefaults} type="button">
                          Use Seerr defaults
                        </button>
                      </div>

                      <div className="request-composer__routing-fields">
                        <label>
                          <span>
                            <Database aria-hidden="true" /> Destination
                          </span>
                          <select
                            onChange={(event) => {
                              const destination = currentRoutingOptions.destinations.find(
                                (candidate) => candidate.id === event.currentTarget.value,
                              );
                              const selection = destination
                                ? defaultRoutingSelection(destination)
                                : null;
                              if (selection) updateRoutingSelection(selection);
                            }}
                            value={routingSelection.destination}
                          >
                            {currentRoutingOptions.destinations.map((destination) => (
                              <option key={destination.id} value={destination.id}>
                                {destination.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          <span>
                            <SlidersHorizontal aria-hidden="true" /> Quality profile
                          </span>
                          <select
                            onChange={(event) =>
                              updateRoutingSelection({
                                ...routingSelection,
                                qualityProfile: event.currentTarget.value,
                              })
                            }
                            value={routingSelection.qualityProfile}
                          >
                            {selectedDestination.qualityProfiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          <span>
                            <HardDrive aria-hidden="true" /> Root folder
                          </span>
                          <select
                            onChange={(event) =>
                              updateRoutingSelection({
                                ...routingSelection,
                                rootFolder: event.currentTarget.value,
                              })
                            }
                            value={routingSelection.rootFolder}
                          >
                            {selectedDestination.rootFolders.map((folder) => {
                              const available = readableBytes(folder.availableBytes);
                              return (
                                <option key={folder.id} value={folder.id}>
                                  {folder.label}
                                  {available ? ` · ${available} free` : ""}
                                </option>
                              );
                            })}
                          </select>
                        </label>

                        {selectedDestination.languageProfiles.length > 0 ? (
                          <label>
                            <span>
                              <Languages aria-hidden="true" /> Language profile
                            </span>
                            <select
                              onChange={(event) =>
                                updateRoutingSelection({
                                  ...routingSelection,
                                  languageProfile: event.currentTarget.value,
                                })
                              }
                              value={routingSelection.languageProfile ?? ""}
                            >
                              {selectedDestination.languageProfiles.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>

                      <p className="request-composer__routing-note">
                        <LockKeyhole aria-hidden="true" /> Choices expire shortly and are valid only
                        for your session. Storage paths stay inside the gateway.
                      </p>
                      {currentRoutingOptions.failures.length > 0 ? (
                        <p className="request-composer__routing-warning" role="status">
                          <CircleAlert aria-hidden="true" /> Some Seerr destinations did not
                          respond. Available routes remain selectable.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </details>

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
                  disabled={
                    specificSeasonsMissing ||
                    routingState.kind !== "ready" ||
                    routeUnavailable ||
                    submission.kind === "submitting"
                  }
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
