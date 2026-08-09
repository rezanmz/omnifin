import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";

import { InviteExperience } from "./invite-experience";

const oidcProvider = {
  displayName: "Home identity",
  id: "oidc:home",
  issuer: "https://identity.example.test/application/",
  jitProvisioningEnabled: true,
  kind: "oidc" as const,
  state: "available" as const,
  supportsBackChannelLogout: true,
  supportsFrontChannelLogout: true,
  supportsRpInitiatedLogout: true,
};
const jellyfinProvider = {
  displayName: "Jellyfin",
  id: "jellyfin",
  kind: "jellyfin" as const,
  pairingRequiredAfterOidc: true as const,
  passwordLoginAvailable: true,
  quickConnectAvailable: true,
  state: "available" as const,
};

function providersResponse(providers = [oidcProvider, jellyfinProvider]) {
  return new Response(JSON.stringify({ providers }), {
    headers: { "content-type": "application/json" },
  });
}

function bootstrapFetch(providers = [oidcProvider, jellyfinProvider]) {
  return vi.spyOn(window, "fetch").mockImplementation((input) => {
    if (String(input) === "/api/auth/invitations/exchange")
      return Promise.resolve(new Response("{}"));
    if (String(input) === "/api/auth/providers")
      return Promise.resolve(providersResponse(providers));
    return Promise.resolve(new Response("{}"));
  });
}

describe("InviteExperience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("scrubs the fragment before making the exchange request", () => {
    const token = "a".repeat(43);
    window.history.replaceState(null, "", `/#invite=${token}`);
    const events: string[] = [];
    const originalReplaceState = window.history.replaceState;
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
      events.push("scrub");
      return originalReplaceState.apply(window.history, args);
    });
    const fetchMock = vi.spyOn(window, "fetch").mockImplementation(() => {
      events.push("exchange");
      return new Promise<Response>(() => undefined);
    });
    const serverMarkup = renderToString(<InviteExperience />);
    expect(serverMarkup).toContain("Preparing your welcome.");
    render(
      <StrictMode>
        <InviteExperience />
      </StrictMode>,
    );
    expect(window.location.pathname).toBe("/invite");
    expect(window.location.hash).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/invitations/exchange", expect.anything());
    expect(replaceState).toHaveBeenCalledWith(null, "", "/invite");
    expect(events).toEqual(["scrub", "exchange"]);
  });

  it("renders the same bootstrap shell during SSR and hydration, and exchanges once in Strict Mode", async () => {
    const token = "c".repeat(43);
    window.history.replaceState(null, "", `/#invite=${token}`);
    const fetchMock = vi.spyOn(window, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/auth/invitations/exchange")
        return Promise.resolve(new Response("{}"));
      return Promise.resolve(
        new Response(JSON.stringify({ providers: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    render(<InviteExperience />);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/invitations/exchange", expect.anything()),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/auth/invitations/exchange"),
    ).toHaveLength(1);
  });

  it("does not expose a malformed or valid token in visible state", async () => {
    const token = "b".repeat(43);
    window.history.replaceState(null, "", `/#invite=${token}x`);
    render(<InviteExperience />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Let’s try that again." })).toBeVisible(),
    );
    expect(document.body.textContent).not.toContain(token);
    expect(window.location.href).toBe(`${window.location.origin}/invite`);
  });

  it("shows the available provider methods and gives a safe exchange error", async () => {
    window.history.replaceState(null, "", `/#invite=${"d".repeat(43)}`);
    const fetchMock = bootstrapFetch();
    render(<InviteExperience />);

    expect(await screen.findByRole("heading", { name: "Make this space yours." })).toBeVisible();
    expect(screen.getByText("Secure identity provider")).toBeVisible();
    expect(screen.getByText("Jellyfin account")).toBeVisible();

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 502 })));
    await userEvent.click(screen.getAllByRole("button", { name: /Continue/ })[0]!);
    expect(
      await screen.findByText("That identity provider could not be started. Please try again."),
    ).toBeVisible();
  });

  it("completes Jellyfin password onboarding and recovers from rejected credentials", async () => {
    window.history.replaceState(null, "", `/#invite=${"e".repeat(43)}`);
    const fetchMock = bootstrapFetch([jellyfinProvider]);
    render(<InviteExperience />);
    await screen.findByRole("heading", { name: "Make this space yours." });
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await userEvent.type(screen.getByLabelText("Username"), "  mina ");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Connect Jellyfin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Those Jellyfin credentials could not be accepted",
    );
    expect(screen.getByRole("button", { name: "Connect Jellyfin" })).not.toBeDisabled();

    fetchMock.mockResolvedValueOnce(new Response("{}"));
    await userEvent.click(screen.getByRole("button", { name: "Connect Jellyfin" }));
    expect(await screen.findByRole("heading", { name: "Welcome in." })).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/invitations/jellyfin/password",
      expect.objectContaining({
        body: JSON.stringify({ password: "wrong", username: "mina" }),
      }),
    );
  });

  it("reports unavailable providers and handles Quick Connect expiry and restart", async () => {
    window.history.replaceState(null, "", `/#invite=${"f".repeat(43)}`);
    const fetchMock = bootstrapFetch([jellyfinProvider]);
    render(<InviteExperience />);
    await screen.findByRole("heading", { name: "Make this space yours." });
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "AB-1234", transactionId: "tx/1", pollAfterMs: 0 })),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "expired" })));
    await userEvent.click(screen.getByRole("button", { name: "Use Quick Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Quick Connect could not be completed",
    );
    expect(screen.getByRole("button", { name: "Use Quick Connect" })).not.toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Make this space yours." })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "CD-5678", transactionId: "tx-2", pollAfterMs: 0 })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending", pollAfterMs: 0 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "signed_in" })));
    await userEvent.click(screen.getByRole("button", { name: "Use Quick Connect" }));
    expect(await screen.findByRole("heading", { name: "Welcome in." })).toBeVisible();
  });

  it("renders the unavailable state when provider bootstrap cannot be reached", async () => {
    window.history.replaceState(null, "", `/#invite=${"g".repeat(43)}`);
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    render(<InviteExperience />);
    expect(await screen.findByRole("heading", { name: "Let’s try that again." })).toBeVisible();
    expect(
      screen.getByText("We could not reach Omnifin. Check your connection and try again."),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
