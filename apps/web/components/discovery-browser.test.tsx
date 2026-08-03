import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoBrowseCriteria, demoBrowseResponse } from "../lib/discovery-browse-demo";
import { DiscoveryBrowser } from "./discovery-browser";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

describe("DiscoveryBrowser", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps visible criteria, details, and title-level request actions in one workspace", async () => {
    const user = userEvent.setup();
    render(
      <DiscoveryBrowser
        initialCriteria={demoBrowseCriteria}
        initialResponse={demoBrowseResponse}
        live={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Your criteria" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /View details for/u })).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Request The Far Meridian" })).toBeVisible();
    expect(screen.getByText("238 candidates · page 1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Series" }));
    expect(push).toHaveBeenCalledWith("/browse?kind=series&minimumRating=7", { scroll: false });
  });

  it("replaces bootstrap movies with the requested media kind", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async (criteria: typeof demoBrowseCriteria) => ({
      ...demoBrowseResponse,
      criteria,
      items: demoBrowseResponse.items.map((item) => ({
        ...item,
        id: `series:${item.tmdbId}`,
        kind: "series" as const,
        title: `${item.title} Files`,
      })),
    }));
    render(
      <DiscoveryBrowser
        client={{ load }}
        initialCriteria={demoBrowseCriteria}
        initialResponse={demoBrowseResponse}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Series" }));

    expect(
      await screen.findByRole("button", { name: "View details for The Far Meridian Files" }),
    ).toBeVisible();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "series" }),
      expect.anything(),
    );
  });

  it("debounces title search and preserves scroll position through URL state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DiscoveryBrowser
        initialCriteria={demoBrowseCriteria}
        initialResponse={demoBrowseResponse}
        live={false}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Search within Browse" }), "matrix");
    await vi.advanceTimersByTimeAsync(430);

    expect(replace).toHaveBeenLastCalledWith("/browse?kind=movie&query=matrix&minimumRating=7", {
      scroll: false,
    });
  });
});
