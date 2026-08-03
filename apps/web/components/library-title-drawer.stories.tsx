import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { mediaLibraryDemoClient, mediaLibraryDemoItems } from "../lib/media-library-demo";
import { LibraryTitleDrawer } from "./library-title-drawer";

const series = mediaLibraryDemoItems.find(({ media }) => media.kind === "series")!;

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
