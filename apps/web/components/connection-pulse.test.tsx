import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionPulse } from "./connection-pulse";

describe("ConnectionPulse", () => {
  it("announces healthy state without relying on color", () => {
    render(<ConnectionPulse status="healthy" />);
    expect(
      screen.getByRole("button", { name: "All connected services are healthy" }),
    ).toBeVisible();
  });

  it("announces the attention state", () => {
    render(<ConnectionPulse status="attention" />);
    expect(screen.getByRole("button", { name: "One service needs attention" })).toBeVisible();
  });
});
