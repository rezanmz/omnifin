import { z } from "zod";

import { mediaReferenceIdSchema } from "./dashboard.js";

export const PLAYBACK_MAX_AUDIO_TRACKS = 64;
export const PLAYBACK_MAX_SUBTITLE_TRACKS = 128;
export const PLAYBACK_MIN_BITRATE = 64_000;
export const PLAYBACK_MAX_BITRATE = 200_000_000;

export const playbackSessionIdSchema = z.string().regex(/^playback_[A-Za-z0-9_-]{22}$/u);

const streamIndexSchema = z.int().nonnegative().max(4_095);
const languageSchema = z
  .string()
  .trim()
  .min(1)
  .max(35)
  .regex(/^[A-Za-z0-9-]+$/u)
  .nullable();
const compactTextSchema = z.string().trim().min(1).max(160).nullable();
const codecSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._+-]+$/u)
  .nullable();

export const playbackNegotiationRequestSchema = z
  .strictObject({
    audioStreamIndex: streamIndexSchema.nullable(),
    maxStreamingBitrate: z.int().min(PLAYBACK_MIN_BITRATE).max(PLAYBACK_MAX_BITRATE),
    mode: z.enum(["auto", "direct", "transcode"]),
    positionSeconds: z.int().nonnegative().max(10_000_000),
    subtitleStreamIndex: streamIndexSchema.nullable(),
  })
  .superRefine((request, context) => {
    if (
      request.audioStreamIndex !== null &&
      request.audioStreamIndex === request.subtitleStreamIndex
    ) {
      context.addIssue({
        code: "custom",
        message: "Audio and subtitle selections must identify different streams.",
        path: ["subtitleStreamIndex"],
      });
    }
  });
export type PlaybackNegotiationRequest = z.infer<typeof playbackNegotiationRequestSchema>;

export const playbackAudioTrackSchema = z.strictObject({
  channels: z.int().positive().max(64).nullable(),
  codec: codecSchema,
  commentary: z.boolean().optional(),
  default: z.boolean(),
  index: streamIndexSchema,
  language: languageSchema,
  original: z.boolean().optional(),
  selected: z.boolean(),
  title: compactTextSchema,
});
export type PlaybackAudioTrack = z.infer<typeof playbackAudioTrackSchema>;

const playbackSubtitlePathSchema = z
  .string()
  .regex(/^\/v1\/playback\/playback_[A-Za-z0-9_-]{22}\/subtitle\/\d{1,4}$/u);

export const playbackSubtitleTrackSchema = z.strictObject({
  codec: codecSchema,
  commentary: z.boolean().optional(),
  default: z.boolean(),
  delivery: z.enum(["external", "hls", "video"]),
  forced: z.boolean(),
  hearingImpaired: z.boolean().optional(),
  index: streamIndexSchema,
  language: languageSchema,
  selected: z.boolean(),
  subtitlePath: playbackSubtitlePathSchema.optional(),
  title: compactTextSchema,
});
export type PlaybackSubtitleTrack = z.infer<typeof playbackSubtitleTrackSchema>;

const streamPathSchema = z
  .string()
  .regex(/^\/v1\/playback\/playback_[A-Za-z0-9_-]{22}\/(?:master\.m3u8|stream)$/u);

