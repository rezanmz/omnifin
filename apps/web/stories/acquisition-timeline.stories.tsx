import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";

import { AcquisitionTimeline } from "../components/acquisition-timeline";
import {
  AcquisitionProvenanceClientError,
  type AcquisitionProvenanceClient,
  type AcquisitionProvenanceStreamCallbacks,
} from "../lib/acquisition-provenance";
import {
  AcquisitionRecoveryClientError,
  type AcquisitionRecoveryClient,
} from "../lib/acquisition-recovery";
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
const queueRecoveryReference = `aqr_v2.${"A".repeat(100)}`;
const stalledOperation: OperationModel = {
  ...previewOperation,
  id: "story-stalled-operation",
  provenance: {
    ...previewOperation.provenance!,
    events: [
      {
        ...previewOperation.provenance!.events[0]!,
        id: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "stalled",
        recovery: {
          expiresAt: "2026-07-27T19:05:00.000Z",
          reference: queueRecoveryReference,
        },
        state: "warning",
        summary: "Download needs operator attention before import can continue.",
      },
    ],
  },
};
const operator: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-27T21:00:00.000Z",
  issuedAt: "2026-07-27T19:00:00.000Z",
  linkedServices: [],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "story-operator-session",
  userId: "story-operator-user",
};

function client(read: AcquisitionProvenanceClient["read"]): AcquisitionProvenanceClient {
  return { read };
}

function stream(
  status: "connecting" | "fallback" | "live",
  provenance?: AcquisitionProvenanceResponse,
) {
  return (_target: OperationModel["target"], callbacks: AcquisitionProvenanceStreamCallbacks) => {
    callbacks.onStatus("connecting");
    if (provenance) {
      callbacks.onSnapshot({
        cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        provenance,
      });
    }
    if (status !== "connecting") callbacks.onStatus(status);
    return () => undefined;
  };
}

const meta = {
  args: {
    operation: previewOperation,
    onOpenChange: () => undefined,
    open: true,
    watchEvents: stream("live", previewOperation.provenance),
  },
  argTypes: {
    client: { control: false },
    monitoringClient: { control: false },
    onOpenChange: { control: false },
    recoveryClient: { control: false },
    watchEvents: { control: false },
  },
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
    watchEvents: stream("connecting"),
  },
};

export const Empty: Story = {
  args: {
    client: client(async () => empty),
    operation: liveOperation,
    watchEvents: stream("live", empty),
  },
};

export const Degraded: Story = {
  args: {
    operation: { ...previewOperation, provenance: degraded },
    watchEvents: stream("live", degraded),
  },
};

export const RefreshingFallback: Story = {
  args: { watchEvents: stream("fallback") },
};

export const RecoveryConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Review search" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Queue search" })).toBeVisible());
    await waitFor(() => expect(canvas.getByText(/library files remain untouched/u)).toBeVisible());
  },
};

export const RecoverySuccess: Story = {
  args: {
    recoveryClient: {
      loadEligibility: async () => ({
        snapshot: {
          csrfToken: "story_acquisition_csrf_0123456789abcdefghijklmnop",
          principal: operator,
        },
        status: "ready" as const,
      }),
      queueSearch: async () => ({
        replayed: false,
        search: {
          acceptedAt: "2026-07-27T19:01:00.000Z",
          operationId: "radarr:command:88",
          state: "queued" as const,
          target: {
            kind: "movie" as const,
            mediaId: 42,
            seasonNumber: null,
            service: "radarr" as const,
          },
        },
      }),
    } satisfies AcquisitionRecoveryClient,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Review search" }));
    await userEvent.click(canvas.getByRole("button", { name: "Queue search" }));
    await waitFor(() => expect(canvas.getByText("Acquisition search is in motion")).toBeVisible());
  },
};

