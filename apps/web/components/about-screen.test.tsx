import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AboutScreen, AboutScreenSkeleton } from "./about-screen";
import { ThemeProvider } from "./theme-provider";

const revision = "0123456789abcdef0123456789abcdef01234567";
const stableIdentity: RuntimeIdentity = {
  channel: "stable",
  license: "AGPL-3.0-only",
  revision,
  schemaVersion: 1,
  sourceUrl: `https://github.com/rezanmz/omnifin/tree/${revision}`,
  verification: "verified",
  version: "1.2.3",
};

function renderScreen(outcome: Parameters<typeof AboutScreen>[0]["outcome"]) {
  return render(
    <ThemeProvider initialPreference="system">
      <AboutScreen outcome={outcome} />
    </ThemeProvider>,
  );
}

describe("AboutScreen", () => {
  it("preserves the final layout while build identity is loading", () => {
    const { container } = render(<AboutScreenSkeleton />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading local build identity");
    expect(container.querySelector("main")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".about-skeleton-line").length).toBeGreaterThan(4);
  });

  it("presents a verified release and exact corresponding source", () => {
    renderScreen({ identity: stableIdentity, status: "ready" });

    expect(screen.getByRole("heading", { name: "Know exactly what is running." })).toBeVisible();
    expect(screen.getByText("Release verified")).toBeVisible();
    expect(screen.getByText("1.2.3")).toBeVisible();
    expect(screen.getByText(revision)).toBeVisible();
    expect(screen.getByRole("link", { name: "View corresponding source" })).toHaveAttribute(
      "href",
      stableIdentity.sourceUrl,
    );
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
  });

  it("copies a bounded support identity without private installation data", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderScreen({ identity: stableIdentity, status: "ready" });

    await user.click(screen.getByRole("button", { name: "Copy support identity" }));

    expect(writeText).toHaveBeenCalledWith(
      ["Omnifin 1.2.3 (stable)", `Revision: ${revision}`, "License: AGPL-3.0-only"].join("\n"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Support identity copied");
  });

  it("labels development builds honestly without inventing a revision", () => {
    renderScreen({
      identity: {
        ...stableIdentity,
        channel: "development",
        revision: null,
        sourceUrl: "https://github.com/rezanmz/omnifin",
        verification: "development",
        version: "0.0.0-dev",
      },
      status: "ready",
    });

    expect(screen.getByText("Development build")).toBeVisible();
    expect(screen.getByText("Not release-verified")).toBeVisible();
    expect(screen.queryByText(revision)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View project source" })).toHaveAttribute(
      "href",
      "https://github.com/rezanmz/omnifin",
    );
  });

  it("keeps the unavailable state useful without guessing build data", () => {
    renderScreen({ status: "unavailable" });

    expect(screen.getByRole("status")).toHaveTextContent("Build identity is unavailable");
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/about");
    expect(screen.queryByRole("link", { name: /source/i })).not.toBeInTheDocument();
  });
});
