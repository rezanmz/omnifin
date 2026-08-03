import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { ViewingHistory } from "../components/viewing-history";
import { demoViewingHistory, emptyViewingHistory } from "../lib/viewing-history-demo";

const meta = {
  component: ViewingHistory,
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Routes/Viewing history",
} satisfies Meta<typeof ViewingHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: {
    initialOutcome: { history: demoViewingHistory, status: "ready" },
    live: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Your story, in sequence." })).toBeVisible();
    await expect(canvas.getByText("Only you")).toBeVisible();
  },
};

export const CompletedMovies: Story = {
  ...Ready,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "Movies" }));
    await userEvent.click(canvas.getByRole("radio", { name: "Completed" }));
    await expect(canvas.getByRole("heading", { name: "1 title in view" })).toBeVisible();
  },
};

export const Empty: Story = {
  args: {
    initialOutcome: { history: emptyViewingHistory, status: "ready" },
    live: false,
  },
};

export const Offline: Story = {
  args: { initialOutcome: { status: "unavailable" }, live: false },
};
