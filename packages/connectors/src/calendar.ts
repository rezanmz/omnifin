import { ACQUISITION_CALENDAR_MAX_WINDOW_DAYS } from "@omnifin/contracts/calendar";
import type {
  AcquisitionCalendarAvailability,
  AcquisitionCalendarReleaseKind,
} from "@omnifin/contracts/calendar";
import type { AcquisitionService } from "@omnifin/contracts/acquisition";
import { z } from "zod";

export const ACQUISITION_CALENDAR_SOURCE_MAX_RECORDS = 5_000;

export const acquisitionCalendarReadRequestSchema = z
  .strictObject({
    endAt: z.iso.datetime({ offset: true }),
    startAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((request, context) => {
    const start = Date.parse(request.startAt);
    const end = Date.parse(request.endAt);
    if (end <= start) {
      context.addIssue({
        code: "custom",
        message: "Calendar range end must follow its start.",
        path: ["endAt"],
      });
    }
    if (end - start > ACQUISITION_CALENDAR_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        message: "Calendar range exceeds the supported window.",
        path: ["endAt"],
      });
    }
  });
export type AcquisitionCalendarReadRequest = z.infer<typeof acquisitionCalendarReadRequestSchema>;

export interface AcquisitionCalendarSourceEvent {
  availability: AcquisitionCalendarAvailability;
  endAt: string | null;
  episodeNumber: number | null;
  eventAt: string;
  externalId: string;
  kind: "episode" | "movie";
  monitored: boolean;
  overview: string | null;
  releaseKind: AcquisitionCalendarReleaseKind;
  runtimeMinutes: number | null;
  seasonNumber: number | null;
  service: AcquisitionService;
  subtitle: string | null;
  title: string;
  year: number | null;
}

export interface AcquisitionCalendarSourceResult {
  events: AcquisitionCalendarSourceEvent[];
  truncated: boolean;
}

export interface AcquisitionCalendarReader {
  readAcquisitionCalendar(
    request: AcquisitionCalendarReadRequest,
    signal?: AbortSignal,
  ): Promise<AcquisitionCalendarSourceResult>;
}
