import { z } from "zod";

import { acquisitionServiceSchema } from "./acquisition.js";
import { partialFailureSchema, type PartialFailure } from "./connectors.js";

export const ACQUISITION_CALENDAR_MAX_EVENTS = 100;
export const ACQUISITION_CALENDAR_MAX_SOURCES = 20;
export const ACQUISITION_CALENDAR_MAX_WINDOW_DAYS = 62;

const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const timestampSchema = z.iso.datetime({ offset: true });

export const acquisitionCalendarCursorSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+$/u);
export type AcquisitionCalendarCursor = z.infer<typeof acquisitionCalendarCursorSchema>;

export const acquisitionCalendarQuerySchema = z
  .strictObject({
    cursor: acquisitionCalendarCursorSchema.optional(),
    end: timestampSchema,
    limit: z.coerce.number().int().positive().max(ACQUISITION_CALENDAR_MAX_EVENTS).default(50),
    start: timestampSchema,
  })
  .superRefine((query, context) => {
    const start = Date.parse(query.start);
    const end = Date.parse(query.end);
    if (end <= start) {
      context.addIssue({
        code: "custom",
        message: "Calendar range end must follow its start.",
        path: ["end"],
      });
    }
    if (end - start > ACQUISITION_CALENDAR_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: `Calendar ranges cannot exceed ${ACQUISITION_CALENDAR_MAX_WINDOW_DAYS} days.`,
        path: ["end"],
      });
    }
  });
export type AcquisitionCalendarQuery = z.infer<typeof acquisitionCalendarQuerySchema>;

export const acquisitionCalendarEventIdSchema = z.string().regex(/^calendar_[A-Za-z0-9_-]{22}$/u);
export const acquisitionCalendarSourceIdSchema = z
  .string()
  .regex(/^calendar_source_[A-Za-z0-9_-]{22}$/u);

export const acquisitionCalendarReleaseKindSchema = z.enum([
  "cinema",
  "digital",
  "episode",
  "physical",
  "unknown",
]);
export type AcquisitionCalendarReleaseKind = z.infer<typeof acquisitionCalendarReleaseKindSchema>;

export const acquisitionCalendarAvailabilitySchema = z.enum([
  "available",
  "missing",
  "monitored",
  "unknown",
]);
export type AcquisitionCalendarAvailability = z.infer<typeof acquisitionCalendarAvailabilitySchema>;

export const acquisitionCalendarEventSchema = z
  .strictObject({
    availability: acquisitionCalendarAvailabilitySchema,
    endAt: timestampSchema.nullable(),
    episodeNumber: z.int().nonnegative().max(100_000).nullable(),
    eventAt: timestampSchema,
    id: acquisitionCalendarEventIdSchema,
    kind: z.enum(["episode", "movie"]),
    monitored: z.boolean(),
    overview: safeTextSchema.max(2_000).nullable(),
    releaseKind: acquisitionCalendarReleaseKindSchema,
    runtimeMinutes: z.int().positive().max(100_000).nullable(),
    seasonNumber: z.int().nonnegative().max(100_000).nullable(),
    service: acquisitionServiceSchema,
    sourceId: acquisitionCalendarSourceIdSchema,
    sourceName: safeTextSchema.max(160),
    subtitle: safeTextSchema.max(300).nullable(),
    title: safeTextSchema.max(300),
    year: z.int().min(1870).max(2200).nullable(),
  })
  .superRefine((event, context) => {
    if (event.endAt !== null && Date.parse(event.endAt) <= Date.parse(event.eventAt)) {
      context.addIssue({
        code: "custom",
        message: "Calendar event end must follow its start.",
        path: ["endAt"],
      });
    }
    if (event.kind === "movie") {
      if (
        event.service !== "radarr" ||
        event.releaseKind === "episode" ||
        event.seasonNumber !== null ||
        event.episodeNumber !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Movie calendar events must use Radarr movie semantics.",
          path: ["kind"],
        });
      }
    } else if (
      event.service !== "sonarr" ||
      event.releaseKind !== "episode" ||
      event.seasonNumber === null ||
      event.episodeNumber === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Episode calendar events must use Sonarr episode semantics.",
        path: ["kind"],
      });
    }
  });
export type AcquisitionCalendarEvent = z.infer<typeof acquisitionCalendarEventSchema>;

export const acquisitionCalendarSourceSchema = z
  .strictObject({
    displayName: safeTextSchema.max(160),
    eventCount: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
    failure: partialFailureSchema.nullable(),
    id: acquisitionCalendarSourceIdSchema,
    service: acquisitionServiceSchema,
    status: z.enum(["healthy", "unavailable"]),
  })
  .superRefine((source, context) => {
    if ((source.status === "healthy") !== (source.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable calendar sources must include one safe failure.",
        path: ["failure"],
      });
    }
    if (source.failure && source.failure.service !== source.service) {
      context.addIssue({
        code: "custom",
        message: "Calendar source failures must identify the same service.",
        path: ["failure", "service"],
      });
    }
  });
export type AcquisitionCalendarSource = z.infer<typeof acquisitionCalendarSourceSchema>;

