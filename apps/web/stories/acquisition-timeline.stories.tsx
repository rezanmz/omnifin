import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { AcquisitionTimeline } from "../components/acquisition-timeline";
import {
  AcquisitionProvenanceClientError,
  type AcquisitionProvenanceClient,
} from "../lib/acquisition-provenance";
import { demoDashboard, type OperationModel } from "../lib/dashboard-data";

const previewOperation = demoDashboard.operations[0]!;
const liveOperation: OperationModel = {
  eta: "4m",
  id: "story-live-operation",
  progress: 0.91,
  rate: "18.2 MB/s",
  service: "Sonarr · SABnzbd",
  target: { mediaId: 77, seasonNumber: 1, service: "sonarr" },
  title: "Signal · S01E07",
};
const empty: AcquisitionProvenanceResponse = {
  events: [],
  failures: [],
  generatedAt: "2026-07-27T19:00:00.000Z",
  state: "complete",
  target: { kind: "series", mediaId: 77, seasonNumber: 1, service: "sonarr" },
};
const degraded: AcquisitionProvenanceResponse = {
  ...previewOperation.provenance!,
  failures: [
    {
      code: "timeout",
      message: "Radarr queue is temporarily unavailable.",
      occurredAt: "2026-07-27T19:00:00.000Z",
      operation: "acquisition.queue",
      retryable: true,
      service: "radarr",
    },
  ],
  state: "degraded",
};

function client(read: AcquisitionProvenanceClient["read"]): AcquisitionProvenanceClient {
  return { read };
}

const meta = {
  args: {
    operation: previewOperation,
    onOpenChange: () => undefined,
    open: true,
  },
  argTypes: { client: { control: false }, onOpenChange: { control: false } },
  component: AcquisitionTimeline,
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100dvh", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Acquisition timeline",
} satisfies Meta<typeof AcquisitionTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("Release grabbed")).toBeVisible());
  },
};

export const CompleteLight: Story = { globals: { theme: "light" } };

export const Loading: Story = {
  args: {
    client: client(async () => new Promise<AcquisitionProvenanceResponse>(() => undefined)),
    operation: liveOperation,
  },
};

export const Empty: Story = {
  args: { client: client(async () => empty), operation: liveOperation },
};

export const Degraded: Story = {
  args: { operation: { ...previewOperation, provenance: degraded } },
};

export const PermissionDenied: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new AcquisitionProvenanceClientError(
          "forbidden",
          "permission_denied",
          "This action is not permitted.",
        ),
      ),
    ),
    operation: liveOperation,
  },
};

export const Offline: Story = {
  args: {
    client: client(async () =>
      Promise.reject(
        new AcquisitionProvenanceClientError(
          "unavailable",
          "service_unavailable",
          "The gateway is unavailable.",
        ),
      ),
    ),
    operation: liveOperation,
  },
};
