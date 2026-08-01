import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { stackVerificationDemo } from "../lib/stack-verification-demo";
import type { StackVerificationOutcome } from "../lib/stack-verification";
import { StackVerificationPanel } from "./stack-verification-panel";

describe("StackVerificationPanel", () => {
  it("starts from a clear privacy boundary and runs only on administrator intent", async () => {
    const user = userEvent.setup();
    let resolveRun: ((outcome: StackVerificationOutcome) => void) | undefined;
    const runVerification = vi.fn(
      async () =>
        await new Promise<StackVerificationOutcome>((resolve) => {
          resolveRun = resolve;
        }),
    );
    render(<StackVerificationPanel runVerification={runVerification} />);

    expect(screen.getByRole("heading", { name: "Verify this home lab end to end." })).toBeVisible();
    expect(screen.getByText(/URLs, credentials, identities, media paths/iu)).toBeVisible();
    expect(runVerification).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run stack verification" }));
    expect(screen.getByRole("status", { name: "Verifying configured services" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(runVerification).toHaveBeenCalledTimes(1);

    resolveRun?.({ report: stackVerificationDemo("ready"), status: "ready" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Every configured service answered cleanly." }),
      ).toBeVisible();
    });
  });

  it("renders every canonical service and downloads the exact safe report", async () => {
    const user = userEvent.setup();
    const report = stackVerificationDemo("attention");
    const downloadReport = vi.fn();
    render(
      <StackVerificationPanel
        downloadReport={downloadReport}
        initialOutcome={{ report, status: "ready" }}
      />,
    );

    const checks = screen.getByRole("list", { name: "Stack verification checks" });
    expect(checks.children).toHaveLength(9);
    expect(screen.getByText("Could not connect")).toBeVisible();
    expect(
      screen.getByText("5", { selector: ".stack-verification__summary strong" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Download safe JSON" }));
    expect(downloadReport).toHaveBeenCalledWith(report);
  });

  it.each([
    ["forbidden", "Full administrator access is required.", "Review account access"],
    ["signed_out", "Your administrative session ended.", "Sign in again"],
    ["in_progress", "A verification is already running.", "Try again"],
    ["unavailable", "The stack could not be verified right now.", "Try again"],
  ] as const)("presents the %s boundary without implying success", (status, heading, action) => {
    render(<StackVerificationPanel initialOutcome={{ status }} />);

    expect(screen.getByText(heading)).toBeVisible();
    expect(
      screen.getByRole(status === "forbidden" || status === "signed_out" ? "link" : "button", {
        name: action,
      }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download safe JSON" })).not.toBeInTheDocument();
  });

  it("shows a truthful unconfigured result", () => {
    render(
      <StackVerificationPanel
        initialOutcome={{ report: stackVerificationDemo("unconfigured"), status: "ready" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "There is no stack to verify yet." })).toBeVisible();
    expect(screen.getAllByText("Not configured")).toHaveLength(9);
    expect(
      screen.getAllByText("0", { selector: ".stack-verification__summary strong" }),
    ).toHaveLength(2);
  });
});
