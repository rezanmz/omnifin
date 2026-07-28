import type { ManualReleaseGrabResponse } from "@omnifin/contracts/acquisition";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { ManualReleaseWorkbench } from "../components/manual-release-workbench";
import {
  ManualReleaseClientError,
  type ManualReleaseClient,
  type ManualReleaseEligibility,
} from "../lib/manual-releases";
import { demoDashboard } from "../lib/dashboard-data";
import {
  manualReleaseOperator,
  manualReleaseSearch,
  rejectedManualRelease,
} from "../test/manual-release-fixtures";

const operation = demoDashboard.operations[0]!;
const receipt: ManualReleaseGrabResponse = {
  acceptedAt: "2026-07-27T12:01:00.000Z",
  operationId: "release_grab_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  releaseId: rejectedManualRelease.id,
  service: "radarr",
  state: "accepted",
};
const eligibility: ManualReleaseEligibility = {
  snapshot: {
    csrfToken: "story_manual_release_csrf_0123456789abcdefghijklmnop",
    principal: manualReleaseOperator,
  },
  status: "ready",
};

function client(overrides: Partial<ManualReleaseClient> = {}): ManualReleaseClient {
  return {
    grab: async () => ({ grab: receipt, replayed: false }),
    loadEligibility: async () => eligibility,
    search: async () => manualReleaseSearch,
    ...overrides,
  };
}

const meta = {
  args: {
    client: client(),
    onOpenChange: () => undefined,
    open: true,
    operation,
  },
  argTypes: { client: { control: false }, onOpenChange: { control: false } },
  component: ManualReleaseWorkbench,
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100dvh", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Manual release workbench",
} satisfies Meta<typeof ManualReleaseWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByText("+1450")).toHaveLength(2));
    await expect(canvas.getAllByRole("radio")).toHaveLength(2);
  },
};

export const ReadyLight: Story = { globals: { theme: "light" } };

export const Loading: Story = {
  args: {
    client: client({ search: async () => new Promise(() => undefined) }),
  },
};

export const Empty: Story = {
  args: { client: client({ search: async () => ({ ...manualReleaseSearch, releases: [] }) }) },
};

export const RejectedConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("radio", { name: /1080p\.WEB-DL/u }));
    await userEvent.click(canvas.getByRole("button", { name: "Review grab" }));
    await expect(canvas.getByRole("button", { name: "Send release" })).toBeDisabled();
    await expect(
      canvas.getByRole("checkbox", { name: /authorize this override/u }),
    ).toBeInTheDocument();
  },
};

export const Accepted: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Review grab" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send release" }));
    await waitFor(() => expect(canvas.getByText("Release accepted")).toBeVisible());
  },
};

export const PermissionDenied: Story = {
  args: { client: client({ loadEligibility: async () => ({ status: "forbidden" }) }) },
};

export const Offline: Story = {
  args: {
    client: client({
      search: async () =>
        Promise.reject(
          new ManualReleaseClientError(
            "unavailable",
            "service_unavailable",
            "The gateway is unavailable.",
          ),
        ),
    }),
  },
};
