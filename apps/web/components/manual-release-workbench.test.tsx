import type { ManualReleaseGrabResponse } from "@omnifin/contracts/acquisition";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManualReleaseClient } from "../lib/manual-releases";
import { ManualReleaseClientError } from "../lib/manual-releases";
import { demoDashboard } from "../lib/dashboard-data";
import {
  approvedManualRelease,
  manualReleaseOperator,
  manualReleaseSearch,
  rejectedManualRelease,
} from "../test/manual-release-fixtures";
import { ManualReleaseWorkbench } from "./manual-release-workbench";

const operation = demoDashboard.operations[0]!;
const eligibility = {
  snapshot: {
    csrfToken: "manual_release_csrf_0123456789abcdefghijklmnopqrstuvwxyz",
    principal: manualReleaseOperator,
  },
  status: "ready" as const,
};
const receipt: ManualReleaseGrabResponse = {
  acceptedAt: "2026-07-27T12:01:00.000Z",
  operationId: "release_grab_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  releaseId: rejectedManualRelease.id,
  service: "radarr",
  state: "accepted",
};

function client(overrides: Partial<ManualReleaseClient> = {}): ManualReleaseClient {
  return {
    grab: async () => ({ grab: receipt, replayed: false }),
    loadEligibility: async () => eligibility,
    search: async () => manualReleaseSearch,
    ...overrides,
  };
}

describe("ManualReleaseWorkbench", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ranks approved releases first and exposes normalized comparative details", async () => {
    render(
      <ManualReleaseWorkbench
        client={client()}
        onOpenChange={vi.fn()}
        open
        operation={operation}
      />,
    );

    const choices = await screen.findAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAttribute("value", approvedManualRelease.id);
    expect(choices[0]).toBeChecked();
    expect(screen.getAllByText("+1450")).toHaveLength(2);
    expect(screen.getByText("No rejection evidence was reported.")).toBeVisible();
    expect(
      screen.queryByText(/private api key|private release reference/i),
    ).not.toBeInTheDocument();
  });

  it("requires explicit rejection review before sending one exact release", async () => {
    const user = userEvent.setup();
    const grab = vi.fn<ManualReleaseClient["grab"]>(async () => ({
      grab: receipt,
      replayed: false,
    }));
    render(
      <ManualReleaseWorkbench
        client={client({ grab })}
        onOpenChange={vi.fn()}
        open
        operation={operation}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: /1080p\.WEB-DL/u }));
    expect(screen.getByText("Quality profile does not allow WEB-1080p")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review grab" }));
    const submit = screen.getByRole("button", { name: "Send release" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /reviewed the rejection evidence/u }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Release accepted")).toBeVisible();
    expect(grab).toHaveBeenCalledWith(
      { overrideRejections: true, releaseId: rejectedManualRelease.id },
      expect.objectContaining({
        csrfToken: eligibility.snapshot.csrfToken,
        idempotencyKey: expect.stringMatching(/^manual-grab-/u),
      }),
    );
  });

  it("retains the same receipt key for an ambiguous manual retry", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", {
      randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
    });
    const grab = vi
      .fn<ManualReleaseClient["grab"]>()
      .mockRejectedValueOnce(
        new ManualReleaseClientError(
          "pending",
          "manual_release_grab_outcome_pending",
          "Still pending.",
        ),
      )
      .mockResolvedValueOnce({
        grab: { ...receipt, releaseId: approvedManualRelease.id },
        replayed: true,
      });
    render(
      <ManualReleaseWorkbench
        client={client({ grab })}
        onOpenChange={vi.fn()}
        open
        operation={operation}
      />,
    );

    await screen.findByRole("radio", { name: /2160p\.UHD/u });
    await user.click(screen.getByRole("button", { name: "Review grab" }));
    await user.click(screen.getByRole("button", { name: "Send release" }));
    await user.click(await screen.findByRole("button", { name: "Retry receipt" }));
    await screen.findByText("Verified receipt");

    expect(grab).toHaveBeenCalledTimes(2);
    expect(grab.mock.calls[0]?.[1].idempotencyKey).toBe(
      "manual-grab-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(grab.mock.calls[1]?.[1].idempotencyKey).toBe(grab.mock.calls[0]?.[1].idempotencyKey);
  });

  it("renders honest empty and permission-denied states without mutation controls", async () => {
    const { rerender } = render(
      <ManualReleaseWorkbench
        client={client({ search: async () => ({ ...manualReleaseSearch, releases: [] }) })}
        onOpenChange={vi.fn()}
        open
        operation={operation}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "No releases matched this target" }),
    ).toBeVisible();

    rerender(
      <ManualReleaseWorkbench
        client={client({ loadEligibility: async () => ({ status: "forbidden" }) })}
        onOpenChange={vi.fn()}
        open
        operation={{ ...operation, id: "permission-operation" }}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Operator access required" })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Send release" })).not.toBeInTheDocument(),
    );
  });
});
