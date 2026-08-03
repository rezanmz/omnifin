import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoDashboard } from "../lib/dashboard-data";
import { useInterfaceStore } from "../stores/interface-store";
import { OperationsDock } from "./operations-dock";

describe("OperationsDock", () => {
  it("reveals operation detail on demand", async () => {
    useInterfaceStore.setState({ operationsExpanded: false });
    const user = userEvent.setup();
    render(<OperationsDock operations={demoDashboard.operations} />);

    const toggle = screen.getByRole("button", { name: /2 acquisitions moving/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const acquisition = screen.getByRole("button", {
      name: "Inspect acquisition history for The Far Meridian",
    });
    expect(acquisition).toBeInTheDocument();
    await user.click(acquisition);
    expect(await screen.findByRole("heading", { name: "Signal history" })).toBeVisible();
  });

  it("renders an honest quiet state without invalid progress when the queue is empty", () => {
    render(<OperationsDock operations={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No acquisitions in flight");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes acquisition progress with numeric semantics", () => {
    useInterfaceStore.setState({ operationsExpanded: false });
    render(<OperationsDock operations={demoDashboard.operations} />);

    expect(
      screen.getByRole("progressbar", { name: "Average acquisition progress" }),
    ).toHaveAttribute("aria-valuenow", "82");
  });
});
