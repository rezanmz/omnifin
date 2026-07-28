import type {
  DiscoveryMediaDetailResponse,
  DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DiscoverySearchClientError, type DiscoverySearchClient } from "../lib/discovery-search";
import type { DiscoveryMediaDetailClient } from "../lib/media-details";
import { GlobalSearch } from "./global-search";

const searchResponse: DiscoverySearchResponse = {
  generatedAt: "2026-07-27T07:30:00.000Z",
  items: [
    {
      availability: "available",
      id: "movie:603",
      kind: "movie",
      originalTitle: "The Matrix",
      overview: "A hacker discovers the nature of reality.",
      source: "seerr",
      title: "The Matrix",
      tmdbId: 603,
      voteAverage: 8.2,
      year: 1999,
    },
    {
      availability: "requested",
      id: "series:1396",
      kind: "series",
      originalTitle: "Breaking Bad",
      overview: "A chemistry teacher turns to manufacturing.",
      source: "seerr",
      title: "Breaking Bad",
      tmdbId: 1396,
      voteAverage: 8.9,
      year: 2008,
    },
    {
      id: "person:287",
      kind: "person",
      knownFor: [{ kind: "movie", title: "Fight Club", year: 1999 }],
      source: "seerr",
      title: "Brad Pitt",
      tmdbId: 287,
    },
  ],
  page: 1,
  query: "matrix",
  totalPages: 1,
  totalResults: 3,
};

const detailResponse: DiscoveryMediaDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    availability: "available",
    cast: [{ character: "Neo", name: "Keanu Reeves" }],
    crew: [{ name: "Lana Wachowski", role: "Director" }],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    originalTitle: "The Matrix",
    overview: "A hacker discovers that the world he knows is a constructed reality.",
    productionStatus: "Released",
    runtimeMinutes: 136,
    source: "seerr",
    tagline: "Free your mind.",
    title: "The Matrix",
    tmdbId: 603,
    voteAverage: 8.2,
    voteCount: 27_000,
    year: 1999,
  },
};

function client(
  search: DiscoverySearchClient["search"] = async () => searchResponse,
): DiscoverySearchClient {
  return { search };
}

describe("global search", () => {
  it("opens normalized title details without keeping the search console behind the dialog", async () => {
    const user = userEvent.setup();
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(async () => detailResponse);
    render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        detailClient={{ load }}
        initialOpen
        initialQuery="matrix"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "View details for The Matrix" }));
    const dialog = await screen.findByRole("dialog", { name: "The Matrix details" });
    expect(within(dialog).getByRole("heading", { name: "The Matrix" })).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
    expect(load).toHaveBeenCalledOnce();
  });

  it("opens a keyboard-guided prompt without requesting one-character queries", async () => {
    const search = vi.fn(async () => searchResponse);
    const user = userEvent.setup();
    render(<GlobalSearch client={client(search)} debounceMs={0} />);

    const input = screen.getByRole("combobox", { name: "Search movies, series, and people" });
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Search the whole signal")).toBeVisible();

    await user.type(input, "m");
    expect(
      screen.getByText("Type at least two characters to find movies, series, and people."),
    ).toBeVisible();
    expect(search).not.toHaveBeenCalled();
  });

  it("loads normalized results and supports listbox keyboard navigation", async () => {
    const search = vi.fn(async () => searchResponse);
    const user = userEvent.setup();
    render(
      <GlobalSearch client={client(search)} debounceMs={0} initialOpen initialQuery="matrix" />,
    );

    const input = screen.getByRole("combobox");
    const matrix = await screen.findByRole("option", { name: /The Matrix/i });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, query: "matrix" }),
      expect.any(AbortSignal),
    );
    expect(screen.getByText("3 results")).toBeVisible();
    expect(screen.getByRole("heading", { name: "The Matrix" })).toBeVisible();

    fireEvent.pointerEnter(screen.getByRole("option", { name: /Breaking Bad/i }));
    expect(screen.getByRole("heading", { name: "Breaking Bad" })).toBeVisible();

    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(matrix).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Breaking Bad/i })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: /Brad Pitt/i })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /Breaking Bad/i })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("focuses from the command shortcut and closes without clearing the query", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch client={client()} debounceMs={0} initialQuery="matrix" />);
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(input).toHaveValue("matrix");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("aborts stale requests when the query changes", async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn(
      async (_input: Parameters<DiscoverySearchClient["search"]>[0], signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return new Promise<DiscoverySearchResponse>(() => undefined);
      },
    );
    const user = userEvent.setup();
    render(<GlobalSearch client={client(search)} debounceMs={0} initialOpen />);
    const input = screen.getByRole("combobox");

    await user.type(input, "matrix");
    await waitFor(() => expect(search).toHaveBeenCalled());
    const callsBeforeRevision = search.mock.calls.length;
    await user.type(input, " reloaded");
    await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(callsBeforeRevision));

    expect(signals.slice(0, -1).every((signal) => signal.aborted)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
  });

  it("renders empty, configuration, and retryable failure states", async () => {
    const emptySearch = vi.fn(async () => ({ ...searchResponse, items: [], totalResults: 0 }));
    const empty = render(
      <GlobalSearch
        client={client(emptySearch)}
        debounceMs={0}
        initialOpen
        initialQuery="unknown title"
      />,
    );
    expect(await screen.findByText("No signal for “unknown title”")).toBeVisible();
    empty.unmount();

    const unconfiguredSearch = vi.fn(async () =>
      Promise.reject(
        new DiscoverySearchClientError(
          "not_configured",
          "discovery_not_configured",
          "Discovery has not been configured.",
        ),
      ),
    );
    const unconfigured = render(
      <GlobalSearch
        client={client(unconfiguredSearch)}
        debounceMs={0}
        initialOpen
        initialQuery="matrix"
      />,
    );
    expect(await screen.findByText("Discovery is not connected")).toBeVisible();
    unconfigured.unmount();

    const retryableSearch = vi
      .fn<DiscoverySearchClient["search"]>()
      .mockRejectedValueOnce(
        new DiscoverySearchClientError(
          "rate_limited",
          "discovery_rate_limited",
          "Search is temporarily rate limited.",
        ),
      )
      .mockResolvedValueOnce(searchResponse);
    render(
      <GlobalSearch
        client={client(retryableSearch)}
        debounceMs={0}
        initialOpen
        initialQuery="matrix"
      />,
    );
    const retryButton = await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(retryButton);
    expect(await screen.findByRole("option", { name: /The Matrix/i })).toBeVisible();
    expect(retryableSearch).toHaveBeenCalledTimes(2);
  });

  it("clears the query while retaining focus", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch client={client()} debounceMs={0} initialOpen initialQuery="matrix" />);
    const input = screen.getByRole("combobox");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    expect(screen.getByText("Search the whole signal")).toBeVisible();
  });
});
