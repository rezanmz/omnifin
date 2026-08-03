import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { demoDashboard } from "../lib/dashboard-data";
import { OperationsDock } from "./operations-dock";

describe("OperationsDock", () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("reveals operation detail on demand", async () => {
    const user = userEvent.setup();
    render(<OperationsDock operations={demoDashboard.operations} />);

    const toggle = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const acquisition = screen.getByRole("button", {
      name: "Inspect acquisition history for The Far Meridian",
    });
    expect(acquisition).toBeInTheDocument();
    await user.click(acquisition);
    expect(await screen.findByRole("heading", { name: "Signal history" })).toBeVisible();
  });

  it("preserves an interaction when the dashboard remounts", async () => {
    const user = userEvent.setup();
    const firstRender = render(<OperationsDock operations={demoDashboard.operations} />);
    const firstToggle = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(firstToggle).toBeEnabled());
    await user.click(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");

    firstRender.unmount();
    render(<OperationsDock operations={demoDashboard.operations} />);

    const remountedToggle = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(remountedToggle).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("button", { name: /The Far Meridian/i })).toBeVisible();
  });

  it("retains native keyboard activation semantics", async () => {
    const user = userEvent.setup();
    render(<OperationsDock operations={demoDashboard.operations} />);

    const toggle = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    toggle.focus();
    await user.keyboard("{Enter}");

    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("renders an honest quiet state without invalid progress when the queue is empty", () => {
    render(<OperationsDock operations={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No acquisitions in flight");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes acquisition progress with numeric semantics", () => {
    render(<OperationsDock operations={demoDashboard.operations} />);

    expect(
      screen.getByRole("progressbar", { name: "Average acquisition progress" }),
    ).toHaveAttribute("aria-valuenow", "82");
  });
});
