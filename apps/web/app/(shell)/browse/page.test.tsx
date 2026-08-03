import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoBrowseResponse } from "../../../lib/discovery-browse-demo";
import BrowsePage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe("BrowsePage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders deterministic browse results only in the browser test profile", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await BrowsePage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Browse without the guesswork." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "View details for The Far Meridian" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Request The Far Meridian" })).toBeVisible();
  });

  it("keeps ready browser fixtures live for filter-transition coverage", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...demoBrowseResponse,
            criteria: { ...demoBrowseResponse.criteria, kind: "series" },
            items: [],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      await BrowsePage({
        searchParams: Promise.resolve({ "test-view": "ready" }),
      }),
    );

    await user.click(screen.getByRole("button", { name: "Series" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("kind=series"),
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
  });

  it("retains a safe media kind while reporting invalid shared criteria", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    render(
      await BrowsePage({
        searchParams: Promise.resolve({
          kind: "series",
          minimumRating: "not-a-number",
          "test-view": "loading",
        }),
      }),
    );

    expect(screen.getByRole("button", { name: "Series" })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Some shared filters were invalid and have been safely reset."),
    ).toBeVisible();
    expect(screen.getByLabelText("Loading browse results")).toBeVisible();
  });
});
