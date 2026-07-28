import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { AcquisitionCalendar } from "../components/acquisition-calendar";
import type {
  AcquisitionCalendarClient,
  AcquisitionCalendarLoadOutcome,
} from "../lib/acquisition-calendar";
import {
  degradedAcquisitionCalendar,
  demoAcquisitionCalendar,
  emptyAcquisitionCalendar,
  unconfiguredAcquisitionCalendar,
} from "../lib/acquisition-calendar-demo";

const ready: AcquisitionCalendarLoadOutcome = {
  calendar: demoAcquisitionCalendar,
  status: "ready",
};

const staticClient: AcquisitionCalendarClient = {
  load: async () => demoAcquisitionCalendar,
};

const meta = {
  args: { client: staticClient, initialOutcome: ready, live: false },
  argTypes: {
    client: { control: false },
    initialOutcome: { control: false },
  },
  component: AcquisitionCalendar,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Acquisition calendar",
} satisfies Meta<typeof AcquisitionCalendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };

export const AttentionFilter: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Attention" }));
    await expect(canvas.getByRole("button", { name: /Inspect Glass Horizon/i })).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /Inspect The Far Meridian/i }),
    ).not.toBeInTheDocument();
  },
};

export const EventDetails: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Inspect The Far Meridian/i }));
    const drawer = await within(canvasElement.ownerDocument.body).findByRole("dialog");
    await waitFor(() =>
      expect(within(drawer).getByRole("heading", { name: "The Far Meridian" })).toBeVisible(),
    );
    await expect(within(drawer).getByText("Read-only calendar signal")).toBeVisible();
  },
};

export const Empty: Story = {
  args: { initialOutcome: { calendar: emptyAcquisitionCalendar, status: "ready" } },
};

export const Degraded: Story = {
  args: { initialOutcome: { calendar: degradedAcquisitionCalendar, status: "ready" } },
};

export const Unconfigured: Story = {
  args: { initialOutcome: { calendar: unconfiguredAcquisitionCalendar, status: "ready" } },
};

export const Forbidden: Story = { args: { initialOutcome: { status: "forbidden" } } };

export const Loading: Story = {
  args: {
    client: { load: () => new Promise(() => undefined) },
    live: true,
  },
  render: ({ client }) => <AcquisitionCalendar client={client ?? staticClient} live />,
};
