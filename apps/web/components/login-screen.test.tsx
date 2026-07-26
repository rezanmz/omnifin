import type { AuthProvider } from "@omnifin/contracts/auth";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LoginScreen, LoginScreenSkeleton } from "./login-screen";

const providers: AuthProvider[] = [
  {
    displayName: "Home identity",
    id: "oidc:home",
    issuer: "https://identity.example.test/application/o/omnifin/",
    jitProvisioningEnabled: true,
    kind: "oidc",
    state: "available",
    supportsBackChannelLogout: true,
    supportsFrontChannelLogout: true,
    supportsRpInitiatedLogout: true,
  },
  {
    displayName: "Jellyfin",
    id: "jellyfin-home",
    kind: "jellyfin",
    pairingRequiredAfterOidc: true,
    passwordLoginAvailable: true,
    quickConnectAvailable: true,
    state: "available",
  },
  {
    displayName: "Backup identity",
    id: "oidc-backup",
    issuer: "https://backup.example.test/",
    jitProvisioningEnabled: false,
    kind: "oidc",
    state: "unavailable",
    supportsBackChannelLogout: false,
    supportsFrontChannelLogout: false,
    supportsRpInitiatedLogout: false,
  },
];

describe("LoginScreen", () => {
  it("links available providers and gives unavailable OIDC providers a bounded retry", () => {
    render(<LoginScreen providerLoadState="ready" providers={providers} />);

    expect(screen.getByRole("link", { name: /Continue with Home identity/i })).toHaveAttribute(
      "href",
      "/api/auth/oidc/oidc%3Ahome/start",
    );
    expect(screen.getByRole("link", { name: /Continue with Jellyfin/i })).toHaveAttribute(
      "href",
      "/login/jellyfin",
    );
    expect(screen.getByRole("link", { name: "Retry Backup identity sign-in" })).toHaveAttribute(
      "href",
      "/api/auth/oidc/oidc-backup/start",
    );
  });

  it("moves through interactive methods with TV-style vertical navigation", async () => {
    const user = userEvent.setup();
    const disabledJellyfin: Extract<AuthProvider, { kind: "jellyfin" }> = {
      displayName: "Offline Jellyfin",
      id: "jellyfin-offline",
      kind: "jellyfin",
      pairingRequiredAfterOidc: true,
      passwordLoginAvailable: false,
      quickConnectAvailable: false,
      state: "unavailable",
    };
    render(
      <LoginScreen
        providerLoadState="ready"
        providers={[providers[0]!, disabledJellyfin, providers[2]!]}
      />,
    );

    const primary = screen.getByRole("link", { name: /Continue with Home identity/i });
    const retry = screen.getByRole("link", { name: "Retry Backup identity sign-in" });
    primary.focus();
    await user.keyboard("{ArrowDown}");
    expect(retry).toHaveFocus();
    await user.keyboard("{Home}");
    expect(primary).toHaveFocus();
    await user.keyboard("{End}");
    expect(retry).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(primary).toHaveFocus();
  });

  it("announces only allowlisted authentication errors", () => {
    render(
      <LoginScreen
        authError="authorization_denied"
        providerLoadState="ready"
        providers={providers.slice(0, 1)}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign-in was cancelled before access was granted.",
    );
  });

  it("gives a safe next step when the session issuance limit is reached", () => {
    render(
      <LoginScreen
        authError="session_limit_reached"
        providerLoadState="ready"
        providers={providers.slice(0, 1)}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wait before trying again or ask an administrator to revoke older sessions.",
    );
  });

  it("distinguishes an empty configuration from an unavailable control plane", () => {
    const { rerender } = render(<LoginScreen providerLoadState="ready" providers={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No sign-in providers are configured");

    rerender(<LoginScreen providerLoadState="unavailable" providers={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("The control plane is unavailable");
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/login");
  });

  it("announces loading while preserving provider-row geometry", () => {
    const { container } = render(<LoginScreenSkeleton />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading secure sign-in options");
    expect(container.querySelectorAll(".login-provider--skeleton")).toHaveLength(2);
  });

  it("preserves the complete accessible name for a maximum-length provider label", () => {
    const displayName = `Identity ${"A".repeat(151)}`;
    render(<LoginScreen providers={[{ ...providers[0]!, displayName, id: "maximum-name" }]} />);

    expect(screen.getByRole("list", { name: "Sign-in methods" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: new RegExp(`^Continue with ${displayName}`) }),
    ).toBeInTheDocument();
    expect(screen.getByTitle(displayName)).toHaveTextContent(displayName);
  });
});
