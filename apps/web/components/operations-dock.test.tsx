import { render, screen } from "@testing-library/react";
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
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /The Far Meridian/i })).toBeInTheDocument();
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
