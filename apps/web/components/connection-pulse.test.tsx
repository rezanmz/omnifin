import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionPulse } from "./connection-pulse";

describe("ConnectionPulse", () => {
  it("announces healthy state without relying on color", () => {
    render(<ConnectionPulse status="healthy" />);
    const pulse = screen.getByRole("link", { name: "All connected services are healthy" });
    expect(pulse).toBeVisible();
    expect(pulse).toHaveAttribute("href", "/operations/health");
  });

  it("announces the attention state", () => {
    render(<ConnectionPulse status="attention" />);
    expect(screen.getByRole("link", { name: "One service needs attention" })).toHaveAttribute(
      "href",
      "/operations/health",
    );
  });

  it("keeps the health workspace reachable while services are offline", () => {
    render(<ConnectionPulse status="offline" />);
    expect(screen.getByRole("link", { name: "Connected services are offline" })).toHaveAttribute(
      "href",
      "/operations/health",
    );
  });
});
