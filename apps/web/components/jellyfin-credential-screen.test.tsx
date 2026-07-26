import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JellyfinCredentialScreen } from "./jellyfin-credential-screen";

describe("JellyfinCredentialScreen", () => {
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
});