export const playbackNegotiationResponseSchema = z
  .strictObject({
    audioTracks: z.array(playbackAudioTrackSchema).max(PLAYBACK_MAX_AUDIO_TRACKS),
    delivery: z.enum(["direct", "hls"]),
    expiresAt: z.iso.datetime({ offset: true }),
    media: z.strictObject({
      audioCodec: codecSchema,
      bitrate: z.int().positive().max(PLAYBACK_MAX_BITRATE).nullable(),
      container: codecSchema,
      durationSeconds: z.int().positive().max(10_000_000),
      height: z.int().positive().max(16_384).nullable(),
      videoCodec: codecSchema,
      width: z.int().positive().max(16_384).nullable(),
    }),
    mediaReferenceId: mediaReferenceIdSchema,
    positionSeconds: z.int().nonnegative().max(10_000_000),
    sessionId: playbackSessionIdSchema,
    streamPath: streamPathSchema,
    subtitleTracks: z.array(playbackSubtitleTrackSchema).max(PLAYBACK_MAX_SUBTITLE_TRACKS),
  })
  .superRefine((response, context) => {
    if (response.positionSeconds > response.media.durationSeconds) {
      context.addIssue({
        code: "custom",
        message: "The initial playback position cannot exceed the media duration.",
        path: ["positionSeconds"],
      });
    }
    const expectedSuffix = response.delivery === "hls" ? "/master.m3u8" : "/stream";
    if (
      !response.streamPath.startsWith(`/v1/playback/${response.sessionId}/`) ||
      !response.streamPath.endsWith(expectedSuffix)
    ) {
      context.addIssue({
        code: "custom",
        message: "The stream path must belong to the negotiated playback session and delivery.",
        path: ["streamPath"],
      });
    }
    for (const [name, tracks] of [
      ["audioTracks", response.audioTracks],
      ["subtitleTracks", response.subtitleTracks],
    ] as const) {
      const indexes = new Set<number>();
      let selected = 0;
      for (const [index, track] of tracks.entries()) {
        if (indexes.has(track.index)) {
          context.addIssue({
            code: "custom",
            message: "Playback track indexes must be unique within their kind.",
            path: [name, index, "index"],
          });
        }
        indexes.add(track.index);
        if (track.selected) selected += 1;
      }
      if (selected > 1) {
        context.addIssue({
          code: "custom",
          message: "At most one playback track may be selected within its kind.",
          path: [name],
        });
      }
    }
    for (const [index, track] of response.subtitleTracks.entries()) {
      if (
        track.subtitlePath !== undefined &&
        track.subtitlePath !== `/v1/playback/${response.sessionId}/subtitle/${track.index}`
      ) {
        context.addIssue({
          code: "custom",
          message: "Playback subtitle paths must belong to their own session and track.",
          path: ["subtitleTracks", index, "subtitlePath"],
        });
      }
    }
  });
export type PlaybackNegotiationResponse = z.infer<typeof playbackNegotiationResponseSchema>;

export const playbackProgressRequestSchema = z.strictObject({
  event: z.enum(["started", "progress", "paused", "stopped"]),
  positionSeconds: z.int().nonnegative().max(10_000_000),
});
export type PlaybackProgressRequest = z.infer<typeof playbackProgressRequestSchema>;

export const playbackProgressResponseSchema = z.strictObject({
  acceptedAt: z.iso.datetime({ offset: true }),
  positionSeconds: z.int().nonnegative().max(10_000_000),
  sessionId: playbackSessionIdSchema,
  state: z.enum(["playing", "paused", "stopped"]),
});
export type PlaybackProgressResponse = z.infer<typeof playbackProgressResponseSchema>;

export const PLAYBACK_PREFERENCE_MAX_LANGUAGES = 8;
export const PLAYBACK_PREFERENCE_BITRATES = [
  2_000_000, 4_000_000, 10_000_000, 20_000_000, 40_000_000, 80_000_000,
] as const;
export const playbackPreferenceBitrateSchema = z.union(
  PLAYBACK_PREFERENCE_BITRATES.map((bitrate) => z.literal(bitrate)),
);
export const playbackPreferenceLanguageSchema = z
  .string()
  .trim()
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u);

const orderedLanguagesSchema = z
  .array(playbackPreferenceLanguageSchema)
  .max(PLAYBACK_PREFERENCE_MAX_LANGUAGES)
  .superRefine((languages, context) => {
    if (new Set(languages).size !== languages.length) {
      context.addIssue({ code: "custom", message: "Preferred languages must be unique." });
    }
  });

