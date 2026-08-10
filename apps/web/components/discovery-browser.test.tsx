import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  demoBrowseCriteria,
  demoBrowseResponse,
  emptyBrowseResponse,
} from "../lib/discovery-browse-demo";
import { DiscoveryBrowseClientError } from "../lib/discovery-browse";
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

  it.each([
    ["absent", true],
    ["present", false],
    ["unknown", false],
  ] as const)("applies guarded request presentation for unknown+%s", async (state, visible) => {
    const item = {
      ...demoBrowseResponse.items[0]!,
      availability: "unknown" as const,
      mediaRecordState: state,
    };
    render(
      <DiscoveryBrowser
        initialCriteria={demoBrowseCriteria}
        initialResponse={{ ...demoBrowseResponse, items: [item] }}
        live={false}
      />,
    );

    const request = screen.queryByRole("button", { name: `Request ${item.title}` });
    if (visible) expect(request).toBeVisible();
    else expect(request).not.toBeInTheDocument();
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

  it("keeps advanced criteria visible, editable, and safely resettable", async () => {
    const user = userEvent.setup();
    const criteria = {
      ...demoBrowseCriteria,
      availability: "partial" as const,
      genre: "science-fiction" as const,
      minimumVotes: 250,
      originalLanguage: "fr" as const,
      page: 2,
      runtimeMax: 120,
      sort: "rating" as const,
      yearFrom: 2000,
      yearTo: 2026,
    };
    render(
      <DiscoveryBrowser
        initialCriteria={criteria}
        initialResponse={{
          ...demoBrowseResponse,
          criteria,
          items: [
            {
              ...demoBrowseResponse.items[0]!,
              artwork: { backdropPath: null, posterPath: null },
              availability: "unknown",
              mediaRecordState: "unknown",
              voteAverage: null,
              year: null,
            },
          ],
          page: 2,
          totalPages: 3,
        }}
        invalidCriteria
        live={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Some shared filters were invalid and have been safely reset.",
    );
    expect(screen.getByText("Year unknown")).toBeVisible();
    expect(screen.getByText("Availability unknown")).toBeVisible();
    expect(screen.getByRole("button", { name: "Science Fiction" })).toBeVisible();
    expect(screen.getByRole("button", { name: "≤ 120 min" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Partially available" })).toBeVisible();

    const filterRail = screen.getByRole("complementary", { name: "Browse filters" });
    await user.selectOptions(within(filterRail).getByLabelText("Order"), "newest");
    expect(push).toHaveBeenLastCalledWith(
      "/browse?kind=movie&genre=science-fiction&yearFrom=2000&yearTo=2026&minimumRating=7&minimumVotes=250&runtimeMax=120&originalLanguage=fr&availability=partial&sort=newest",
      { scroll: false },
    );

    await user.click(screen.getByRole("button", { name: "≤ 120 min" }));
    expect(push).toHaveBeenLastCalledWith(expect.not.stringContaining("runtimeMax"), {
      scroll: false,
    });

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(push).toHaveBeenLastCalledWith("/browse?kind=movie", { scroll: false });
  });

  it("explains an unavailable connector and retries into a bounded empty state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const unavailable = new DiscoveryBrowseClientError(
      "not_configured",
      "discovery_not_configured",
      "Browse is unavailable.",
    );
    const load = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ ...emptyBrowseResponse, totalPages: 2 });

    render(<DiscoveryBrowser client={{ load }} initialCriteria={demoBrowseCriteria} />);

    expect(screen.getByRole("status", { name: "Loading browse results" })).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(
      await screen.findByRole("heading", { name: "Connect Seerr to start browsing" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "No titles match this page." }),
    ).toBeVisible();
    expect(screen.getByText(/inspect the next catalogue page/u)).toBeVisible();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
