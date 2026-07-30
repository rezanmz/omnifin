import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  AcquisitionProvenanceResponse,
  AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AcquisitionMonitoringClient } from "../lib/acquisition-monitoring";
import {
  AcquisitionProvenanceClientError,
  type AcquisitionProvenanceClient,
  type AcquisitionProvenanceStreamCallbacks,
} from "../lib/acquisition-provenance";
import type { AcquisitionRecoveryClient } from "../lib/acquisition-recovery";
import { AcquisitionRecoveryClientError } from "../lib/acquisition-recovery";
import { demoDashboard, type OperationModel } from "../lib/dashboard-data";
import { AcquisitionTimeline } from "./acquisition-timeline";

const operation = demoDashboard.operations[0]!;
const emptyResponse: AcquisitionProvenanceResponse = {
  events: [],
  failures: [],
  generatedAt: "2026-07-27T19:00:00.000Z",
  state: "complete",
  target: { kind: "series", mediaId: 77, seasonNumber: 1, service: "sonarr" },
};
const liveOperation: OperationModel = {
  eta: "4m",
  id: "op-live",
  progress: 0.91,
  rate: "18.2 MB/s",
  service: "Sonarr · SABnzbd",
  target: { mediaId: 77, seasonNumber: 1, service: "sonarr" },
  title: "Signal · S01E07",
};
const operator: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

function client(read: AcquisitionProvenanceClient["read"]): AcquisitionProvenanceClient {
  return { read };
}

afterEach(() => vi.useRealTimers());

