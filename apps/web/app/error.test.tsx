import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RouteError from "./error";

describe("RouteError", () => {
  it("focuses a private recovery surface and retries without exposing error details", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const privateDiagnostic = "connector token and private upstream path";

    render(<RouteError error={new Error(privateDiagnostic)} reset={reset} />);

    const main = screen.getByRole("main");
    await waitFor(() => expect(main).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check service activity before repeating an interrupted action",
    );
    expect(screen.queryByText(privateDiagnostic)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
