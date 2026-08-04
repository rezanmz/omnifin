import type {
  DiscoveryMediaDetailResponse,
  DiscoveryPersonDetailResponse,
  DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DiscoverySearchClientError, type DiscoverySearchClient } from "../lib/discovery-search";
import type { DiscoveryMediaDetailClient, DiscoveryPersonDetailClient } from "../lib/media-details";
import { GlobalSearch } from "./global-search";
import { GlobalSearchLoader } from "./global-search-loader";

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
    artwork: { backdropPath: null, posterPath: null },
    availability: "available",
    cast: [{ character: "Neo", name: "Keanu Reeves", personId: 6384, profilePath: null }],
    crew: [{ name: "Lana Wachowski", personId: 9340, role: "Director" }],
    genres: ["Action", "Science Fiction"],
    id: "movie:603",
    kind: "movie",
    intelligence: {
      ratings: [],
      ratingsState: "empty",
      recommendations: [],
      recommendationsState: "empty",
      trailers: [],
    },
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

const personResponse: DiscoveryPersonDetailResponse = {
  generatedAt: "2026-07-28T20:00:00.000Z",
  item: {
    biography: "An actor and producer known for character-driven films.",
    birthday: "1963-12-18",
    birthplace: "Shawnee, Oklahoma",
    credits: [
      {
        availability: "available",
        kind: "movie",
        role: "Tyler Durden",
        title: "Fight Club",
        tmdbId: 550,
        voteAverage: 8.4,
        year: 1999,
      },
    ],
    creditsState: "ready",
    creditsTotal: 1,
    deathday: null,
    department: "Acting",
    id: "person:287",
    name: "Brad Pitt",
    profilePath: null,
    source: "seerr",
    tmdbId: 287,
  },
};

function client(
  search: DiscoverySearchClient["search"] = async () => searchResponse,
): DiscoverySearchClient {
  return { search };
}

