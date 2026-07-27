import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AppearanceSelector } from "../components/appearance-selector";

const meta = {
  component: AppearanceSelector,
  decorators: [
    (Story) => (
      <div style={{ margin: "0 auto", maxWidth: 1080, padding: 40 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Components/Appearance selector",
} satisfies Meta<typeof AppearanceSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const System: Story = { globals: { theme: "system" } };
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Compact: Story = { args: { compact: true } };
