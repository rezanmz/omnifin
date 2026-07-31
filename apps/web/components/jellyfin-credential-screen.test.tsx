import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthenticatedSessionResponse } from "@omnifin/contracts/auth";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JellyfinCredentialScreen } from "./jellyfin-credential-screen";

describe("JellyfinCredentialScreen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps authentication controls disabled in server markup until hydration", () => {
    const passwordMarkup = document.createElement("div");
    passwordMarkup.innerHTML = renderToString(<JellyfinCredentialScreen />);

    expect(passwordMarkup.querySelector('input[name="username"]')).toBeDisabled();
    expect(passwordMarkup.querySelector('input[name="password"]')).toBeDisabled();
    expect(passwordMarkup.querySelector('button[type="submit"]')).toBeDisabled();
    expect(passwordMarkup.querySelector("#jellyfin-quick-connect-tab")).toBeDisabled();

    const quickConnectMarkup = document.createElement("div");
    quickConnectMarkup.innerHTML = renderToString(
      <JellyfinCredentialScreen initialMethod="quick-connect" />,
    );
    expect(
      quickConnectMarkup.querySelector(
        ".jellyfin-quick-connect__start .jellyfin-login-form__submit",
      ),
    ).toBeDisabled();
  });

  it("checks the OIDC session before revealing pairing controls", async () => {
    const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        csrfToken,
        principal: {
          accountState: "pending_link",
          authenticationMethod: { kind: "oidc", providerId: "authentik" },
        },
      }),
    );

    render(<JellyfinCredentialScreen intent="pair" />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking your secure session");
    expect(await screen.findByRole("textbox", { name: "Username" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.getByRole("heading", { name: "Bring your library with you." })).toBeVisible();
  });

  it("pairs with password only through the CSRF-proven linking endpoint", async () => {
    const user = userEvent.setup();
    const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const onAuthenticated = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        csrfToken,
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "oidc", providerId: "authentik" },
          sessionId: "paired-session",
          userId: "oidc-user",
        },
      }),
    );
    render(
      <JellyfinCredentialScreen
        initialPairingSession={{ csrfToken, status: "ready" }}
        intent="pair"
        onAuthenticated={onAuthenticated}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Username" }), "riley");
    await user.type(screen.getByLabelText("Password"), "private-password");
    await user.click(screen.getByRole("button", { name: "Link Jellyfin account" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/jellyfin/link/password", {
      body: JSON.stringify({ password: "private-password", username: "riley" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-omnifin-csrf": csrfToken },
      method: "POST",
    });
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("bootstraps only through the recovery-bound administrator endpoint", async () => {
    const user = userEvent.setup();
    const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const onAuthenticated = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        csrfToken,
        principal: {
          accountState: "active",
          authenticationMethod: { kind: "jellyfin" },
          role: "admin",
          sessionId: "bootstrap-session",
          userId: "bootstrap-user",
        },
      }),
    );
    render(
      <JellyfinCredentialScreen
        initialPairingSession={{ csrfToken, status: "ready" }}
        intent="bootstrap"
        onAuthenticated={onAuthenticated}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Username" }), "riley");
    await user.type(screen.getByLabelText("Password"), "private-password");
    await user.click(screen.getByRole("button", { name: "Create first administrator" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/bootstrap/jellyfin/password", {
      body: JSON.stringify({ password: "private-password", username: "riley" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-omnifin-csrf": csrfToken },
      method: "POST",
    });
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("starts first-admin Quick Connect only through the recovery-bound endpoint", async () => {
    const user = userEvent.setup();
    const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        code: "EF-9012",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        pollAfterMs: 2_000,
        transactionId: "bootstrap-quick-connect",
      }),
    );
    render(
      <JellyfinCredentialScreen
        autoPollQuickConnect={false}
        initialMethod="quick-connect"
        initialPairingSession={{ csrfToken, status: "ready" }}
        intent="bootstrap"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate a code" }));

    expect(await screen.findByLabelText("Jellyfin Quick Connect code")).toHaveTextContent(
      "EF-9012",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/bootstrap/jellyfin/quick-connect", {
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-omnifin-csrf": csrfToken },
      method: "POST",
    });
  });

  it("keeps pairing controls hidden after a signed-out session check", () => {
    render(
      <JellyfinCredentialScreen initialPairingSession={{ status: "signed_out" }} intent="pair" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Sign in again to continue");
    expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
  });

  it("starts Quick Connect pairing with the in-memory CSRF proof", async () => {
    const user = userEvent.setup();
    const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        code: "CD-5678",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        pollAfterMs: 2_000,
        transactionId: "pairing-quick-connect",
      }),
    );
    render(
      <JellyfinCredentialScreen
        autoPollQuickConnect={false}
        initialMethod="quick-connect"
        initialPairingSession={{ csrfToken, status: "ready" }}
        intent="pair"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate a code" }));

    expect(await screen.findByLabelText("Jellyfin Quick Connect code")).toHaveTextContent(
      "CD-5678",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/jellyfin/link/quick-connect", {
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-omnifin-csrf": csrfToken },
      method: "POST",
    });
  });

  it("submits exact password bytes, clears them after denial, and restores focus", async () => {
    const user = userEvent.setup();
    const submitCredentials = vi.fn(async () => "invalid_credentials" as const);
    render(<JellyfinCredentialScreen submitCredentials={submitCredentials} />);

    await user.type(screen.getByRole("textbox", { name: "Username" }), "  riley  ");
    const password = screen.getByLabelText("Password");
    await user.type(password, "  private password  ");
    await user.click(screen.getByRole("button", { name: "Continue to Omnifin" }));

    await waitFor(() =>
      expect(submitCredentials).toHaveBeenCalledWith({
        password: "  private password  ",
        username: "riley",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("was not accepted");
    expect(password).toHaveValue("");
    await waitFor(() => expect(password).toHaveFocus());
    expect(document.body).not.toHaveTextContent("private password");
  });

  it("offers an accessible password visibility control", async () => {
    const user = userEvent.setup();
    render(<JellyfinCredentialScreen />);
    const password = screen.getByLabelText("Password");

    expect(password).toHaveAttribute("type", "password");
    password.focus();
    await user.tab();
    const reveal = screen.getByRole("button", { name: "Show password" });
    expect(reveal).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveFocus();
  });

  it("locks duplicate submissions while verification is pending", async () => {
    const user = userEvent.setup();
    let resolve!: (value: "invalid_credentials") => void;
    const submitCredentials = vi.fn(
      () =>
        new Promise<"invalid_credentials">((promiseResolve) => {
          resolve = promiseResolve;
        }),
    );
    render(<JellyfinCredentialScreen submitCredentials={submitCredentials} />);
    await user.type(screen.getByRole("textbox", { name: "Username" }), "riley");
    await user.type(screen.getByLabelText("Password"), "password");

    await user.click(screen.getByRole("button", { name: "Continue to Omnifin" }));
    expect(screen.getByRole("button", { name: "Verifying account" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying with Jellyfin");
    expect(submitCredentials).toHaveBeenCalledTimes(1);
    resolve("invalid_credentials");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("navigates only after a successful bounded response outcome", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    render(
      <JellyfinCredentialScreen
        onAuthenticated={onAuthenticated}
        submitCredentials={async () => "success"}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Username" }), "riley");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Continue to Omnifin" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("renders unavailable and rate-limited feedback without upstream detail", () => {
    const { rerender } = render(<JellyfinCredentialScreen initialStatus="unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable");

    rerender(<JellyfinCredentialScreen initialStatus="rate_limited" key="rate-limited" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Wait a moment");
  });

  it("switches methods with tab semantics and starts Quick Connect explicitly", async () => {
    const user = userEvent.setup();
    const startQuickConnect = vi.fn(async () => ({
      status: "started" as const,
      transaction: {
        code: "AB-1234",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        pollAfterMs: 2_000,
        transactionId: "quick-connect-1",
      },
    }));
    render(
      <JellyfinCredentialScreen
        autoPollQuickConnect={false}
        startQuickConnect={startQuickConnect}
      />,
    );

    const passwordTab = screen.getByRole("tab", { name: "Password sign in" });
    passwordTab.focus();
    await user.keyboard("{ArrowRight}");
    const quickConnectTab = screen.getByRole("tab", { name: "Quick Connect" });
    expect(quickConnectTab).toHaveAttribute("aria-selected", "true");
    expect(quickConnectTab).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Quick Connect panel");

    await user.click(screen.getByRole("button", { name: "Generate a code" }));
    expect(await screen.findByText("Waiting for approval")).toBeVisible();
    expect(screen.getByLabelText("Jellyfin Quick Connect code")).toHaveTextContent("AB-1234");
    expect(startQuickConnect).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent("private-quick-connect-secret");
  });

  it("polls a pending code and navigates only after an authenticated outcome", async () => {
    vi.useFakeTimers();
    const onAuthenticated = vi.fn();
    const pollQuickConnect = vi.fn(async () => ({
      session: {} as AuthenticatedSessionResponse,
      status: "signed_in" as const,
    }));
    render(
      <JellyfinCredentialScreen
        initialMethod="quick-connect"
        initialNow={Date.parse("2026-07-26T12:00:00.000Z")}
        initialQuickConnectTransaction={{
          code: "AB-1234",
          expiresAt: "2026-07-26T12:05:00.000Z",
          pollAfterMs: 1_000,
          transactionId: "quick-connect-1",
        }}
        onAuthenticated={onAuthenticated}
        pollQuickConnect={pollQuickConnect}
      />,
    );

    expect(onAuthenticated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollQuickConnect).toHaveBeenCalledWith("quick-connect-1");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("announces expiry and allows a fresh code without retaining the old transaction", async () => {
    vi.useFakeTimers();
    const pollQuickConnect = vi.fn(async () => ({ status: "expired" as const }));
    const startQuickConnect = vi.fn(async () => ({
      status: "started" as const,
      transaction: {
        code: "CD-5678",
        expiresAt: "2026-07-26T12:10:00.000Z",
        pollAfterMs: 2_000,
        transactionId: "quick-connect-2",
      },
    }));
    render(
      <JellyfinCredentialScreen
        initialMethod="quick-connect"
        initialNow={Date.parse("2026-07-26T12:00:00.000Z")}
        initialQuickConnectTransaction={{
          code: "AB-1234",
          expiresAt: "2026-07-26T12:05:00.000Z",
          pollAfterMs: 1_000,
          transactionId: "quick-connect-1",
        }}
        pollQuickConnect={pollQuickConnect}
        startQuickConnect={startQuickConnect}
      />,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByRole("alert")).toHaveTextContent("code expired");

    vi.useRealTimers();
    await userEvent.setup().click(screen.getByRole("button", { name: "Generate a new code" }));
    expect(await screen.findByLabelText("Jellyfin Quick Connect code")).toHaveTextContent(
      "CD-5678",
    );
    expect(startQuickConnect).toHaveBeenCalledOnce();
  });
});
