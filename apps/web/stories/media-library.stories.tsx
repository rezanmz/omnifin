import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { MediaLibrary } from "../components/media-library";
import StandaloneApplicationShell from "../components/standalone-application-shell";
import {
  emptyMediaLibraryOutcome,
  readyMediaLibraryOutcome,
  unavailableMediaLibraryOutcome,
} from "../lib/media-library-demo";

const meta = {
  component: MediaLibrary,
  decorators: [
    (Story, context) => (
      <StandaloneApplicationShell
        accent="#6f8d84"
        current="library"
        displayProfile="standard"
        status="attention"
        themePreference={(context.args.themePreference as "dark" | "light" | "system") ?? "system"}
      >
        <Story />
      </StandaloneApplicationShell>
    ),
  ],
  parameters: { layout: "fullscreen" },
  title: "Screens/Media library",
} satisfies Meta<typeof MediaLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: { initialOutcome: readyMediaLibraryOutcome, live: false },
};

export const Light: Story = {
  args: { initialOutcome: readyMediaLibraryOutcome, live: false, themePreference: "light" },
  globals: { theme: "light" },
};

export const Loading: Story = {
  args: { initialOutcome: { status: "loading" }, live: false },
};

export const Empty: Story = {
  args: { initialOutcome: emptyMediaLibraryOutcome, live: false },
};

export const Unavailable: Story = {
  args: { initialOutcome: unavailableMediaLibraryOutcome, live: false },
};

export const SignedOut: Story = {
  args: { initialOutcome: { status: "signed_out" }, live: false },
};

export const PermissionDenied: Story = {
  args: { initialOutcome: { status: "forbidden" }, live: false },
};
