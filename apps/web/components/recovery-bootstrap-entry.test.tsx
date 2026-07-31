import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryBootstrapEntry } from "./recovery-bootstrap-entry";

const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function recoveryResponse() {
  return Response.json({
    csrfToken,
    principal: {
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
    },
  });
}

describe("RecoveryBootstrapEntry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues an existing recovery session without requesting the secret again", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(recoveryResponse());

    render(<RecoveryBootstrapEntry />);

    expect(
      await screen.findByRole("heading", { name: "Establish trusted control." }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.queryByLabelText("Recovery secret")).not.toBeInTheDocument();
  });

  it("opens recovery access with the Docker secret and clears it before admin verification", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(recoveryResponse());

    render(<RecoveryBootstrapEntry />);
    const secret = await screen.findByLabelText("Recovery secret");
    await user.type(secret, "private-recovery-secret");
    await user.click(screen.getByRole("button", { name: "Open recovery session" }));

    expect(
      await screen.findByRole("heading", { name: "Establish trusted control." }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/recovery/session", {
      body: JSON.stringify({ secret: "private-recovery-secret" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(document.body).not.toHaveTextContent("private-recovery-secret");
  });

  it("shows a generic denial and never echoes the submitted secret", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));

    render(<RecoveryBootstrapEntry />);
    const secret = await screen.findByLabelText("Recovery secret");
    await user.type(secret, "private-recovery-secret");
    await user.click(screen.getByRole("button", { name: "Open recovery session" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("was not accepted"));
    expect(secret).toHaveValue("");
    expect(document.body).not.toHaveTextContent("private-recovery-secret");
  });

  it("distinguishes an unavailable control plane from a signed-out browser", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("gateway unavailable"));

    render(<RecoveryBootstrapEntry />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recovery access is temporarily unavailable.",
    );
    expect(screen.getByLabelText("Recovery secret")).toBeDisabled();
  });
});