describe("acquisition timeline", () => {
  it("confirms and applies one whole-title monitoring change with current CSRF proof", async () => {
    const user = userEvent.setup();
    const update = vi.fn<AcquisitionMonitoringClient["update"]>(async () => ({
      monitored: false,
      target: { kind: "movie", mediaId: 42, service: "radarr" },
      verifiedAt: "2026-07-27T19:02:00.000Z",
    }));
    const monitoringClient: AcquisitionMonitoringClient = {
      read: vi.fn(),
      update,
    };
    const recoveryClient: AcquisitionRecoveryClient = {
      loadEligibility: vi.fn(async () => ({
        snapshot: { csrfToken: "monitoring_csrf_0123456789abcdefghijklmnop", principal: operator },
        status: "ready" as const,
      })),
      queueSearch: vi.fn(),
    };
    render(
      <AcquisitionTimeline
        monitoringClient={monitoringClient}
        operation={operation}
        onOpenChange={vi.fn()}
        open
        recoveryClient={recoveryClient}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pause monitoring for The Far Meridian" }));
    expect(screen.getByText("Pause monitoring for The Far Meridian?")).toBeVisible();
    expect(screen.getByText(/Existing files and downloads stay intact/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("Monitoring paused")).toBeVisible();
    expect(update).toHaveBeenCalledWith(
      {
        expectedMonitored: true,
        mediaId: 42,
        monitored: false,
        service: "radarr",
      },
      { csrfToken: "monitoring_csrf_0123456789abcdefghijklmnop" },
    );
    expect(screen.getByText(/Existing files and queues are unchanged/u)).toBeVisible();
  });

  it("confirms and queues an exact-target recovery without exposing destructive controls", async () => {
    const user = userEvent.setup();
    const queueSearch = vi.fn<AcquisitionRecoveryClient["queueSearch"]>(async () => ({
      replayed: false,
      search: {
        acceptedAt: "2026-07-27T19:01:00.000Z",
        operationId: "radarr:command:88",
        state: "queued",
        target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
      },
    }));
    const recoveryClient: AcquisitionRecoveryClient = {
      loadEligibility: vi.fn(async () => ({
        snapshot: { csrfToken: "acquisition_csrf_0123456789abcdefghijklmnop", principal: operator },
        status: "ready" as const,
      })),
      queueSearch,
    };
    render(
      <AcquisitionTimeline
        operation={operation}
        onOpenChange={vi.fn()}
        open
        recoveryClient={recoveryClient}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /delete|blocklist|remove/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review search" }));
    expect(
      screen.getByText(/Existing downloads and library files remain untouched\./u),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Queue search" }));

    expect(await screen.findByText("Acquisition search is in motion")).toBeVisible();
    expect(queueSearch).toHaveBeenCalledWith(
      operation.target,
      expect.objectContaining({
        csrfToken: "acquisition_csrf_0123456789abcdefghijklmnop",
        idempotencyKey: expect.stringMatching(/^acquisition-/u),
      }),
    );
  });

  it("lets an operator cancel the exact-target confirmation without a session lookup", async () => {
    const user = userEvent.setup();
    const recoveryClient: AcquisitionRecoveryClient = {
      loadEligibility: vi.fn(),
      queueSearch: vi.fn(),
    };
    render(
      <AcquisitionTimeline
        operation={operation}
        onOpenChange={vi.fn()}
        open
        recoveryClient={recoveryClient}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review search" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Review search" })).toBeVisible();
    expect(recoveryClient.loadEligibility).not.toHaveBeenCalled();
  });

  it.each([
    { heading: "Sign in to continue", status: "signed_out" as const },
    { heading: "Operator access required", status: "forbidden" as const },
    { heading: "Verify history before another attempt", status: "unavailable" as const },
  ])("fails closed when recovery eligibility is $status", async ({ heading, status }) => {
    const user = userEvent.setup();
    const queueSearch = vi.fn<AcquisitionRecoveryClient["queueSearch"]>();
    render(
      <AcquisitionTimeline
        operation={operation}
        onOpenChange={vi.fn()}
        open
        recoveryClient={{ loadEligibility: async () => ({ status }), queueSearch }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review search" }));
    await user.click(screen.getByRole("button", { name: "Queue search" }));
    expect(await screen.findByText(heading)).toBeVisible();
    expect(queueSearch).not.toHaveBeenCalled();
  });

  it("preserves a failed operation until the operator explicitly begins a new attempt", async () => {
    const user = userEvent.setup();
    const queueSearch = vi.fn<AcquisitionRecoveryClient["queueSearch"]>(async () =>
      Promise.reject(
        new AcquisitionRecoveryClientError(
          "pending",
          "acquisition_search_outcome_pending",
          "Still pending.",
        ),
      ),
    );
    render(
      <AcquisitionTimeline
        operation={operation}
        onOpenChange={vi.fn()}
        open
        recoveryClient={{
          loadEligibility: async () => ({
            snapshot: {
              csrfToken: "acquisition_csrf_0123456789abcdefghijklmnop",
              principal: operator,
            },
            status: "ready",
          }),
          queueSearch,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review search" }));
    await user.click(screen.getByRole("button", { name: "Queue search" }));
    expect(await screen.findByText("Verify history before another attempt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New attempt" }));
    expect(screen.getByRole("button", { name: "Review search" })).toBeVisible();
  });

  it("renders a title-level trace from normalized preview data and closes accessibly", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AcquisitionTimeline operation={operation} onOpenChange={onOpenChange} open />);

    expect(screen.getByRole("heading", { name: "Signal history" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "The Far Meridian" })).toBeVisible();
    expect(screen.getByText("Release grabbed")).toBeVisible();
    expect(screen.getByText("Download failed")).toBeVisible();
    expect(screen.getByText("18.4 GB")).toBeVisible();
    expect(screen.getByText("05")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close acquisition history" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports the transport honestly and replaces the timeline only after a valid snapshot", () => {
    let callbacks: AcquisitionProvenanceStreamCallbacks | undefined;
    const watchEvents = vi.fn(
      (_target: AcquisitionTargetInput, nextCallbacks: AcquisitionProvenanceStreamCallbacks) => {
        callbacks = nextCallbacks;
        nextCallbacks.onStatus("connecting");
        return vi.fn();
      },
    );
    render(
      <AcquisitionTimeline
        operation={operation}
        onOpenChange={vi.fn()}
        open
        watchEvents={watchEvents}
      />,
    );

    expect(screen.getByLabelText("Acquisition updates: Connecting")).toBeVisible();
    expect(screen.getByText("Release grabbed")).toBeVisible();
    act(() => callbacks?.onStatus("fallback"));
    expect(screen.getByLabelText("Acquisition updates: Refreshing")).toBeVisible();
    expect(screen.getByText("Release grabbed")).toBeVisible();

    act(() => {
      callbacks?.onSnapshot({
        cursor: "provenance_event_ABCDEFGHIJKLMNOPQRSTUV",
        kind: "snapshot",
        provenance: {
          events: [],
          failures: [],
          generatedAt: "2026-07-27T19:05:00.000Z",
          state: "complete",
          target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
        },
      });
      callbacks?.onStatus("live");
    });
    expect(screen.getByLabelText("Acquisition updates: Live")).toBeVisible();
    expect(screen.getByRole("heading", { name: "No acquisition events yet" })).toBeVisible();
  });

  it("keeps verified data and polls at a bounded interval when streaming falls back", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => operation.provenance!);
    const watchEvents = vi.fn(
      (_target: AcquisitionTargetInput, callbacks: AcquisitionProvenanceStreamCallbacks) => {
        callbacks.onStatus("fallback");
        return vi.fn();
      },
    );
    const { unmount } = render(
      <AcquisitionTimeline
        client={client(read)}
        operation={operation}
        onOpenChange={vi.fn()}
        open
        watchEvents={watchEvents}
      />,
    );

    expect(screen.getByText("Release grabbed")).toBeVisible();
    expect(read).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read).toHaveBeenCalledOnce();

    unmount();
    vi.useRealTimers();
  });

  it("loads a live target with an abortable client and renders an honest empty state", async () => {
    const read = vi.fn(async () => emptyResponse);
    render(
      <AcquisitionTimeline
        client={client(read)}
        operation={liveOperation}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(await screen.findByRole("heading", { name: "No acquisition events yet" })).toBeVisible();
    expect(read).toHaveBeenCalledWith(
      { mediaId: 77, seasonNumber: 1, service: "sonarr" },
      expect.any(AbortSignal),
    );
  });

  it("keeps verified events visible when one upstream view is degraded", () => {
    const provenance = operation.provenance!;
    render(
      <AcquisitionTimeline
        operation={{
          ...operation,
          provenance: {
            ...provenance,
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
          },
        }}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Partial history");
    expect(screen.getByText("Release grabbed")).toBeVisible();
  });

  it("explains permission denial without offering an unsafe retry", async () => {
    render(
      <AcquisitionTimeline
        client={client(async () =>
          Promise.reject(
            new AcquisitionProvenanceClientError(
              "forbidden",
              "permission_denied",
              "This action is not permitted.",
            ),
          ),
        )}
        operation={liveOperation}
        onOpenChange={vi.fn()}
        open
      />,
    );

    expect(await screen.findByRole("heading", { name: "Operator access required" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("lets an operator retry a temporary failure without losing the selected target", async () => {
    const read = vi
      .fn<AcquisitionProvenanceClient["read"]>()
      .mockRejectedValueOnce(
        new AcquisitionProvenanceClientError(
          "unavailable",
          "service_unavailable",
          "Temporarily unavailable.",
        ),
      )
      .mockResolvedValueOnce(emptyResponse);
    const user = userEvent.setup();
    render(
      <AcquisitionTimeline
        client={client(read)}
        operation={liveOperation}
        onOpenChange={vi.fn()}
        open
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "No acquisition events yet" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1]?.[0]).toEqual(liveOperation.target);
  });
});
