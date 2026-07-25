import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarStrip } from "./calendar-strip";

describe("CalendarStrip", () => {
  it("renders a quiet state when no releases are scheduled", () => {
    render(<CalendarStrip items={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No arrivals scheduled");
    expect(screen.queryByRole("button", { name: "Open calendar" })).not.toBeInTheDocument();
  });
});