describe("global search", () => {
  it("keeps the server-rendered search field inert until hydration", () => {
    expect(renderToString(<GlobalSearchLoader client={client()} debounceMs={0} />)).toContain(
      'disabled=""',
    );
  });

  it("opens a query transferred while the lazy search implementation loads", async () => {
    const search = vi.fn(async () => searchResponse);
    render(<GlobalSearchLoader client={client(search)} debounceMs={0} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "matrix" } });

    const result = await screen.findByRole("option", { name: /The Matrix/i });
    expect(result).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, query: "matrix" }),
      expect.any(AbortSignal),
    );
  });

  it("restores the activation position after the lazy search handoff", async () => {
    let scrollLeft = 0;
    let scrollTop = 1_200;
    const originalScrollX = Object.getOwnPropertyDescriptor(window, "scrollX");
    const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperties(window, {
      scrollX: { configurable: true, get: () => scrollLeft },
      scrollY: { configurable: true, get: () => scrollTop },
    });
    vi.mocked(window.scrollTo).mockImplementation(((left: number, top?: number) => {
      scrollLeft = left;
      scrollTop = top ?? scrollTop;
    }) as typeof window.scrollTo);

    try {
      render(<GlobalSearchLoader client={client()} debounceMs={0} />);
      const placeholder = screen.getByRole("combobox");
      fireEvent.pointerDown(placeholder);

      // Firefox may apply scroll anchoring while React replaces the inert placeholder.
      // The handoff must restore the position captured before that DOM replacement.
      scrollTop = 1_283;
      fireEvent.pointerUp(placeholder);

      await waitFor(() =>
        expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
      );
      fireEvent.scroll(window);
      await waitFor(() => expect(scrollTop).toBe(1_200));

      // WebKit can apply another sticky-focus adjustment after the lazy handoff settles.
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      scrollTop = 88;
      fireEvent.scroll(window);
      await waitFor(() => expect(scrollTop).toBe(1_200));

      fireEvent.wheel(window);
      scrollTop = 72;
      fireEvent.scroll(window);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(scrollTop).toBe(72);
    } finally {
      vi.mocked(window.scrollTo).mockReset();
      if (originalScrollX) Object.defineProperty(window, "scrollX", originalScrollX);
      if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    }
  });

  it("honors scroll intent while the lazy search implementation loads", async () => {
    let scrollTop = 1_200;
    const originalScrollX = Object.getOwnPropertyDescriptor(window, "scrollX");
    const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperties(window, {
      scrollX: { configurable: true, get: () => 0 },
      scrollY: { configurable: true, get: () => scrollTop },
    });
    vi.mocked(window.scrollTo).mockImplementation(((_left: number, top?: number) => {
      scrollTop = top ?? scrollTop;
    }) as typeof window.scrollTo);

    try {
      render(<GlobalSearchLoader client={client()} debounceMs={0} />);
      fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
      fireEvent.wheel(window);
      scrollTop = 72;

      await waitFor(() =>
        expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      scrollTop = 31;
      fireEvent.scroll(window);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(scrollTop).toBe(31);
    } finally {
      vi.mocked(window.scrollTo).mockReset();
      if (originalScrollX) Object.defineProperty(window, "scrollX", originalScrollX);
      if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    }
  });

  it("rearms scroll stabilization after a new activation during lazy loading", async () => {
    let scrollTop = 1_200;
    const originalScrollX = Object.getOwnPropertyDescriptor(window, "scrollX");
    const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperties(window, {
      scrollX: { configurable: true, get: () => 0 },
      scrollY: { configurable: true, get: () => scrollTop },
    });
    vi.mocked(window.scrollTo).mockImplementation(((_left: number, top?: number) => {
      scrollTop = top ?? scrollTop;
    }) as typeof window.scrollTo);

    try {
      render(<GlobalSearchLoader client={client()} debounceMs={0} />);
      fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
      fireEvent.wheel(window);
      scrollTop = 72;
      fireEvent.keyDown(document, { ctrlKey: true, key: "k" });

      await waitFor(() =>
        expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      scrollTop = 31;
      fireEvent.scroll(window);
      await waitFor(() => expect(scrollTop).toBe(72));
      fireEvent.wheel(window);
    } finally {
      vi.mocked(window.scrollTo).mockReset();
      if (originalScrollX) Object.defineProperty(window, "scrollX", originalScrollX);
      if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    }
  });

  it("retains focus after the complete pointer gesture hands off the lazy search", async () => {
    render(<GlobalSearchLoader client={client()} debounceMs={0} />);
    const placeholder = screen.getByRole("combobox");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    placeholder.setPointerCapture = setPointerCapture;
    placeholder.hasPointerCapture = () => true;
    placeholder.releasePointerCapture = releasePointerCapture;
    vi.spyOn(placeholder, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ height: 40, width: 100 }),
    );

    fireEvent.pointerDown(placeholder, { clientX: 50, clientY: 20, pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(placeholder).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search-placeholder");
    fireEvent.pointerUp(placeholder, { clientX: 50, clientY: 20, pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
    );
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("does not activate when a captured pointer is released outside search", async () => {
    render(<GlobalSearchLoader client={client()} debounceMs={0} />);
    const placeholder = screen.getByRole("combobox");
    placeholder.setPointerCapture = vi.fn();
    placeholder.hasPointerCapture = () => true;
    placeholder.releasePointerCapture = vi.fn();
    vi.spyOn(placeholder, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ height: 40, width: 100 }),
    );

    fireEvent.pointerDown(placeholder, { clientX: 50, clientY: 20, pointerId: 7 });
    fireEvent.pointerUp(placeholder, { clientX: 150, clientY: 20, pointerId: 7 });
    fireEvent.click(placeholder);
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search-placeholder");
    expect(placeholder.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("falls back to click activation after a canceled pointer gesture", async () => {
    render(<GlobalSearchLoader client={client()} debounceMs={0} />);
    const placeholder = screen.getByRole("combobox");

    fireEvent.pointerDown(placeholder);
    fireEvent.pointerDown(placeholder);
    fireEvent.pointerCancel(placeholder);
    fireEvent.blur(placeholder);
    fireEvent.click(placeholder);

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
    );
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("preserves a keyboard edit while handing the placeholder to live search", async () => {
    const search = vi.fn(async () => searchResponse);
    render(<GlobalSearchLoader client={client(search)} debounceMs={0} />);
    const placeholder = screen.getByRole("combobox");

    placeholder.focus();
    fireEvent.keyDown(placeholder, { key: "m" });
    fireEvent.change(placeholder, { target: { value: "matrix" } });

    expect(await screen.findByRole("option", { name: /The Matrix/i })).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveValue("matrix");
    expect(search).toHaveBeenCalledOnce();
  });

  it("opens the lazy search from its keyboard navigation affordances", async () => {
    const { unmount } = render(<GlobalSearchLoader client={client()} debounceMs={0} />);
    const arrowTarget = screen.getByRole("combobox");
    fireEvent.keyDown(arrowTarget, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
    );
    unmount();

    render(<GlobalSearchLoader client={client()} debounceMs={0} />);
    const enterTarget = screen.getByRole("combobox");
    fireEvent.keyDown(enterTarget, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveAttribute("id", "global-search"),
    );
  });

  it("opens normalized title details without keeping the search console behind the dialog", async () => {
    const user = userEvent.setup();
    const load = vi.fn<DiscoveryMediaDetailClient["load"]>(async () => detailResponse);
    render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        detailClient={{
          load,
          loadConnectedActions: vi.fn<DiscoveryMediaDetailClient["loadConnectedActions"]>(
            async () => ({
              actions: [],
              generatedAt: "2026-07-28T20:00:00.000Z",
              kind: "movie",
              tmdbId: 603,
            }),
          ),
        }}
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

  it("opens a normalized person profile directly from global search", async () => {
    const user = userEvent.setup();
    const loadPerson = vi.fn<DiscoveryPersonDetailClient["load"]>(async () => personResponse);
    render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        initialOpen
        initialQuery="matrix"
        personClient={{ load: loadPerson }}
      />,
    );

    await user.click(await screen.findByRole("option", { name: /Brad Pitt/i }));
    await user.click(screen.getByRole("button", { name: "View profile for Brad Pitt" }));

    const dialog = await screen.findByRole("dialog", { name: "Brad Pitt person context" });
    expect(within(dialog).getByRole("heading", { name: "Brad Pitt" })).toBeVisible();
    expect(within(dialog).getByText(personResponse.item.biography!)).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
    expect(loadPerson).toHaveBeenCalledWith(
      { tmdbId: 287 },
      { language: expect.any(String) },
      expect.any(AbortSignal),
    );
  });

  it("opens a keyboard-guided prompt without requesting one-character queries", async () => {
    const search = vi.fn(async () => searchResponse);
    const user = userEvent.setup();
    render(<GlobalSearch client={client(search)} debounceMs={0} />);

    const input = screen.getByRole("combobox", { name: "Search media and commands" });
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Search the whole signal")).toBeVisible();

    await user.type(input, "m");
    expect(
      screen.getByText("Type at least two characters to find movies, series, and people."),
    ).toBeVisible();
    expect(search).not.toHaveBeenCalled();
  });

  it("offers permission-filtered destinations without exposing privileged commands", async () => {
    const user = userEvent.setup();
    render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        initialOpen
        initialPermissions={["media.view", "library.manage", "playback.history.self.manage"]}
      />,
    );

    const input = screen.getByRole("combobox");
    const discover = screen.getByRole("option", { name: /Discover/i });
    expect(discover).toHaveAttribute("href", "/");
    expect(screen.getByRole("option", { name: /Library/i })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("option", { name: /Calendar/i })).toHaveAttribute("href", "/calendar");
    expect(screen.getByRole("option", { name: /Viewing history/i })).toHaveAttribute(
      "href",
      "/history",
    );
    expect(screen.queryByRole("option", { name: /Manage connectors/i })).not.toBeInTheDocument();

    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(discover).toHaveFocus();
  });

  it("filters permission-aware commands before starting remote media search", async () => {
    const search = vi.fn(async () => searchResponse);
    const user = userEvent.setup();
    render(
      <GlobalSearch
        client={client(search)}
        debounceMs={0}
        initialOpen
        initialPermissions={["downloads.manage"]}
      />,
    );

    await user.type(screen.getByRole("combobox"), "d");
    expect(screen.getByRole("option", { name: /Download queue/i })).toHaveAttribute(
      "href",
      "/operations/downloads",
    );
    expect(screen.queryByRole("option", { name: /User access/i })).not.toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it("offers the operator audit trail only with explicit audit authority", () => {
    const { unmount } = render(
      <GlobalSearch client={client()} initialOpen initialPermissions={["roles.manage"]} />,
    );
    expect(screen.queryByRole("option", { name: /Operator audit trail/i })).not.toBeInTheDocument();

    unmount();
    render(
      <GlobalSearch
        client={client()}
        initialOpen
        initialPermissions={["roles.manage", "audit.view"]}
      />,
    );
    expect(screen.getByRole("option", { name: /Operator audit trail/i })).toHaveAttribute(
      "href",
      "/settings/audit",
    );
  });

  it("keeps matching destinations available while remote media search is unavailable", async () => {
    let rejectSearch: ((reason: unknown) => void) | undefined;
    const search = vi.fn(
      async () =>
        new Promise<DiscoverySearchResponse>((_resolve, reject) => {
          rejectSearch = reject;
        }),
    );
    render(
      <GlobalSearch
        client={client(search)}
        debounceMs={0}
        initialOpen
        initialPermissions={[]}
        initialQuery="account"
      />,
    );

    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(screen.getByRole("option", { name: /Account & appearance/i })).toBeVisible();
    expect(screen.getByText("Searching media…")).toBeVisible();

    rejectSearch?.(
      new DiscoverySearchClientError(
        "unavailable",
        "discovery_unavailable",
        "Search is temporarily unavailable.",
      ),
    );
    expect(await screen.findByText("Media search is unavailable")).toBeVisible();
    expect(screen.getByRole("option", { name: /Account & appearance/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry media search" })).toBeVisible();
  });

  it("loads access once on activation and fails closed when access cannot be read", async () => {
    const permissionLoader = vi.fn(async () => ["connectors.manage"] as const);
    const loaded = render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        initialOpen
        permissionLoader={permissionLoader}
      />,
    );

    expect(await screen.findByRole("option", { name: /Manage connectors/i })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
    expect(permissionLoader).toHaveBeenCalledOnce();
    expect(permissionLoader).toHaveBeenCalledWith(expect.any(AbortSignal));
    loaded.unmount();

    render(
      <GlobalSearch
        client={client()}
        debounceMs={0}
        initialOpen
        permissionLoader={async () => Promise.reject(new Error("offline"))}
      />,
    );
    expect(await screen.findByText("Showing safe destinations")).toBeVisible();
    expect(screen.getByRole("option", { name: /Discover/i })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Manage connectors/i })).not.toBeInTheDocument();
  });

  it("reads command access from the same-origin no-store session boundary", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ csrfToken: null, principal: null }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<GlobalSearch client={client()} debounceMs={0} initialOpen />);
      await waitFor(() => expect(screen.queryByText("Checking access…")).not.toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/session",
        expect.objectContaining({
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(screen.getByRole("option", { name: /Discover/i })).toBeVisible();
      expect(screen.queryByRole("option", { name: /Manage connectors/i })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(input).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");

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
