import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { DiscoveryMovieResult, DiscoverySeriesResult } from "@omnifin/contracts/discovery";
import type {
  MediaRequestResponse,
  MediaRequestRoutingOptionsResponse,
} from "@omnifin/contracts/requests";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  MediaRequestClientError,
  type MediaRequestClient,
  type MediaRequestEligibility,
} from "../lib/media-requests";
import { RequestComposer } from "./request-composer";

const csrfToken = "request_composer_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Mina",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Mina Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "mina",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.requester],
  role: "requester",
  sessionId: "session-mina",
  userId: "user-mina",
};
const eligibility: MediaRequestEligibility = {
  snapshot: {
    csrfToken,
    jellyfinDisplayName: "Mina Jellyfin",
    jellyfinHealth: "linked",
    principal,
  },
  status: "ready",
};
const movie: DiscoveryMovieResult = {
  availability: "unavailable",
  id: "movie:603",
  kind: "movie",
  originalTitle: "The Matrix",
  overview: "A hacker discovers the nature of reality.",
  source: "seerr",
  title: "The Matrix",
  tmdbId: 603,
  voteAverage: 8.2,
  year: 1999,
};
const series: DiscoverySeriesResult = {
  availability: "partial",
  id: "series:1396",
  kind: "series",
  originalTitle: "Breaking Bad",
  overview: "A chemistry teacher turns to manufacturing.",
  source: "seerr",
  title: "Breaking Bad",
  tmdbId: 1396,
  voteAverage: 8.9,
  year: 2008,
};

function routingReference(name: string) {
  return `routing-v1.v2.${name}.${"a".repeat(32)}.${"b".repeat(32)}`;
}

const routingOptions: MediaRequestRoutingOptionsResponse = {
  destinations: [
    {
      id: routingReference("sonarr-main"),
      isDefault: true,
      label: "Series archive",
      languageProfiles: [
        { id: routingReference("language-original"), isDefault: true, label: "Original" },
        { id: routingReference("language-english"), isDefault: false, label: "English" },
      ],
      qualityProfiles: [
        { id: routingReference("quality-balanced"), isDefault: true, label: "Balanced" },
        { id: routingReference("quality-remux"), isDefault: false, label: "Remux" },
      ],
      rootFolders: [
        {
          availableBytes: 420_000_000_000,
          capacityBytes: 1_000_000_000_000,
          id: routingReference("root-series"),
          isDefault: true,
          label: "Series",
        },
        {
          availableBytes: 1_400_000_000_000,
          capacityBytes: 2_000_000_000_000,
          id: routingReference("root-archive"),
          isDefault: false,
          label: "Archive",
        },
      ],
      service: "sonarr",
    },
  ],
  expiresAt: "2026-07-27T12:15:00.000Z",
  failures: [],
  generatedAt: "2026-07-27T12:00:00.000Z",
  is4k: false,
  kind: "series",
};

function response(input: {
  is4k: boolean;
  kind: "movie" | "series";
  seasons: number[] | null;
  tmdbId: number;
}): MediaRequestResponse {
  return {
    createdAt: "2026-07-27T12:01:00.000Z",
    id: "request:42",
    source: "seerr",
    status: "pending",
    ...input,
  };
}

function client(
  create: MediaRequestClient["create"] = async (input) => ({
    replayed: false,
    request: response({
      is4k: input.is4k,
      kind: input.kind,
      seasons: input.kind === "series" && input.seasons !== "all" ? input.seasons : null,
      tmdbId: input.tmdbId,
    }),
  }),
  loadEligibility: MediaRequestClient["loadEligibility"] = async () => eligibility,
  loadRoutingOptions: MediaRequestClient["loadRoutingOptions"] = async (kind, is4k) => ({
    ...routingOptions,
    destinations: routingOptions.destinations.map((destination) => ({
      ...destination,
      service: kind === "movie" ? "radarr" : "sonarr",
    })),
    is4k,
    kind,
  }),
): MediaRequestClient {
  return { create, loadEligibility, loadRoutingOptions };
}