export const QueueRecoveryConfirmation: Story = {
  args: {
    operation: stalledOperation,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Recover stalled download" }));
    await waitFor(() => expect(canvas.getByLabelText("Type REMOVE to confirm")).toBeVisible());
    await waitFor(() => expect(canvas.getByText(/Future searches remain allowed/u)).toBeVisible());
  },
};

export const QueueRecoveryConfirmationLight: Story = {
  args: {
    operation: stalledOperation,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  globals: { theme: "light" },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Recover stalled download" }));
    await waitFor(() => expect(canvas.getByLabelText("Type REMOVE to confirm")).toBeVisible());
    await waitFor(() => expect(canvas.getByText(/Future searches remain allowed/u)).toBeVisible());
  },
};

export const QueueRecoveryIdle: Story = {
  args: {
    operation: stalledOperation,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Recover stalled download" })).toBeVisible(),
    );
  },
};

export const QueueRecoverySubmitting: Story = {
  args: {
    operation: stalledOperation,
    recoveryClient: {
      loadEligibility: async () => ({
        snapshot: {
          csrfToken: "story_queue_recovery_csrf_0123456789abcdefghijklmnop",
          principal: operator,
        },
        status: "ready" as const,
      }),
      queueSearch: async () => {
        throw new Error("Search is separate from queue recovery.");
      },
      recoverQueueItem: async () => new Promise<never>(() => undefined),
    } satisfies AcquisitionRecoveryClient,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Recover stalled download" }));
    await userEvent.type(canvas.getByLabelText("Type REMOVE to confirm"), "REMOVE");
    await userEvent.click(canvas.getByRole("button", { name: "Remove and blocklist" }));
    await waitFor(() => expect(canvas.getByText("Confirming exact queue state")).toBeVisible());
  },
};

export const QueueRecoveryStale: Story = {
  args: {
    operation: stalledOperation,
    recoveryClient: {
      loadEligibility: async () => ({
        snapshot: {
          csrfToken: "story_queue_recovery_csrf_0123456789abcdefghijklmnop",
          principal: operator,
        },
        status: "ready" as const,
      }),
      queueSearch: async () => {
        throw new Error("Search is separate from queue recovery.");
      },
      recoverQueueItem: async () => {
        throw new AcquisitionRecoveryClientError(
          "stale",
          "acquisition_queue_recovery_stale",
          "Refresh required.",
        );
      },
    } satisfies AcquisitionRecoveryClient,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Recover stalled download" }));
    await userEvent.type(canvas.getByLabelText("Type REMOVE to confirm"), "REMOVE");
    await userEvent.click(canvas.getByRole("button", { name: "Remove and blocklist" }));
    await waitFor(() => expect(canvas.getByText("Queue item changed")).toBeVisible());
  },
};

export const QueueRecoverySuccess: Story = {
  args: {
    operation: stalledOperation,
    recoveryClient: {
      loadEligibility: async () => ({
        snapshot: {
          csrfToken: "story_queue_recovery_csrf_0123456789abcdefghijklmnop",
          principal: operator,
        },
        status: "ready" as const,
      }),
      queueSearch: async () => {
        throw new Error("Search is separate from queue recovery.");
      },
      recoverQueueItem: async () => ({
        recovery: {
          completedAt: "2026-07-27T19:02:00.000Z",
          eventId: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
          operationId: "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
          service: "radarr" as const,
          state: "removed_and_blocklisted" as const,
        },
        replayed: false,
      }),
    } satisfies AcquisitionRecoveryClient,
    watchEvents: stream("live", stalledOperation.provenance),
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Recover stalled download" }));
    await userEvent.type(canvas.getByLabelText("Type REMOVE to confirm"), "REMOVE");
    await userEvent.click(canvas.getByRole("button", { name: "Remove and blocklist" }));
    await waitFor(() => expect(canvas.getByText("Removed and blocklisted")).toBeVisible());
  },
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
    watchEvents: stream("fallback"),
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
    watchEvents: stream("fallback"),
  },
};