export const playbackPreferencesSchema = z.strictObject({
  audio: z.strictObject({
    languages: orderedLanguagesSchema,
    preferOriginalLanguage: z.boolean(),
  }),
  episodes: z.strictObject({
    autoplay: z.boolean(),
    countdownSeconds: z.int().min(3).max(30),
    skipCredits: z.boolean(),
    skipIntro: z.boolean(),
    stillWatchingAfter: z.int().min(2).max(12).nullable(),
  }),
  quality: z.strictObject({
    defaultNetworkPolicy: z.enum(["auto", "home", "remote"]),
    homeMaxBitrate: playbackPreferenceBitrateSchema.nullable(),
    remoteMaxBitrate: playbackPreferenceBitrateSchema,
  }),
  schemaVersion: z.literal(1),
  subtitles: z.strictObject({
    allowCommentary: z.boolean(),
    languages: orderedLanguagesSchema,
    mode: z.enum(["off", "forced", "always", "automatic"]),
    preferForced: z.boolean(),
    preferHearingImpaired: z.boolean(),
  }),
});
export type PlaybackPreferences = z.infer<typeof playbackPreferencesSchema>;

export const DEFAULT_PLAYBACK_PREFERENCES = Object.freeze({
  audio: { languages: [], preferOriginalLanguage: true },
  episodes: {
    autoplay: false,
    countdownSeconds: 10,
    skipCredits: true,
    skipIntro: true,
    stillWatchingAfter: 3,
  },
  quality: {
    defaultNetworkPolicy: "auto",
    homeMaxBitrate: null,
    remoteMaxBitrate: 10_000_000,
  },
  schemaVersion: 1,
  subtitles: {
    allowCommentary: false,
    languages: [],
    mode: "automatic",
    preferForced: true,
    preferHearingImpaired: false,
  },
} satisfies PlaybackPreferences);

export const playbackPreferencesResponseSchema = z.strictObject({
  networkClass: z.enum(["home", "remote"]),
  preferences: playbackPreferencesSchema,
  revision: z.int().nonnegative().max(2_147_483_647),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PlaybackPreferencesResponse = z.infer<typeof playbackPreferencesResponseSchema>;

export const playbackPreferencesUpdateRequestSchema = z.strictObject({
  expectedRevision: z.int().nonnegative().max(2_147_483_646),
  preferences: playbackPreferencesSchema,
});
export type PlaybackPreferencesUpdateRequest = z.infer<
  typeof playbackPreferencesUpdateRequestSchema
>;

const playbackSessionJsonPattern = "^playback_[A-Za-z0-9_-]{22}$";
const streamIndexJsonSchema = { type: "integer", minimum: 0, maximum: 4_095 } as const;
const nullableTrackIndexJsonSchema = {
  anyOf: [streamIndexJsonSchema, { type: "null" }],
} as const;

export const playbackNegotiationRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "audioStreamIndex",
    "maxStreamingBitrate",
    "mode",
    "positionSeconds",
    "subtitleStreamIndex",
  ],
  properties: {
    audioStreamIndex: nullableTrackIndexJsonSchema,
    maxStreamingBitrate: {
      type: "integer",
      minimum: PLAYBACK_MIN_BITRATE,
      maximum: PLAYBACK_MAX_BITRATE,
    },
    mode: { enum: ["auto", "direct", "transcode"] },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
    subtitleStreamIndex: nullableTrackIndexJsonSchema,
  },
} as const;

const nullableCompactTextJsonSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 160 }, { type: "null" }],
} as const;
const nullableCodecJsonSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 32 }, { type: "null" }],
} as const;
const nullableLanguageJsonSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 35 }, { type: "null" }],
} as const;

