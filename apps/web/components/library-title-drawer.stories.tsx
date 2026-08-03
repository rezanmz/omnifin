import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

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
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Northern Lights details" });
    await expect(within(dialog).getByRole("tab", { name: /Season 1/u })).toBeVisible();
    await expect(await within(dialog).findByRole("list", { name: "Episodes" })).toBeVisible();
  },
};

export const EpisodeDetailsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Northern Lights details" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "View details for The Long Meridian" }),
    );
    await expect(
      within(dialog).getByRole("region", { name: "The Long Meridian episode details" }),
    ).toBeVisible();
    await expect(within(dialog).getByText("Mara Voss")).toBeVisible();
  },
};
