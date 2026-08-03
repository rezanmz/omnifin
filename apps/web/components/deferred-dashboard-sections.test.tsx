import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { demoDashboard } from "../lib/dashboard-data";
import { DeferredDashboardSections } from "./deferred-dashboard-sections";

describe("DeferredDashboardSections", () => {
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
});
