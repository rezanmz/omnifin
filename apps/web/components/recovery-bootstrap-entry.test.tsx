import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECOVERY_PERMISSIONS } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryBootstrapEntry } from "./recovery-bootstrap-entry";

const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

function recoveryResponse() {
  return Response.json({
    csrfToken,
    principal: {
      absoluteExpiresAt: "2026-08-08T15:00:00.000Z",
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
      displayName: "Recovery access",
      externalIdentity: null,
      inactivityExpiresAt: "2026-08-08T14:45:00.000Z",
      issuedAt: "2026-08-08T14:00:00.000Z",
      linkedServices: [],
      permissions: [...RECOVERY_PERMISSIONS],
      role: "admin",
      sessionId: "recovery-session",
      userId: null,
    },
  });
}

function previewResponse() {
  return Response.json({
    administrator: {
      activeSessions: 2,
      authenticationMethods: ["jellyfin", "oidc"],
      displayName: "Primary administrator",
      id: "administrator-primary",
      updatedAt: "2026-08-08T13:45:00.000Z",
    },
    status: "available",
  });
}

function providersResponse() {
  return Response.json({
    providers: [
      {
        displayName: "Jellyfin",
        id: "jellyfin",
        kind: "jellyfin",
        pairingRequiredAfterOidc: true,
        passwordLoginAvailable: true,
        quickConnectAvailable: true,
        state: "available",
      },
    ],
  });
}

describe("RecoveryBootstrapEntry", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("continues an existing recovery session without requesting the secret again", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(recoveryResponse())
      .mockResolvedValueOnce(previewResponse())
      .mockResolvedValueOnce(providersResponse());

    render(<RecoveryBootstrapEntry />);

    expect(
      await screen.findByRole("heading", { name: "Review the authority change" }),
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
      .mockResolvedValueOnce(recoveryResponse())
      .mockResolvedValueOnce(previewResponse())
      .mockResolvedValueOnce(providersResponse());

    render(<RecoveryBootstrapEntry />);
    const secret = await screen.findByLabelText("Recovery secret");
    await user.type(secret, "private-recovery-secret");
    await user.click(screen.getByRole("button", { name: "Open recovery session" }));

    expect(
      await screen.findByRole("heading", { name: "Review the authority change" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/recovery/session", {
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

  it("scrubs an OIDC callback result from history while preserving its safe recovery notice", async () => {
    window.history.replaceState(
      null,
      "",
      "/recovery?administratorReplacement=denied&operator-note=preserved",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/auth/session") return recoveryResponse();
      if (path.endsWith("/administrator-replacement/preview")) return previewResponse();
      if (path === "/api/auth/providers") return providersResponse();
      return Response.json({}, { status: 503 });
    });

    render(<RecoveryBootstrapEntry initialReplacementStatus="denied" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "fresh identity proof was not accepted",
    );
    expect(window.location.search).toBe("?operator-note=preserved");
    expect(screen.getByRole("heading", { name: "Review the authority change" })).toBeVisible();
  });
});
