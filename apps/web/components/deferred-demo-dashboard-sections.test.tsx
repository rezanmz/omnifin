import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeferredDemoDashboardSections } from "./deferred-demo-dashboard-sections";

describe("DeferredDemoDashboardSections", () => {
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
