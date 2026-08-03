import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeferredDemoDashboardSections } from "./deferred-demo-dashboard-sections";

describe("DeferredDemoDashboardSections", () => {
  afterEach(() => vi.useRealTimers());

  it("does not load unrelated dashboard controls from search input intent", async () => {
    vi.useFakeTimers();
    render(<DeferredDemoDashboardSections />);

    fireEvent.pointerDown(window);
    fireEvent.keyDown(window, { key: "s" });
    vi.advanceTimersByTime(10_000);

    expect(screen.getByRole("region", { name: "Preparing dashboard controls" })).toBeVisible();
    expect(screen.queryByText("Ember Coast")).not.toBeInTheDocument();
  });

  it("keeps demo fixture data in the intent-loaded dashboard chunk", async () => {
    render(<DeferredDemoDashboardSections />);

    expect(screen.getByRole("region", { name: "Preparing dashboard controls" })).toBeVisible();
    expect(screen.queryByText("Ember Coast")).not.toBeInTheDocument();

    fireEvent.scroll(window);

    expect(await screen.findByText("Ember Coast")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Preparing dashboard controls" }),
      ).not.toBeInTheDocument(),
    );
  });
});
