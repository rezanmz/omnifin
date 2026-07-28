import type { Metadata } from "next";

import { AcquisitionCalendar } from "../../components/acquisition-calendar";
import {
  AcquisitionCalendarFrame,
  AcquisitionCalendarHero,
} from "../../components/acquisition-calendar-frame";
import {
  degradedAcquisitionCalendar,
  demoAcquisitionCalendar,
  emptyAcquisitionCalendar,
  unconfiguredAcquisitionCalendar,
} from "../../lib/acquisition-calendar-demo";
import type { AcquisitionCalendarLoadOutcome } from "../../lib/acquisition-calendar";
import { readThemePreference } from "../../lib/theme-server";
import "./calendar.css";

export const metadata: Metadata = { title: "Acquisition calendar" };
export const dynamic = "force-dynamic";

interface AcquisitionCalendarPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

function testOutcome(
  view: string | string[] | undefined,
): AcquisitionCalendarLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (["forbidden", "signed_out", "unavailable"].includes(String(view))) {
    return { status: String(view) } as Exclude<AcquisitionCalendarLoadOutcome, { status: "ready" }>;
  }
  const calendar =
    view === "empty"
      ? emptyAcquisitionCalendar
      : view === "degraded"
        ? degradedAcquisitionCalendar
        : view === "unconfigured"
          ? unconfiguredAcquisitionCalendar
          : view === "ready"
            ? demoAcquisitionCalendar
            : undefined;
  return calendar ? { calendar, status: "ready" } : undefined;
}

export default async function AcquisitionCalendarPage({
  searchParams,
}: AcquisitionCalendarPageProperties) {
  const parameters = await searchParams;
  const preference = await readThemePreference();
  const test = testOutcome(parameters["test-view"]);
  const demo =
    test === undefined && process.env.OMNIFIN_DEMO_MODE === "true"
      ? ({ calendar: demoAcquisitionCalendar, status: "ready" } as const)
      : undefined;
  const outcome = test ?? demo;

  return (
    <AcquisitionCalendarFrame initialPreference={preference}>
      {outcome?.status === "ready" ? <AcquisitionCalendarHero calendar={outcome.calendar} /> : null}
      <AcquisitionCalendar
        embedded
        hideHero={outcome?.status === "ready"}
        {...(outcome === undefined ? {} : { initialOutcome: outcome, live: false })}
      />
    </AcquisitionCalendarFrame>
  );
}