export const acquisitionCalendarSummarySchema = z.strictObject({
  available: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
  episodes: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
  missing: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
  movies: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
  total: z.int().nonnegative().max(ACQUISITION_CALENDAR_MAX_EVENTS),
});
export type AcquisitionCalendarSummary = z.infer<typeof acquisitionCalendarSummarySchema>;

function failuresMatch(left: PartialFailure, right: PartialFailure) {
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.occurredAt === right.occurredAt &&
    left.operation === right.operation &&
    left.retryable === right.retryable &&
    left.retryAfterSeconds === right.retryAfterSeconds &&
    left.service === right.service
  );
}

function eventOrder(left: AcquisitionCalendarEvent, right: AcquisitionCalendarEvent) {
  const byTime = Date.parse(left.eventAt) - Date.parse(right.eventAt);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

export const acquisitionCalendarResponseSchema = z
  .strictObject({
    endAt: timestampSchema,
    events: z.array(acquisitionCalendarEventSchema).max(ACQUISITION_CALENDAR_MAX_EVENTS),
    failures: z.array(partialFailureSchema).max(ACQUISITION_CALENDAR_MAX_SOURCES),
    generatedAt: timestampSchema,
    nextCursor: acquisitionCalendarCursorSchema.nullable(),
    sourceTruncated: z.boolean(),
    sources: z.array(acquisitionCalendarSourceSchema).max(ACQUISITION_CALENDAR_MAX_SOURCES),
    startAt: timestampSchema,
    state: z.enum(["complete", "degraded", "unconfigured"]),
    summary: acquisitionCalendarSummarySchema,
  })
  .superRefine((response, context) => {
    const start = Date.parse(response.startAt);
    const end = Date.parse(response.endAt);
    if (end <= start || end - start > ACQUISITION_CALENDAR_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: "Calendar response range must be ordered and bounded.",
        path: ["endAt"],
      });
    }

    const sources = new Map<string, AcquisitionCalendarSource>();
    for (const [index, source] of response.sources.entries()) {
      if (sources.has(source.id)) {
        context.addIssue({
          code: "custom",
          message: "Calendar sources must have unique identifiers.",
          path: ["sources", index, "id"],
        });
      }
      sources.set(source.id, source);
    }

    const eventIds = new Set<string>();
    for (const [index, event] of response.events.entries()) {
      const source = sources.get(event.sourceId);
      if (!source || source.service !== event.service || source.displayName !== event.sourceName) {
        context.addIssue({
          code: "custom",
          message: "Calendar events must identify one returned source consistently.",
          path: ["events", index, "sourceId"],
        });
      }
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: "custom",
          message: "Calendar event identifiers must be unique.",
          path: ["events", index, "id"],
        });
      }
      eventIds.add(event.id);
      const eventAt = Date.parse(event.eventAt);
      if (eventAt < start || eventAt >= end) {
        context.addIssue({
          code: "custom",
          message: "Calendar events must fall inside the requested range.",
          path: ["events", index, "eventAt"],
        });
      }
      const previous = response.events[index - 1];
      if (previous && eventOrder(previous, event) > 0) {
        context.addIssue({
          code: "custom",
          message: "Calendar events must be returned in stable chronological order.",
          path: ["events", index, "eventAt"],
        });
      }
    }

    for (const [index, source] of response.sources.entries()) {
      const count = response.events.filter((event) => event.sourceId === source.id).length;
      if (source.eventCount !== count) {
        context.addIssue({
          code: "custom",
          message: "Calendar source totals must match returned events.",
          path: ["sources", index, "eventCount"],
        });
      }
    }

    const expectedFailures = response.sources
      .map((source) => source.failure)
      .filter((failure): failure is PartialFailure => failure !== null);
    if (
      expectedFailures.length !== response.failures.length ||
      expectedFailures.some((failure, index) => {
        const returned = response.failures[index];
        return returned === undefined || !failuresMatch(failure, returned);
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Top-level calendar failures must mirror source failures in source order.",
        path: ["failures"],
      });
    }

    const expectedState =
      response.sources.length === 0
        ? "unconfigured"
        : response.failures.length === 0
          ? "complete"
          : "degraded";
    if (response.state !== expectedState) {
      context.addIssue({
        code: "custom",
        message: "Calendar state must reflect configured sources and failures.",
        path: ["state"],
      });
    }

    const expectedSummary = {
      available: response.events.filter((event) => event.availability === "available").length,
      episodes: response.events.filter((event) => event.kind === "episode").length,
      missing: response.events.filter((event) => event.availability === "missing").length,
      movies: response.events.filter((event) => event.kind === "movie").length,
      total: response.events.length,
    };
    for (const key of Object.keys(expectedSummary) as (keyof typeof expectedSummary)[]) {
      if (response.summary[key] !== expectedSummary[key]) {
        context.addIssue({
          code: "custom",
          message: "Calendar summary must match the returned page.",
          path: ["summary", key],
        });
      }
    }
  });
export type AcquisitionCalendarResponse = z.infer<typeof acquisitionCalendarResponseSchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const acquisitionCalendarResponseJsonSchema = withoutSchemaDialect(
  acquisitionCalendarResponseSchema,
);
