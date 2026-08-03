import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoDashboard } from "../lib/dashboard-data";
import { CalendarStrip } from "./calendar-strip";

const meta = {
  args: { items: demoDashboard.calendar },
  component: CalendarStrip,
  decorators: [
    (Story) => (
      <div style={{ padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Calendar strip",
} satisfies Meta<typeof CalendarStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Upcoming: Story = {};
export const Quiet: Story = { args: { items: [] } };
export const Loading: Story = { args: { items: [], state: "loading" } };
export const Unavailable: Story = {
  args: { items: [], onRetry: () => undefined, state: "unavailable" },
};
export const Forbidden: Story = { args: { items: [], state: "forbidden" } };
export const SignedOut: Story = { args: { items: [], state: "signed_out" } };
export const Unconfigured: Story = { args: { items: [], state: "unconfigured" } };
export const Degraded: Story = { args: { degraded: true } };
