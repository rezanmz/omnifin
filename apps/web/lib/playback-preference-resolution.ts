import type {
  PlaybackAudioTrack,
  PlaybackNegotiationResponse,
  PlaybackPreferences,
  PlaybackSubtitleTrack,
} from "@omnifin/contracts/playback";

const ISO_639_3_TO_1: Readonly<Record<string, string>> = Object.freeze({
  ara: "ar",
  chi: "zh",
  deu: "de",
  dut: "nl",
  eng: "en",
  fas: "fa",
  fin: "fi",
  fra: "fr",
  fre: "fr",
  ger: "de",
  hin: "hi",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nld: "nl",
  nor: "no",
  per: "fa",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  spa: "es",
  swe: "sv",
  tur: "tr",
  ukr: "uk",
  zho: "zh",
});

const COMMENTARY_LABEL = /\b(?:audio\s+)?commentary\b|\bdirector(?:'s)?\s+track\b/iu;
const HEARING_IMPAIRED_LABEL = /\b(?:sdh|cc|closed captions?|hoh|hearing[ -]impaired)\b/iu;
const ORIGINAL_LABEL = /\boriginal(?:\s+(?:audio|language|version))?\b/iu;

function normalizedLanguage(language: string | null) {
  if (!language) return null;
  const normalized = language.trim().replaceAll("_", "-").toLowerCase();
  if (!/^[a-z0-9-]{1,35}$/u.test(normalized)) return null;
  const [primary, ...rest] = normalized.split("-");
  if (!primary) return null;
  return [ISO_639_3_TO_1[primary] ?? primary, ...rest].join("-");
}

function languageRank(language: string | null, preferences: readonly string[]) {
  const normalized = normalizedLanguage(language);
  if (!normalized) return Number.POSITIVE_INFINITY;
  const base = normalized.split("-")[0];
  let best = Number.POSITIVE_INFINITY;
  for (const [index, preference] of preferences.entries()) {
    const preferred = normalizedLanguage(preference);
    if (!preferred) continue;
    if (normalized === preferred) best = Math.min(best, index * 2);
    else if (base === preferred.split("-")[0]) best = Math.min(best, index * 2 + 1);
  }
  return best;
}

function labelled(track: { title: string | null }, pattern: RegExp) {
  return pattern.test(track.title ?? "");
}

function commentary(track: { commentary?: boolean | undefined; title: string | null }) {
  return track.commentary === true || labelled(track, COMMENTARY_LABEL);
}

function hearingImpaired(track: PlaybackSubtitleTrack) {
  return track.hearingImpaired === true || labelled(track, HEARING_IMPAIRED_LABEL);
}

function isOriginal(track: PlaybackAudioTrack) {
  return track.original === true || labelled(track, ORIGINAL_LABEL);
}

function fallbackAudio(tracks: readonly PlaybackAudioTrack[]) {
  return (
    tracks.find((track) => track.selected && !commentary(track)) ??
    tracks.find((track) => track.default && !commentary(track)) ??
    tracks.find((track) => !commentary(track)) ??
    tracks.find((track) => track.selected) ??
    tracks.find((track) => track.default) ??
    tracks[0] ??
    null
  );
}

function audioSelection(tracks: readonly PlaybackAudioTrack[], preferences: PlaybackPreferences) {
  const fallback = fallbackAudio(tracks);
  const candidates = tracks.filter((track) => !commentary(track));
  const originalMatch = preferences.audio.preferOriginalLanguage
    ? candidates.find((track) => isOriginal(track))
    : undefined;
  const languageMatch = [...candidates]
    .map((track, sourceOrder) => ({
      rank: languageRank(track.language, preferences.audio.languages),
      sourceOrder,
      track,
    }))
    .filter((candidate) => Number.isFinite(candidate.rank))
    .sort(
      (left, right) => left.rank - right.rank || left.sourceOrder - right.sourceOrder,
    )[0]?.track;
  const selected = originalMatch ?? languageMatch ?? fallback;
  const reason = originalMatch
    ? "Original-language audio matched the account default."
    : languageMatch
      ? `Audio matched ${languageMatch.language ?? "the first preferred language"}.`
      : selected
        ? "No preferred audio matched; Jellyfin’s valid default was kept."
        : "This source did not advertise a selectable audio track.";
  return { reason, track: selected };
}

function subtitleRoleRank(track: PlaybackSubtitleTrack, preferences: PlaybackPreferences) {
  const forced = track.forced;
  const isHearingImpaired = hearingImpaired(track);
  return (
    (preferences.subtitles.preferForced && forced ? -4 : 0) +
    (preferences.subtitles.preferHearingImpaired && isHearingImpaired ? -2 : 0) +
    (commentary(track) ? 8 : 0)
  );
}

function rankedSubtitles(
  tracks: readonly PlaybackSubtitleTrack[],
  preferences: PlaybackPreferences,
  forcedOnly: boolean,
) {
  return tracks
    .filter(
      (track) =>
        (!forcedOnly || track.forced) &&
        (preferences.subtitles.allowCommentary || !commentary(track)),
    )
    .map((track, sourceOrder) => ({
      language: languageRank(track.language, preferences.subtitles.languages),
      role: subtitleRoleRank(track, preferences),
      sourceOrder,
      track,
    }))
    .sort((left, right) => {
      const leftLanguage = Number.isFinite(left.language) ? left.language : 10_000;
      const rightLanguage = Number.isFinite(right.language) ? right.language : 10_000;
      return (
        leftLanguage - rightLanguage ||
        left.role - right.role ||
        Number(right.track.selected) - Number(left.track.selected) ||
        Number(right.track.default) - Number(left.track.default) ||
        left.sourceOrder - right.sourceOrder
      );
    });
}

function subtitleSelection(
  tracks: readonly PlaybackSubtitleTrack[],
  audio: PlaybackAudioTrack | null,
  preferences: PlaybackPreferences,
) {
  const mode = preferences.subtitles.mode;
  if (mode === "off") return { reason: "Subtitles are off in the account default.", track: null };
  const audioMatches = Number.isFinite(
    languageRank(audio?.language ?? null, preferences.audio.languages),
  );
  const forcedOnly =
    mode === "forced" ||
    (mode === "automatic" && (preferences.audio.languages.length === 0 || audioMatches));
  const ranked = rankedSubtitles(tracks, preferences, forcedOnly);
  const preferred = ranked.find((candidate) => Number.isFinite(candidate.language))?.track;
  const fallback =
    ranked.find((candidate) => candidate.track.selected)?.track ??
    ranked.find((candidate) => candidate.track.default)?.track ??
    ranked[0]?.track ??
    null;
  const selected = preferred ?? fallback;
  const reason = selected
    ? forcedOnly
      ? selected.forced
        ? "A forced subtitle matched the current audio policy."
        : "No forced subtitle was available; subtitles remain off."
      : preferred
        ? `Subtitles matched ${preferred.language ?? "the first preferred language"}.`
        : "No preferred subtitle matched; Jellyfin’s valid default was kept."
    : forcedOnly
      ? "No forced subtitle matched, so subtitles remain off."
      : "This source did not advertise a suitable subtitle track.";
  return { reason, track: forcedOnly && selected && !selected.forced ? null : selected };
}

export interface ResolvedPlaybackPreferences {
  audioStreamIndex: number | null;
  effectiveAudioStreamIndex: number | null;
  effectiveNetworkClass: "home" | "remote";
  explanations: { audio: string; quality: string; subtitles: string };
  maxStreamingBitrate: number;
  subtitleStreamIndex: number | null;
}

export function resolvePlaybackPreferences(
  preferences: PlaybackPreferences,
  networkClass: "home" | "remote",
  session: Pick<PlaybackNegotiationResponse, "audioTracks" | "subtitleTracks">,
): ResolvedPlaybackPreferences {
  const effectiveNetworkClass =
    preferences.quality.defaultNetworkPolicy === "auto"
      ? networkClass
      : preferences.quality.defaultNetworkPolicy;
  const maxStreamingBitrate =
    effectiveNetworkClass === "home"
      ? (preferences.quality.homeMaxBitrate ?? 200_000_000)
      : preferences.quality.remoteMaxBitrate;
  const audio = audioSelection(session.audioTracks, preferences);
  const subtitles = subtitleSelection(session.subtitleTracks, audio.track, preferences);
  const audioIsDefault = Boolean(audio.track?.selected || audio.track?.default);
  return {
    audioStreamIndex: audio.track && !audioIsDefault ? audio.track.index : null,
    effectiveAudioStreamIndex: audio.track?.index ?? null,
    effectiveNetworkClass,
    explanations: {
      audio: audio.reason,
      quality:
        maxStreamingBitrate === 200_000_000
          ? `Source quality is allowed on the ${effectiveNetworkClass} network policy.`
          : `${Math.round(maxStreamingBitrate / 1_000_000)} Mbps ${effectiveNetworkClass} ceiling applied.`,
      subtitles: subtitles.reason,
    },
    maxStreamingBitrate,
    subtitleStreamIndex: subtitles.track?.index ?? null,
  };
}