describe("request composer", () => {
  it("gates the form on a live session and exact linked identity", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <RequestComposer
        client={client(undefined, async () => ({ status: "link_required" }))}
        media={movie}
        onOpenChange={onOpenChange}
        open
      />,
    );

    expect(await screen.findByRole("heading", { name: "Finish account pairing" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Link Jellyfin account/i })).toHaveAttribute(
      "href",
      "/link/jellyfin",
    );
    await user.click(screen.getByRole("button", { name: "Close request composer" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("composes a granular series request and confirms the normalized result", async () => {
    const create = vi.fn<MediaRequestClient["create"]>(async (input) => ({
      replayed: false,
      request: response({
        is4k: input.is4k,
        kind: input.kind,
        seasons: input.kind === "series" && input.seasons !== "all" ? input.seasons : null,
        tmdbId: input.tmdbId,
      }),
    }));
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RequestComposer
        client={client(create)}
        media={series}
        onCreated={onCreated}
        onOpenChange={onOpenChange}
        open
      />,
    );

    expect(await screen.findByText("Mina Jellyfin")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /4K/i }));
    await user.click(screen.getByRole("button", { name: /Specific/i }));
    const seasonInput = screen.getByRole("spinbutton", { name: "Season number" });
    await user.clear(seasonInput);
    await user.type(seasonInput, "2");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.clear(seasonInput);
    await user.type(seasonInput, "4");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        { is4k: true, kind: "series", seasons: [2, 4], tmdbId: 1396 },
        expect.objectContaining({
          csrfToken,
          idempotencyKey: expect.stringMatching(/^media-/u),
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Request received" })).toBeVisible();
    expect(screen.getByText("#42")).toBeVisible();
    expect(onCreated).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("submits only opaque, user-bound choices for explicit Seerr routing", async () => {
    const create = vi.fn<MediaRequestClient["create"]>(async (input) => ({
      replayed: false,
      request: response({
        is4k: input.is4k,
        kind: input.kind,
        seasons: input.kind === "series" && input.seasons !== "all" ? input.seasons : null,
        tmdbId: input.tmdbId,
      }),
    }));
    const loadRoutingOptions = vi.fn<MediaRequestClient["loadRoutingOptions"]>(
      async () => routingOptions,
    );
    const user = userEvent.setup();
    render(
      <RequestComposer
        client={client(create, undefined, loadRoutingOptions)}
        media={series}
        onOpenChange={vi.fn()}
        open
      />,
    );

    await screen.findByText("Mina Jellyfin");
    await user.click(screen.getByText("Advanced routing"));
    expect(await screen.findByRole("combobox", { name: /Destination/i })).toHaveValue(
      routingReference("sonarr-main"),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: /Quality profile/i }), [
      routingReference("quality-remux"),
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: /Root folder/i }), [
      routingReference("root-archive"),
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: /Language profile/i }), [
      routingReference("language-english"),
    ]);
    await user.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(loadRoutingOptions).toHaveBeenCalledOnce();
    expect(loadRoutingOptions).toHaveBeenCalledWith("series", false, expect.any(AbortSignal));
    expect(create.mock.calls[0]?.[0]).toEqual({
      is4k: false,
      kind: "series",
      routing: {
        destination: routingReference("sonarr-main"),
        languageProfile: routingReference("language-english"),
        qualityProfile: routingReference("quality-remux"),
        rootFolder: routingReference("root-archive"),
      },
      seasons: "all",
      tmdbId: 1396,
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("/srv/");
  });

  it("preserves the idempotency key when a network outcome is ambiguous", async () => {
    const create = vi
      .fn<MediaRequestClient["create"]>()
      .mockRejectedValueOnce(
        new MediaRequestClientError(
          "unavailable",
          "service_unavailable",
          "The gateway could not be reached.",
          "same_key",
        ),
      )
      .mockResolvedValueOnce({
        replayed: true,
        request: response({ is4k: false, kind: "movie", seasons: null, tmdbId: 603 }),
      });
    const user = userEvent.setup();
    render(<RequestComposer client={client(create)} media={movie} onOpenChange={vi.fn()} open />);

    await user.click(await screen.findByRole("button", { name: /Send request/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request interrupted");
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: /Send request/i }));
    await screen.findByRole("heading", { name: "Request received" });

    const firstKey = create.mock.calls[0]?.[1].idempotencyKey;
    const secondKey = create.mock.calls[1]?.[1].idempotencyKey;
    expect(firstKey).toBeDefined();
    expect(secondKey).toBe(firstKey);
    expect(screen.getByText(/earlier successful outcome was safely recovered/i)).toBeVisible();
  });

  it("keeps specific-season submission disabled until a season is selected", async () => {
    const create = vi.fn<MediaRequestClient["create"]>();
    const user = userEvent.setup();
    render(<RequestComposer client={client(create)} media={series} onOpenChange={vi.fn()} open />);

    await user.click(await screen.findByRole("button", { name: /Specific/i }));
    expect(screen.getByRole("button", { name: /Send request/i })).toBeDisabled();
    expect(screen.getByText("Add at least one season to continue.")).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks submission when the selected format has no healthy default route", async () => {
    const create = vi.fn<MediaRequestClient["create"]>();
    render(
      <RequestComposer
        client={client(create, undefined, async (kind, is4k) => ({
          ...routingOptions,
          destinations: [],
          is4k,
          kind,
        }))}
        media={movie}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(await screen.findByText("Automatic route unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: /Send request/i })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});
