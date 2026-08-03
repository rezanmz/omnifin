import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDashboard } from "../lib/dashboard-data";
import { DeferredDashboardSections } from "./deferred-dashboard-sections";

describe("DeferredDashboardSections", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps below-fold controls dormant until the user scrolls", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(
      <>
        <input aria-label="Search fixture" />
        <DeferredDashboardSections
          calendar={demoDashboard.calendar}
          continueWatching={demoDashboard.continueWatching}
          discovery={demoDashboard.discovery}
          operations={demoDashboard.operations}
        />
      </>,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search fixture" }), {
      key: "PageDown",
    });
    vi.advanceTimersByTime(10_000);

    expect(screen.getByRole("region", { name: "Preparing dashboard controls" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open calendar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /acquisitions moving/i })).not.toBeInTheDocument();
  });

  it("reserves final geometry and loads lower dashboard controls on user intent", async () => {
    render(
      <DeferredDashboardSections
        calendar={demoDashboard.calendar}
        continueWatching={demoDashboard.continueWatching}
        discovery={demoDashboard.discovery}
        operations={demoDashboard.operations}
      />,
    );

    expect(screen.getByRole("region", { name: "Preparing dashboard controls" })).toBeVisible();
    expect(screen.getAllByRole("article", { hidden: true })).toHaveLength(8);
    expect(screen.getByLabelText("Loading acquisition operations")).toBeVisible();

    fireEvent.scroll(window);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Preparing dashboard controls" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Continue watching" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open calendar" })).toHaveAttribute(
      "href",
      "/calendar",
    );
    expect(screen.getByRole("button", { name: /2 acquisitions moving/i })).toBeVisible();
  });

  it("loads lower dashboard controls for keyboard and remote navigation", async () => {
    render(
      <DeferredDashboardSections
        calendar={demoDashboard.calendar}
        continueWatching={demoDashboard.continueWatching}
        discovery={demoDashboard.discovery}
        operations={demoDashboard.operations}
      />,
    );

    fireEvent.keyDown(window, { key: "PageDown" });

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Preparing dashboard controls" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Open calendar" })).toBeVisible();
  });
});
