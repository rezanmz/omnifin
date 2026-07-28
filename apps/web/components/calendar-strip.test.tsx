import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarStrip } from "./calendar-strip";

describe("CalendarStrip", () => {
  it("renders a quiet state when no releases are scheduled", () => {
    render(<CalendarStrip items={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No arrivals scheduled");
    expect(screen.queryByRole("link", { name: "Open calendar" })).not.toBeInTheDocument();
  });

  it("links the dashboard strip to the complete calendar", () => {
    render(
      <CalendarStrip
        items={[
          {
            accent: "#d8ff70",
            day: "Mon",
            id: "calendar-item",
            service: "Series",
            title: "Signal",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Open calendar" })).toHaveAttribute(
      "href",
      "/calendar",
    );
  });
});
