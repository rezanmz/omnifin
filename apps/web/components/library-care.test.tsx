import type { LibraryArtworkSearchResponse } from "@omnifin/contracts/library";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { readyLibraryOutcome } from "../lib/library-care-demo";
import type { LibraryOperationsClient } from "../lib/library-operations";
import { ThemeProvider } from "./theme-provider";
import { LibraryCare } from "./library-care";

const generatedAt = "2026-07-28T16:00:00.000Z";
const searchId = `library_artwork_search_${"s".repeat(22)}`;
const resultId = `library_artwork_result_${"r".repeat(22)}`;
const artwork: LibraryArtworkSearchResponse = {
  expiresAt: "2026-07-28T16:20:00.000Z",
  generatedAt,
  kind: "poster",
  referenceId: `media_${"b".repeat(22)}`,
  results: [
    {
      communityRating: 8.6,
      height: 3000,
      id: resultId,
      language: "English",
      previewPath: `/v1/library/artwork-searches/${searchId}/results/${resultId}/preview`,
      providerName: "TMDB",
      voteCount: 88,
      width: 2000,
    },
  ],
  searchId,
};

function mutation(referenceId: string | null) {
  return {
    receipt: {
      acceptedAt: generatedAt,
      operationId: `library_operation_${"o".repeat(22)}`,
      referenceId,
      state: "accepted" as const,
    },
    replayed: false,
  };
}

function client(overrides: Partial<LibraryOperationsClient> = {}) {
  return {
    applyArtwork: vi.fn(async () => mutation(artwork.referenceId)),
    load: vi.fn(async () => readyLibraryOutcome),
    loadAttention: vi.fn(async () => readyLibraryOutcome.snapshot.attention),
    refresh: vi.fn(async (referenceId) => mutation(referenceId)),
    scan: vi.fn(async () => mutation(null)),
    searchArtwork: vi.fn(async () => artwork),
    updateMetadata: vi.fn(async (referenceId) => mutation(referenceId)),
    ...overrides,
  } satisfies LibraryOperationsClient;
}

function renderLibrary(libraryClient: LibraryOperationsClient, initial = readyLibraryOutcome) {
  return render(
    <ThemeProvider initialPreference="system">
      <LibraryCare client={libraryClient} initialOutcome={initial} />
    </ThemeProvider>,
  );
}

describe("LibraryCare", () => {
  it("presents a coherent attention queue with accessible filters and themes", async () => {
    const user = userEvent.setup();
    renderLibrary(client());

    expect(
      screen.getByRole("heading", { level: 1, name: "Make every title feel finished." }),
    ).toBeVisible();
    expect(screen.getByText("4 titles need a finishing touch")).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect Ember Coast" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect Northern Lights" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Artwork" }));
    expect(screen.getByRole("button", { name: "Inspect Northern Lights" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect Glass Harbour" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Inspect Ember Coast" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search attention items" }));
    await user.type(screen.getByRole("searchbox", { name: "Search attention items" }), "northern");
    expect(screen.getByText("1 title")).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect Northern Lights" })).toBeVisible();
  });

  it("opens a keyboard-dismissible inspector and restores focus to its card", async () => {
    const user = userEvent.setup();
    renderLibrary(client());
    const trigger = screen.getByRole("button", { name: "Inspect Ember Coast" });

    await user.click(trigger);
    const close = screen.getByRole("button", { name: "Close library inspector" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(screen.getByRole("heading", { name: "Editorial details" })).toBeVisible();

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("button", { name: "Close library inspector" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("submits only editable metadata with an opaque idempotent operation", async () => {
    const user = userEvent.setup();
    const libraryClient = client();
    renderLibrary(libraryClient);
    await user.click(screen.getByRole("button", { name: "Inspect Ember Coast" }));

    const inspector = screen.getByRole("dialog");
    await user.clear(within(inspector).getByLabelText("Title"));
    await user.type(within(inspector).getByLabelText("Title"), "Ember Coast: Restored");
    await user.type(within(inspector).getByLabelText("Overview"), "A restored coastal mystery.");
    await user.click(within(inspector).getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(libraryClient.updateMetadata).toHaveBeenCalledOnce());
    expect(libraryClient.updateMetadata).toHaveBeenCalledWith(
      `media_${"a".repeat(22)}`,
      {
        overview: "A restored coastal mystery.",
        title: "Ember Coast: Restored",
        year: 2026,
      },
      {
        csrfToken: readyLibraryOutcome.snapshot.csrfToken,
        idempotencyKey: expect.stringMatching(/^library-metadata-[0-9a-f-]{36}$/u),
      },
    );
    expect(await screen.findByText(/Metadata accepted/u)).toBeInTheDocument();
  });

  it("proxies provider artwork and applies only the selected opaque result", async () => {
    const user = userEvent.setup();
    const libraryClient = client();
    renderLibrary(libraryClient);
    await user.click(screen.getByRole("button", { name: "Inspect Northern Lights" }));
    await user.click(screen.getByRole("button", { name: "Find artwork" }));

    expect(await screen.findByText("TMDB")).toBeVisible();
    const preview = screen.getByRole("dialog").querySelector("img");
    expect(preview).toHaveAttribute(
      "src",
      `/api/library/artwork-searches/${searchId}/results/${resultId}/preview`,
    );
    await user.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(libraryClient.applyArtwork).toHaveBeenCalledOnce());
    expect(libraryClient.applyArtwork).toHaveBeenCalledWith(searchId, resultId, {
      csrfToken: readyLibraryOutcome.snapshot.csrfToken,
      idempotencyKey: expect.stringMatching(/^library-artwork-[A-Za-z0-9_-]+-[0-9a-f-]{36}$/u),
    });
    expect(await screen.findByText(/Artwork accepted/u)).toBeInTheDocument();
  });

  it("renders exact loading, empty, and unavailable states", () => {
    const pending = client({ load: () => new Promise(() => undefined) });
    const loading = render(
      <ThemeProvider initialPreference="system">
        <LibraryCare client={pending} />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Loading library care")).toHaveAttribute("aria-busy", "true");

    loading.unmount();
    render(
      <ThemeProvider initialPreference="system">
        <LibraryCare client={client()} initialOutcome={{ status: "unavailable" }} />
      </ThemeProvider>,
    );
    expect(screen.getByRole("heading", { name: "Library care is offline." })).toBeVisible();
  });
});
