/**
 * Subtitle rendering tiers for the theater player.
 *
 * Tier 0 — "native": masked WebVTT served by the gateway (Jellyfin
 * `Subtitles/{index}/Stream.vtt`) and attached as a browser `<track>` element.
 * Native TextTrack parses WebVTT only, so only codecs whose Stream.vtt
 * conversion is reliable may land here.
 *
 * Tier 3 — "burn-in": the track is selected through playback negotiation so
 * the server transcodes it into the picture. Used for image subtitles
 * (pgssub/dvdsub) and text formats whose Stream.vtt conversion is unreliable
 * or unavailable (ass/ssa/sami/smi/mov_text), plus HLS-manifest tracks that
 * cannot be masked.
 *
 * Reserved future tiers (not implemented): "overlay" (client-rendered
 * SSA/ASS) and "srt-normalization" (client-side SRT→WebVTT conversion).
 */
export type SubtitleTier = "burn-in" | "native";

export interface PlayerSubtitleTrack {
  codec: string | null;
  delivery: "external" | "hls" | "video";
}

/** Codecs whose gateway Stream.vtt conversion produces reliable WebVTT. */
const NATIVE_SUBTITLE_CODECS = new Set(["srt", "subrip", "vtt", "webvtt"]);

export function resolveSubtitleTier(track: PlayerSubtitleTrack): SubtitleTier {
  if (track.delivery === "hls") return "burn-in";
  const codec = track.codec?.toLowerCase();
  return codec !== undefined && codec !== null && NATIVE_SUBTITLE_CODECS.has(codec)
    ? "native"
    : "burn-in";
}
