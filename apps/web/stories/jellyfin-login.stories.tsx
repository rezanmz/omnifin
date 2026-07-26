import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { JellyfinCredentialScreen } from "../components/jellyfin-credential-screen";

const meta = {
  component: JellyfinCredentialScreen,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Authentication/Jellyfin credentials",
} satisfies Meta<typeof JellyfinCredentialScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const InvalidCredentials: Story = { args: { initialStatus: "invalid_credentials" } };
export const Unavailable: Story = { args: { initialStatus: "unavailable" } };
export const Submitting: Story = { args: { initialStatus: "submitting" } };
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
