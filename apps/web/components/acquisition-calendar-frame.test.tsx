import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AcquisitionCalendarFrame } from "./acquisition-calendar-frame";

describe("AcquisitionCalendarFrame", () => {
  it("uses the persistent application chrome when embedded in an authenticated route", () => {
    const { container } = render(
      <AcquisitionCalendarFrame embedded initialPreference="system">
        <p>Calendar content</p>
      </AcquisitionCalendarFrame>,
    );

    expect(screen.getByRole("main")).toHaveTextContent("Calendar content");
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(container.querySelector(".cinematic-backdrop")).not.toBeInTheDocument();
  });
});
