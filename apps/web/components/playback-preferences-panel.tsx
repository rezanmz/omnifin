"use client";

import {
  DEFAULT_PLAYBACK_PREFERENCES,
  type PlaybackPreferences,
  type PlaybackPreferencesResponse,
} from "@omnifin/contracts/playback";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Captions,
  Check,
  Gauge,
  Headphones,
  Languages,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  PlaybackPreferenceClientError,
  playbackPreferenceClient,
  type PlaybackPreferenceClient,
} from "../lib/playback-preferences";
import styles from "./playback-preferences-panel.module.css";

const LANGUAGE_SUGGESTIONS = [
  ["ar", "Arabic"],
  ["de", "German"],
  ["en", "English"],
  ["en-CA", "English (Canada)"],
  ["es", "Spanish"],
  ["fa", "Persian"],
  ["fr", "French"],
  ["hi", "Hindi"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
] as const;

const QUALITY_OPTIONS = [
  { bitrate: null, label: "Source / Original" },
  { bitrate: 80_000_000, label: "80 Mbps · 4K home" },
  { bitrate: 40_000_000, label: "40 Mbps · high quality" },
  { bitrate: 20_000_000, label: "20 Mbps · balanced 4K" },
  { bitrate: 10_000_000, label: "10 Mbps · balanced HD" },
  { bitrate: 4_000_000, label: "4 Mbps · data saver" },
  { bitrate: 2_000_000, label: "2 Mbps · constrained" },
] as const;

function cloneDefaults(): PlaybackPreferences {
  return JSON.parse(JSON.stringify(DEFAULT_PLAYBACK_PREFERENCES)) as PlaybackPreferences;
}

function errorMessage(error: unknown) {
  if (error instanceof PlaybackPreferenceClientError) return error.message;
  return "Playback preferences could not be loaded. Nothing was changed.";
}

function languageName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function canonicalLanguage(value: string) {
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

function OrderedLanguages({
  label,
  onChange,
  values,
}: {
  label: string;
  onChange: (languages: string[]) => void;
  values: string[];
}) {
  const [candidate, setCandidate] = useState("");
  const id = useId();
  const datalistId = `${id}-suggestions`;
  const hintId = `${id}-hint`;
  const canonicalCandidate = canonicalLanguage(candidate);
  const canAdd = Boolean(
    canonicalCandidate && !values.includes(canonicalCandidate) && values.length < 8,
  );
  const add = () => {
    if (!canonicalCandidate || !canAdd) return;
    onChange([...values, canonicalCandidate]);
    setCandidate("");
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className={styles.languages}>
      <div className={styles.languageInput}>
        <label>
          <span>{label}</span>
          <input
            aria-describedby={hintId}
            list={datalistId}
            onChange={(event) => setCandidate(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              add();
            }}
            placeholder="Add language tag · e.g. fa or en-CA"
            value={candidate}
          />
        </label>
        <button className="button button--glass" disabled={!canAdd} onClick={add} type="button">
          <Plus aria-hidden="true" /> Add
        </button>
      </div>
      <datalist id={datalistId}>
        {LANGUAGE_SUGGESTIONS.map(([value, optionLabel]) => (
          <option key={value} value={value}>
            {optionLabel}
          </option>
        ))}
      </datalist>
      <p className={styles.hint} id={hintId}>
        First match wins. Use a standard language tag; no title-specific stream indexes are stored.
      </p>
      {values.length > 0 ? (
        <ol aria-label={`${label} priority`} className={styles.languageList}>
          {values.map((value, index) => (
            <li key={value}>
              <span>
                <b>{index + 1}</b>
                <span>
                  <strong>{languageName(value)}</strong>
                  <small>{value}</small>
                </span>
              </span>
              <span className={styles.languageActions}>
                <button
                  aria-label={`Move ${languageName(value)} earlier`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  type="button"
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  aria-label={`Move ${languageName(value)} later`}
                  disabled={index === values.length - 1}
                  onClick={() => move(index, 1)}
                  type="button"
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                <button
                  aria-label={`Remove ${languageName(value)}`}
                  onClick={() => onChange(values.filter((language) => language !== value))}
                  type="button"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>
          No language priority yet. Jellyfin’s valid default will be used.
        </p>
      )}
    </div>
  );
}

function Switch({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className={styles.switch}>
      <span>
        <strong id={`${id}-label`}>{label}</strong>
        <small id={`${id}-description`}>{description}</small>
      </span>
      <input
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-label`}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        role="switch"
        type="checkbox"
      />
    </label>
  );
}

export function PlaybackPreferencesPanel({
  client = playbackPreferenceClient,
  initialResponse,
}: {
  client?: PlaybackPreferenceClient;
  initialResponse?: PlaybackPreferencesResponse;
}) {
  const [response, setResponse] = useState<PlaybackPreferencesResponse | null>(
    initialResponse ?? null,
  );
  const [draft, setDraft] = useState<PlaybackPreferences | null>(
    initialResponse?.preferences ?? null,
  );
  const [state, setState] = useState<"error" | "loading" | "ready" | "saving">(
    initialResponse ? "ready" : "loading",
  );
  const [message, setMessage] = useState("");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await client.load(signal);
        setResponse(next);
        setDraft(next.preferences);
        setState("ready");
      } catch (error) {
        setState("error");
        setMessage(errorMessage(error));
      }
    },
    [client],
  );

  useEffect(() => {
    if (initialResponse) return;
    const controller = new AbortController();
    void client
      .load(controller.signal)
      .then((next) => {
        setResponse(next);
        setDraft(next.preferences);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        setMessage(errorMessage(error));
      });
    return () => controller.abort();
  }, [client, initialResponse]);

  const dirty = useMemo(
    () =>
      Boolean(response && draft && JSON.stringify(response.preferences) !== JSON.stringify(draft)),
    [draft, response],
  );

  const save = async () => {
    if (!draft || !response || state === "saving") return;
    setState("saving");
    setMessage("");
    try {
      const saved = await client.save({ expectedRevision: response.revision, preferences: draft });
      setResponse(saved);
      setDraft(saved.preferences);
      setState("ready");
      setMessage("Playback defaults saved across your Omnifin sessions.");
    } catch (error) {
      setState("ready");
      setMessage(errorMessage(error));
    }
  };

  if (state === "loading" && !draft) {
    return (
      <main className={styles.page} id="main-content" tabIndex={-1}>
        <section aria-busy="true" className={styles.loading} role="status">
          <LoaderCircle aria-hidden="true" />
          <p>Loading your private playback profile…</p>
        </section>
      </main>
    );
  }

  if (state === "error" || !draft || !response) {
    return (
      <main className={styles.page} id="main-content" tabIndex={-1}>
        <section className={styles.error} role="alert">
          <Wifi aria-hidden="true" />
          <div>
            <p className="eyebrow">Private settings interrupted</p>
            <h1>Playback defaults are temporarily out of reach.</h1>
            <p>{message}</p>
            <button
              className="button button--primary"
              onClick={() => {
                setState("loading");
                setMessage("");
                void load();
              }}
              type="button"
            >
              <RotateCcw aria-hidden="true" /> Try again
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page} id="main-content" tabIndex={-1}>
      <header className={styles.hero}>
        <Link href="/settings">
          <ArrowLeft aria-hidden="true" /> Account &amp; access
        </Link>
        <p className="eyebrow">Your playback profile</p>
        <h1>Make every play feel familiar.</h1>
        <p>
          Omnifin stores semantic choices—languages, accessibility intent, and quality ceilings—
          never a stream index from one particular file.
        </p>
        <div className={styles.heroFacts}>
          <span>
            <Check aria-hidden="true" /> Private to this account
          </span>
          <span>
            <Languages aria-hidden="true" /> Shared across supported browsers
          </span>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <Headphones aria-hidden="true" />
            <div>
              <p className="eyebrow">Audio</p>
              <h2>Hear the right track first</h2>
            </div>
          </div>
          <Switch
            checked={draft.audio.preferOriginalLanguage}
            description="Prefer the title’s original language when Jellyfin supplies trustworthy metadata."
            label="Prefer original-language audio"
            onChange={(preferOriginalLanguage) =>
              setDraft({ ...draft, audio: { ...draft.audio, preferOriginalLanguage } })
            }
          />
          <OrderedLanguages
            label="Preferred audio languages"
            onChange={(languages) => setDraft({ ...draft, audio: { ...draft.audio, languages } })}
            values={draft.audio.languages}
          />
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <Captions aria-hidden="true" />
            <div>
              <p className="eyebrow">Subtitles</p>
              <h2>Readable, deliberate, accessible</h2>
            </div>
          </div>
          <label className={styles.field}>
            <span>Default subtitle behavior</span>
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  subtitles: {
                    ...draft.subtitles,
                    mode: event.currentTarget.value as PlaybackPreferences["subtitles"]["mode"],
                  },
                })
              }
              value={draft.subtitles.mode}
            >
              <option value="automatic">Automatic when audio does not match</option>
              <option value="forced">Forced narrative subtitles only</option>
              <option value="always">Always show a preferred subtitle</option>
              <option value="off">Off by default</option>
            </select>
          </label>
          <OrderedLanguages
            label="Preferred subtitle languages"
            onChange={(languages) =>
              setDraft({ ...draft, subtitles: { ...draft.subtitles, languages } })
            }
            values={draft.subtitles.languages}
          />
          <div className={styles.switchStack}>
            <Switch
              checked={draft.subtitles.preferForced}
              description="Favor dialogue or signs marked as forced when available."
              label="Prefer forced tracks"
              onChange={(preferForced) =>
                setDraft({ ...draft, subtitles: { ...draft.subtitles, preferForced } })
              }
            />
            <Switch
              checked={draft.subtitles.preferHearingImpaired}
              description="Favor SDH/CC tracks carrying sound and speaker cues."
              label="Prefer SDH / hearing-impaired tracks"
              onChange={(preferHearingImpaired) =>
                setDraft({ ...draft, subtitles: { ...draft.subtitles, preferHearingImpaired } })
              }
            />
            <Switch
              checked={draft.subtitles.allowCommentary}
              description="Allow clearly labelled commentary subtitles to match your language order."
              label="Allow commentary tracks"
              onChange={(allowCommentary) =>
                setDraft({ ...draft, subtitles: { ...draft.subtitles, allowCommentary } })
              }
            />
          </div>
        </section>

        <section className={`${styles.card} ${styles.qualityCard}`}>
          <div className={styles.cardHeading}>
            <Gauge aria-hidden="true" />
            <div>
              <p className="eyebrow">Quality ceilings</p>
              <h2>Protect the network, preserve the picture</h2>
            </div>
          </div>
          <label className={styles.field}>
            <span>Default network policy</span>
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  quality: {
                    ...draft.quality,
                    defaultNetworkPolicy: event.currentTarget
                      .value as PlaybackPreferences["quality"]["defaultNetworkPolicy"],
                  },
                })
              }
              value={draft.quality.defaultNetworkPolicy}
            >
              <option value="auto">Automatic · trusted network classification</option>
              <option value="home">Treat this session as home</option>
              <option value="remote">Treat this session as remote</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Home maximum</span>
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  quality: {
                    ...draft.quality,
                    homeMaxBitrate: event.currentTarget.value
                      ? (Number(event.currentTarget.value) as NonNullable<
                          PlaybackPreferences["quality"]["homeMaxBitrate"]
                        >)
                      : null,
                  },
                })
              }
              value={draft.quality.homeMaxBitrate ?? ""}
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.bitrate ?? "source"} value={option.bitrate ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Remote maximum</span>
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  quality: {
                    ...draft.quality,
                    remoteMaxBitrate: Number(
                      event.currentTarget.value,
                    ) as PlaybackPreferences["quality"]["remoteMaxBitrate"],
                  },
                })
              }
              value={draft.quality.remoteMaxBitrate}
            >
              {QUALITY_OPTIONS.filter((option) => option.bitrate !== null).map((option) => (
                <option key={option.bitrate} value={option.bitrate!}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.note}>
            This session is safely classified as <strong>{response.networkClass}</strong>. A ceiling
            guides negotiation; browser codec support and the selected source still determine direct
            play, remux, or transcode.
          </p>
        </section>
      </div>

      <footer className={styles.saveBar} data-dirty={dirty || undefined}>
        <div aria-live="polite" role="status">
          <strong>{dirty ? "Unsaved playback changes" : "Playback profile is up to date"}</strong>
          <span>
            {message ||
              (response.updatedAt
                ? `Last saved ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(response.updatedAt))}`
                : "Using Omnifin’s conservative defaults")}
          </span>
        </div>
        <div>
          <button
            aria-label="Restore defaults"
            className="button button--glass"
            disabled={state === "saving"}
            onClick={() => {
              setDraft(cloneDefaults());
              setMessage("Defaults are ready for review. Save to apply them across sessions.");
            }}
            type="button"
          >
            <RotateCcw aria-hidden="true" /> Reset
          </button>
          <button
            aria-label="Save playback profile"
            className="button button--primary"
            disabled={!dirty || state === "saving"}
            onClick={() => void save()}
            type="button"
          >
            {state === "saving" ? (
              <LoaderCircle aria-hidden="true" className={styles.spinner} />
            ) : (
              <Save aria-hidden="true" />
            )}
            {state === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </main>
  );
}
