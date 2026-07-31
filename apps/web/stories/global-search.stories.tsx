import type { DiscoverySearchResponse } from "@omnifin/contracts/discovery";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { GlobalSearch } from "../components/global-search";
import { DiscoverySearchClientError, type DiscoverySearchClient } from "../lib/discovery-search";

const readyResponse: DiscoverySearchResponse = {
  generatedAt: "2026-07-27T08:00:00.000Z",
  items: [
    {
      availability: "available",
      id: "movie:603",
      kind: "movie",
      originalTitle: "The Matrix",
      overview: "A hacker discovers that the world he knows is a constructed reality.",
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
      overview: "A chemistry teacher turns to manufacturing after a life-changing diagnosis.",
      source: "seerr",
      title: "Breaking Bad",
      tmdbId: 1396,
      voteAverage: 8.9,
      year: 2008,
    },
    {
      id: "person:287",
      kind: "person",
      knownFor: [
        { kind: "movie", title: "Fight Club", year: 1999 },
        { kind: "movie", title: "Se7en", year: 1995 },
      ],
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

function client(search: DiscoverySearchClient["search"]): DiscoverySearchClient {
  return { search };
}

const meta = {
  args: {
    client: client(async () => readyResponse),
    debounceMs: 0,
    initialOpen: true,
    initialPermissions: [
      "media.view",
      "library.manage",
      "request.review",
      "downloads.manage",
      "acquisition.manage",
      "issue.manage",
      "connectors.manage",
      "roles.manage",
      "recovery.oidc.manage",
    ],
    initialQuery: "matrix",
  },
  component: GlobalSearch,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 720, padding: 32, width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Global search",
} satisfies Meta<typeof GlobalSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const result = await canvas.findByRole("option", { name: /The Matrix/i });
    await waitFor(() => expect(result).toBeVisible());
    await waitFor(() => expect(canvas.getByRole("heading", { name: "The Matrix" })).toBeVisible());
  },
};

export const Prompt: Story = { args: { initialQuery: "" } };

export const CommandFilter: Story = {
  args: { initialPermissions: ["downloads.manage"], initialQuery: "d" },
  play: async ({ canvasElement }) => {
    const command = await within(canvasElement).findByRole("option", { name: /Download queue/i });
    await waitFor(() => expect(command).toBeVisible());
  },
};

export const Loading: Story = {
  args: {
    client: client(async () => new Promise<DiscoverySearchResponse>(() => undefined)),
  },
};

export const Empty: Story = {
  args: {
    client: client(async () => ({ ...readyResponse, items: [], totalResults: 0 })),
  },
  play: async ({ canvasElement }) => {
    const message = await within(canvasElement).findByText(/No signal for/i);
    await waitFor(() => expect(message).toBeVisible());
  },
};

export const NotConfigured: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new DiscoverySearchClientError(
          "not_configured",
          "discovery_not_configured",
          "Discovery has not been configured.",
        ),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const message = await within(canvasElement).findByText("Discovery is not connected");
    await waitFor(() => expect(message).toBeVisible());
  },
};

export const RateLimited: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new DiscoverySearchClientError(
          "rate_limited",
          "discovery_rate_limited",
          "Discovery is temporarily rate limited.",
        ),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const message = await within(canvasElement).findByText("Search is cooling down");
    await waitFor(() => expect(message).toBeVisible());
  },
};

export const SignedOut: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new DiscoverySearchClientError(
          "signed_out",
          "authentication_required",
          "Sign in to continue.",
        ),
      ),
    ),
  },
  play: async ({ canvasElement }) => {
    const message = await within(canvasElement).findByText("Sign in to search");
    await waitFor(() => expect(message).toBeVisible());
  },
};
