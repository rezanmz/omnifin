import { playbackSourceReferenceIdSchema } from "@omnifin/contracts/playback";

import { constantTimeTextEqual, privacyHash } from "../security/crypto.js";

const MEDIA_REFERENCE_PATTERN = /^media_[A-Za-z0-9_-]{22}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function playbackSourceReferenceId(
  encryptionKey: Buffer,
  mediaReferenceId: string,
  sourceId: string,
) {
  if (!MEDIA_REFERENCE_PATTERN.test(mediaReferenceId) || !SOURCE_ID_PATTERN.test(sourceId)) {
    throw new TypeError("Playback source reference input is invalid.");
  }
  return playbackSourceReferenceIdSchema.parse(
    `source_${privacyHash("playback_source", `${mediaReferenceId}\0${sourceId}`, encryptionKey)}`,
  );
}

export function matchesPlaybackSourceReference(
  encryptionKey: Buffer,
  mediaReferenceId: string,
  requestedReferenceId: string,
  sourceId: string,
) {
  const requested = playbackSourceReferenceIdSchema.safeParse(requestedReferenceId);
  if (!requested.success) return false;
  try {
    return constantTimeTextEqual(
      requested.data,
      playbackSourceReferenceId(encryptionKey, mediaReferenceId, sourceId),
    );
  } catch {
    return false;
  }
}
