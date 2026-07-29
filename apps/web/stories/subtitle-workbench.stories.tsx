import type { SubtitleSearchResponse } from "@omnifin/contracts/subtitles";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { SubtitleWorkbench } from "../components/subtitle-workbench";
import { SubtitleClientError, type SubtitleClient } from "../lib/subtitles";

const searchId = `subtitle_search_${"s".repeat(22)}`;
const resultId = `subtitle_result_${"r".repeat(22)}`;
const search: SubtitleSearchResponse = {
  expiresAt: "2026-07-28T12:20:00.000Z",
  generatedAt: "2026-07-28T12:00:00.000Z",
  media: {
    episodeNumber: 3,
    kind: "episode",
    seasonNumber: 2,
    title: "Northern Lights",
    year: 2026,
  },
  results: [
    {
      dontMatches: ["release_group"],
      forced: false,
      hearingImpaired: true,
      id: resultId,
      language: "English",
      matches: ["series", "season", "episode", "resolution"],
      originalFormat: true,
      provider: "OpenSubtitles.com",
      releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL.DDP5.1"],
      score: 94,
      uploader: "Aurora",
    },
    {
      dontMatches: [],
      forced: true,
      hearingImpaired: false,
      id: `subtitle_result_${"f".repeat(22)}`,
      language: "French",
      matches: ["series", "season", "episode"],
      originalFormat: false,
      provider: "Addic7ed",
      releaseNames: ["Northern.Lights.S02E03.FRENCH.1080p"],
      score: 86,
      uploader: null,
    },
    {
      dontMatches: ["source", "release_group"],
      forced: false,
      hearingImpaired: false,
      id: `subtitle_result_${"g".repeat(22)}`,
      language: "German",
      matches: ["series", "episode"],
      originalFormat: true,
      provider: "Embedded Subtitles",
      releaseNames: [],
      score: 72,
      uploader: "Northstar",
    },
  ],
  searchId,
};

function client(overrides: Partial<SubtitleClient> = {}): SubtitleClient {
  return {
    download: async (_searchId, selectedResultId) => ({
      download: {
        acceptedAt: "2026-07-28T12:02:00.000Z",
        resultId: selectedResultId,
        searchId,
        status: "accepted",
      },
      replayed: false,
    }),
    search: async () => search,
    ...overrides,
  };
}

const meta = {
  args: {
    client: client(),
    csrfToken: "story_subtitle_csrf_0123456789abcdefghijklmnopqrstuvwxyz",
    mediaReferenceId: `media_${"m".repeat(22)}`,
    mediaTitle: "Northern Lights",
    onClose: () => undefined,
  },
  argTypes: { client: { control: false }, onClose: { control: false } },
  component: SubtitleWorkbench,
  decorators: [
    (Story) => (
      <div
        style={{
          background:
            "radial-gradient(circle at 72% 18%, #5e887c 0, transparent 30%), linear-gradient(155deg, #3b524d, #090d0c 70%)",
          minHeight: "100dvh",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div style={{ bottom: 24, height: 96, left: 24, position: "absolute", right: 24 }}>
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Subtitle workbench",
} satisfies Meta<typeof SubtitleWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("meter", { name: "English match score" })).toHaveAttribute(
      "aria-valuenow",
      "94",
    );
    await expect(canvas.getAllByRole("article")).toHaveLength(3);
  },
};

export const Loading: Story = {
  args: { client: client({ search: async () => new Promise(() => undefined) }) },
};

export const Empty: Story = {
  args: { client: client({ search: async () => ({ ...search, results: [] }) }) },
};

export const Offline: Story = {
  args: {
    client: client({
      search: async () => {
        throw new SubtitleClientError(
          "unavailable",
          "subtitle_temporarily_unavailable",
          "The subtitle service is temporarily unavailable.",
        );
      },
    }),
  },
};

export const Accepted: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Add subtitle — English from OpenSubtitles.com",
      }),
    );
    await waitFor(() => expect(canvas.getByText(/Bazarr accepted this subtitle/u)).toBeVisible());
  },
};