export const playbackNegotiationResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "audioTracks",
    "delivery",
    "expiresAt",
    "media",
    "mediaReferenceId",
    "positionSeconds",
    "sessionId",
    "streamPath",
    "subtitleTracks",
  ],
  properties: {
    audioTracks: {
      type: "array",
      maxItems: PLAYBACK_MAX_AUDIO_TRACKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channels", "codec", "default", "index", "language", "selected", "title"],
        properties: {
          channels: { anyOf: [{ type: "integer", minimum: 1, maximum: 64 }, { type: "null" }] },
          codec: nullableCodecJsonSchema,
          commentary: { type: "boolean" },
          default: { type: "boolean" },
          index: streamIndexJsonSchema,
          language: nullableLanguageJsonSchema,
          original: { type: "boolean" },
          selected: { type: "boolean" },
          title: nullableCompactTextJsonSchema,
        },
      },
    },
    delivery: { enum: ["direct", "hls"] },
    expiresAt: { type: "string" },
    media: {
      type: "object",
      additionalProperties: false,
      required: [
        "audioCodec",
        "bitrate",
        "container",
        "durationSeconds",
        "height",
        "videoCodec",
        "width",
      ],
      properties: {
        audioCodec: nullableCodecJsonSchema,
        bitrate: {
          anyOf: [{ type: "integer", minimum: 1, maximum: PLAYBACK_MAX_BITRATE }, { type: "null" }],
        },
        container: nullableCodecJsonSchema,
        durationSeconds: { type: "integer", minimum: 1, maximum: 10_000_000 },
        height: {
          anyOf: [{ type: "integer", minimum: 1, maximum: 16_384 }, { type: "null" }],
        },
        videoCodec: nullableCodecJsonSchema,
        width: {
          anyOf: [{ type: "integer", minimum: 1, maximum: 16_384 }, { type: "null" }],
        },
      },
    },
    mediaReferenceId: { type: "string", pattern: "^media_[A-Za-z0-9_-]{22}$" },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
    sessionId: { type: "string", pattern: playbackSessionJsonPattern },
    streamPath: {
      type: "string",
      pattern: "^/v1/playback/playback_[A-Za-z0-9_-]{22}/(?:master\\.m3u8|stream)$",
    },
    subtitleTracks: {
      type: "array",
      maxItems: PLAYBACK_MAX_SUBTITLE_TRACKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "codec",
          "default",
          "delivery",
          "forced",
          "index",
          "language",
          "selected",
          "title",
        ],
        properties: {
          codec: nullableCodecJsonSchema,
          commentary: { type: "boolean" },
          default: { type: "boolean" },
          delivery: { enum: ["external", "hls", "video"] },
          forced: { type: "boolean" },
          hearingImpaired: { type: "boolean" },
          index: streamIndexJsonSchema,
          language: nullableLanguageJsonSchema,
          selected: { type: "boolean" },
          subtitlePath: {
            type: "string",
            pattern: "^/v1/playback/playback_[A-Za-z0-9_-]{22}/subtitle/[0-9]{1,4}$",
          },
          title: nullableCompactTextJsonSchema,
        },
      },
    },
  },
} as const;

export const playbackProgressRequestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event", "positionSeconds"],
  properties: {
    event: { enum: ["started", "progress", "paused", "stopped"] },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
  },
} as const;

export const playbackProgressResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acceptedAt", "positionSeconds", "sessionId", "state"],
  properties: {
    acceptedAt: { type: "string" },
    positionSeconds: { type: "integer", minimum: 0, maximum: 10_000_000 },
    sessionId: { type: "string", pattern: playbackSessionJsonPattern },
    state: { enum: ["playing", "paused", "stopped"] },
  },
} as const;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema, {
    io: "input",
    reused: "inline",
  });
  return jsonSchema;
}

export const playbackPreferencesResponseJsonSchema = withoutSchemaDialect(
  playbackPreferencesResponseSchema,
);
export const playbackPreferencesUpdateRequestJsonSchema = withoutSchemaDialect(
  playbackPreferencesUpdateRequestSchema,
);
