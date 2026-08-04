import type { LibraryTitleDetailResponse } from "@omnifin/contracts/library";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { LibraryTitleDrawer } from "../components/library-title-drawer";
import { mediaLibraryDemoClient, mediaLibraryDemoItems } from "../lib/media-library-demo";
import { MediaLibraryClientError, type MediaLibraryClient } from "../lib/media-library";

const series = mediaLibraryDemoItems.find((item) => item.media.kind === "series")!;
const movie = mediaLibraryDemoItems.find((item) => item.media.kind === "movie")!;

const meta = {
  args: {
    client: mediaLibraryDemoClient,
    item: series,
    onClose: fn(),
    onPlay: fn(),
    open: true,
  },
  component: LibraryTitleDrawer,
  decorators: [
    (Story) => (
      <div
        style={{
          background:
            "radial-gradient(circle at 20% 15%, rgb(78 99 128 / 35%), transparent 42%), #080b0d",
          minHeight: "100vh",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Library title drawer",
} satisfies Meta<typeof LibraryTitleDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeriesHierarchy: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Northern Lights" })).toBeVisible(),
    );
    expect(canvas.getByRole("tab", { name: /Season 1/u })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(canvas.getByRole("list", { name: "Episodes" })).toBeVisible());
    await userEvent.click(canvas.getByRole("tab", { name: /Season 2/u }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Resume The Long Meridian" })).toBeVisible(),
    );
  },
};

export const MovieDetails: Story = {
  args: { item: movie },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole("heading", { name: "Ember Coast" })).toBeVisible());
    expect(canvas.getByRole("button", { name: "Resume movie" })).toBeVisible();
    expect(canvas.getByText("The horizon remembers.")).toBeVisible();
    expect(canvas.getByText("Mara Voss")).toBeVisible();
    await userEvent.click(canvas.getByText("Media information"));
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "4K · HEVC · MKV" })).toBeVisible(),
    );
    expect(canvas.getByText("Playback starts only when you ask.")).toBeVisible();
  },
};

export const Loading: Story = {
  args: {
    client: {
      ...mediaLibraryDemoClient,
      loadTitle: () => new Promise<LibraryTitleDetailResponse>(() => undefined),
    },
  },
};

export const EmptySeries: Story = {
  args: {
    client: {
      ...mediaLibraryDemoClient,
      async loadTitle(referenceId) {
        const detail = await mediaLibraryDemoClient.loadTitle!(referenceId);
        return { ...detail, seasons: [] };
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByText(/No playable seasons are available/u)).toBeVisible(),
    );
  },
};

export const Offline: Story = {
  args: {
    client: {
      ...mediaLibraryDemoClient,
      loadTitle: () =>
        Promise.reject(
          new MediaLibraryClientError("unavailable", "service_unavailable", "Jellyfin is offline."),
        ),
    } satisfies MediaLibraryClient,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "This title is still safely in Jellyfin." }),
      ).toBeVisible(),
    );
  },
};
