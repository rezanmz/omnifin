import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { mediaLibraryDemoClient, mediaLibraryDemoItems } from "../lib/media-library-demo";
import { LibraryTitleDrawer } from "./library-title-drawer";

const series = mediaLibraryDemoItems.find(({ media }) => media.kind === "series")!;
const movie = mediaLibraryDemoItems.find(({ media }) => media.kind === "movie")!;

const meta = {
  args: {
    client: mediaLibraryDemoClient,
    item: series,
    onClose: fn(),
    onPlay: fn(),
    open: true,
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
    await waitFor(() => expect(within(dialog).getByText("Mara Voss")).toBeVisible());
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
    item: movie,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const dialog = await canvas.findByRole("dialog", { name: "Ember Coast details" });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Download" })).toBeVisible(),
    );
  },
};
