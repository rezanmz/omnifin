import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { DiscoveryMovieResult, DiscoverySeriesResult } from "@omnifin/contracts/discovery";
import type { MediaRequestRoutingOptionsResponse } from "@omnifin/contracts/requests";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { RequestComposer } from "../components/request-composer";
import {
  MediaRequestClientError,
  type MediaRequestClient,
  type MediaRequestEligibility,
} from "../lib/media-requests";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Mina",
  externalIdentity: {
    displayClaims: { displayName: "Mina" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "mina-subject",
  },
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Mina’s Jellyfin",
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
    csrfToken: "storybook_request_csrf_0123456789abcdefghijklmnopqrstuvwxyz",
    jellyfinDisplayName: "Mina’s Jellyfin",
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
  return `routing-v1.v2.${name}.${"c".repeat(32)}.${"d".repeat(32)}`;
}

const seriesRoutingOptions: MediaRequestRoutingOptionsResponse = {
  destinations: [
    {
      id: routingReference("sonarr-main"),
      isDefault: true,
      label: "Series archive",
      languageProfiles: [
        { id: routingReference("language-original"), isDefault: true, label: "Original" },
      ],
      qualityProfiles: [
        { id: routingReference("quality-balanced"), isDefault: true, label: "Balanced" },
        { id: routingReference("quality-remux"), isDefault: false, label: "Remux" },
      ],
      rootFolders: [
        {
          availableBytes: 1_400_000_000_000,
          capacityBytes: 2_000_000_000_000,
          id: routingReference("root-series"),
          isDefault: true,
          label: "Series",
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

function client(
  loadEligibility: MediaRequestClient["loadEligibility"] = async () => eligibility,
  create: MediaRequestClient["create"] = async (input) => ({
    replayed: false,
    request: {
      createdAt: "2026-07-27T12:01:00.000Z",
      id: "request:42",
      is4k: input.is4k,
      kind: input.kind,
      seasons: input.kind === "series" && input.seasons !== "all" ? input.seasons : null,
      source: "seerr",
      status: "pending",
      tmdbId: input.tmdbId,
    },
  }),
  loadRoutingOptions: MediaRequestClient["loadRoutingOptions"] = async (kind, is4k) => {
    const dimension = is4k ? "-4k" : "";
    return {
      ...seriesRoutingOptions,
      destinations: seriesRoutingOptions.destinations.map((destination) => ({
        ...destination,
        id: routingReference(`destination${dimension}`),
        languageProfiles: destination.languageProfiles.map((profile, index) => ({
          ...profile,
          id: routingReference(`language-${index + 1}${dimension}`),
        })),
        qualityProfiles: destination.qualityProfiles.map((profile, index) => ({
          ...profile,
          id: routingReference(`quality-${index + 1}${dimension}`),
        })),
        rootFolders: destination.rootFolders.map((folder, index) => ({
          ...folder,
          id: routingReference(`root-${index + 1}${dimension}`),
        })),
        service: kind === "movie" ? "radarr" : "sonarr",
      })),
      is4k,
      kind,
    };
  },
): MediaRequestClient {
  return { create, loadEligibility, loadRoutingOptions };
}

const meta = {
  args: {
    client: client(),
    media: movie,
    onOpenChange: () => undefined,
    open: true,
  },
  argTypes: { client: { control: false }, onCreated: { control: false } },
  component: RequestComposer,
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100dvh", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Request composer",
} satisfies Meta<typeof RequestComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MovieReady: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Mina’s Jellyfin")).toBeVisible());
    await expect(canvas.getByRole("button", { name: /Send request/i })).toBeEnabled();
  },
};

export const SeriesReady: Story = { args: { media: series } };

export const AdvancedRouting: Story = {
  args: { media: series },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Mina’s Jellyfin")).toBeVisible());
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "Quality profile" })).toBeEnabled(),
    );
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Quality profile" }), [
      routingReference("quality-2"),
    ]);
    await userEvent.click(canvas.getByText("Advanced routing"));
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: /Destination/i })).toHaveValue(
        routingReference("destination"),
      ),
    );
    await expect(canvas.getByText("Remux · Series archive")).toBeVisible();
  },
};

export const LoadingIdentity: Story = {
  args: {
    client: client(async () => new Promise<MediaRequestEligibility>(() => undefined)),
  },
};

export const PairingRequired: Story = {
  args: { client: client(async () => ({ status: "link_required" })) },
  play: async ({ canvasElement }) => {
    const message = await within(canvasElement).findByRole("heading", {
      name: "Finish account pairing",
    });
    await waitFor(() => expect(message).toBeVisible());
  },
};

export const PermissionDenied: Story = {
  args: { client: client(async () => ({ status: "forbidden" })) },
};

export const OfflineIdentityCheck: Story = {
  args: { client: client(async () => ({ status: "unavailable" })) },
};

export const RequestInterrupted: Story = {
  args: {
    client: client(undefined, async () =>
      Promise.reject(
        new MediaRequestClientError(
          "unavailable",
          "service_unavailable",
          "The gateway could not be reached.",
          "same_key",
        ),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Send request/i }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Request interrupted");
  },
};

export const Accepted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Send request/i }));
    const message = await canvas.findByRole("heading", { name: "Request received" });
    await waitFor(() => expect(message).toBeVisible());
  },
};
