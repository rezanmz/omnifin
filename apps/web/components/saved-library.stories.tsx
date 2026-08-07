import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { emptySavedPage, readySavedOutcome, readySavedPage } from "../lib/saved-lists-demo";
import { SavedLibrary } from "./saved-library";

const meta = {
  component: SavedLibrary,
  parameters: { layout: "fullscreen" },
  title: "Destinations/Saved library",
} satisfies Meta<typeof SavedLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: { demo: true, initialOutcome: readySavedOutcome, initialPage: readySavedPage, live: false },
};

export const Empty: Story = {
  args: { demo: true, initialOutcome: readySavedOutcome, initialPage: emptySavedPage, live: false },
};

export const Unavailable: Story = {
  args: { initialOutcome: { status: "unavailable" }, live: false },
};

export const SignedOut: Story = {
  args: { initialOutcome: { status: "signed_out" }, live: false },
};
