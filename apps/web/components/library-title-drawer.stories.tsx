import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { mediaLibraryDemoClient, mediaLibraryDemoItems } from "../lib/media-library-demo";
import { LibraryTitleDrawer } from "./library-title-drawer";

const series = mediaLibraryDemoItems.find(({ media }) => media.kind === "series")!;
const movie = mediaLibraryDemoItems.find(({ media }) => media.kind === "movie")!;

const connectedSeriesClient = {
  ...mediaLibraryDemoClient,
  loadConnectedActions: async (referenceId: string) => ({
    actions: [
      {
        href: `/v1/media/library/${referenceId}/actions/sonarr`,
        kind: "service_navigation" as const,
        label: "Open in Sonarr",
        service: "sonarr" as const,
      },
    ],
    generatedAt: "2026-07-30T12:00:00.000Z",
    mediaKind: "series" as const,
    referenceId,
  }),
};

const meta = {
  args: {
    client: connectedSeriesClient,
    onClose: fn(),
    onPlay: fn(),
    open: true,
    selection: {
      kind: series.media.kind,
      referenceId: series.media.id,
      title: series.media.title,
    },
  },
  component: LibraryTitleDrawer,
  parameters: { layout: "fullscreen" },
  title: "Components/Library title drawer",
} satisfies Meta<typeof LibraryTitleDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesEpisodeGuide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole("dialog", { name: "Northern Lights details" });
    const seasonTab = within(dialog).getByRole("tab", { name: /Season 1/u });
    seasonTab.scrollIntoView({ block: "center" });
    await waitFor(() => expect(seasonTab).toBeVisible());
    const episodeList = await within(dialog).findByRole("list", { name: "Episodes" });
    episodeList.scrollIntoView({ block: "center" });
    await waitFor(() => expect(episodeList).toBeVisible());
  },
};

export const EpisodeDetailsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole("dialog", { name: "Northern Lights details" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "View details for The Long Meridian" }),
    );
    const episodeDetail = within(dialog).getByRole("region", {
      name: "The Long Meridian episode details",
    });
    episodeDetail.scrollIntoView({ block: "center" });
    await waitFor(() => expect(episodeDetail).toBeVisible());
    expect(
      await within(episodeDetail).findByRole("button", { name: "View Mara Voss profile" }),
    ).toBeVisible();
    expect(
      await within(episodeDetail).findByRole("link", { name: "Open in Sonarr in a new tab" }),
    ).toHaveAttribute("href", `/api/media/library/${series.media.id}/actions/sonarr`);
  },
};

export const OwnedMoviePersonProfile: Story = {
  args: {
    selection: {
      kind: movie.media.kind,
      referenceId: movie.media.id,
      title: movie.media.title,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const libraryDialog = await canvas.findByRole("dialog", { name: "Ember Coast details" });
    await userEvent.click(
      await within(libraryDialog).findByRole("button", { name: "View Mara Voss profile" }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("dialog", { name: /(?:Mara Voss person context|Person context)/u }),
      ).toBeVisible(),
    );
  },
};

export const AdminOriginalFile: Story = {
  args: {
    client: {
      ...mediaLibraryDemoClient,
      loadDownloadEligibility: async () => ({
        snapshot: { csrfToken: "storybook-original-download-csrf" },
        status: "ready" as const,
      }),
      prepareDownload: async (referenceId) => {
        const grantId = `media_download_${"d".repeat(22)}`;
        return {
          archiveRetrieval: "possible" as const,
          contentType: "video/x-matroska",
          expiresAt: "2026-07-30T12:05:00.000Z",
          filename: "Ember Coast (2026).mkv",
          generatedAt: "2026-07-30T12:00:00.000Z",
          grantId,
          path: `/v1/media/library/downloads/${grantId}`,
          referenceId,
          sizeBytes: 6_979_321_856,
        };
      },
    },
    selection: {
      kind: movie.media.kind,
      referenceId: movie.media.id,
      title: movie.media.title,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole("dialog", { name: "Ember Coast details" });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Download" })).toBeVisible(),
    );
  },
};
