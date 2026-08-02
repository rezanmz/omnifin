import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { AboutScreen, AboutScreenSkeleton } from "../components/about-screen";

const revision = "0123456789abcdef0123456789abcdef01234567";
const stableIdentity: RuntimeIdentity = {
  channel: "stable",
  license: "AGPL-3.0-only",
  revision,
  schemaVersion: 1,
  sourceUrl: `https://github.com/rezanmz/omnifin/tree/${revision}`,
  verification: "verified",
  version: "1.0.0",
};
const developmentIdentity: RuntimeIdentity = {
  channel: "development",
  license: "AGPL-3.0-only",
  revision: null,
  schemaVersion: 1,
  sourceUrl: "https://github.com/rezanmz/omnifin",
  verification: "development",
  version: "0.0.0-dev",
};

const meta = {
  args: { outcome: { identity: stableIdentity, status: "ready" } },
  component: AboutScreen,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/About and build identity",
} satisfies Meta<typeof AboutScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stable: Story = {};
export const Loading: Story = { render: () => <AboutScreenSkeleton /> };
export const StableLight: Story = { globals: { theme: "light" } };
export const Development: Story = {
  args: { outcome: { identity: developmentIdentity, status: "ready" } },
};
export const Unavailable: Story = { args: { outcome: { status: "unavailable" } } };
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
export const ThemeInteraction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "Light" }));
    await expect(canvas.getByRole("radio", { name: "Light" })).toBeChecked();
  },
};
