import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectorControlRoomLoader } from "./connector-control-room-loader";

const { useIdleRender } = vi.hoisted(() => ({
  useIdleRender: vi.fn(() => false),
}));

vi.mock("../lib/use-idle-render", () => ({ useIdleRender }));

describe("ConnectorControlRoomLoader", () => {
  it("reserves a paint grace period before mounting the connector workspace", () => {
    render(<ConnectorControlRoomLoader />);

    expect(screen.getByLabelText("Loading service connections")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(useIdleRender).toHaveBeenCalledWith(800);
  });
});
