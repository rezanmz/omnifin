import type { AcquisitionProvenanceResponse } from "@omnifin/contracts/acquisition";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AcquisitionProvenanceClientError,
  type AcquisitionProvenanceClient,
} from "../lib/acquisition-provenance";
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

function client(read: AcquisitionProvenanceClient["read"]): AcquisitionProvenanceClient {
  return { read };
}

describe("acquisition timeline", () => {
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
