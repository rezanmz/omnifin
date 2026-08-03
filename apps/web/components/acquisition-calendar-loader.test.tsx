import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { demoAcquisitionCalendar } from "../lib/acquisition-calendar-demo";
import { AcquisitionCalendarLoader } from "./acquisition-calendar-loader";

describe("AcquisitionCalendarLoader", () => {
  it("keeps the interactive calendar out of the initial paint when the hero is stable", () => {
    const markup = renderToString(
      <AcquisitionCalendarLoader
        hideHero
        initialOutcome={{ calendar: demoAcquisitionCalendar, status: "ready" }}
        live={false}
      />,
    );

    expect(markup).toContain('aria-label="Loading acquisition calendar"');
    expect(markup).toContain('data-hide-hero="true"');
    expect(markup).not.toContain("<i");
  });
});
