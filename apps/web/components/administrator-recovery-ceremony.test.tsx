import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthProvider } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
  type AdministratorRecoveryClient,
} from "../lib/administrator-recovery";
import { AdministratorRecoveryCeremony } from "./administrator-recovery-ceremony";

const csrfToken = "administrator_recovery_csrf_0123456789abcdefghij";
const preview = {
  activeSessions: 3,
  authenticationMethods: ["jellyfin", "oidc"] as ("jellyfin" | "oidc")[],
  displayName: "Primary administrator",
  id: "administrator-primary",
  updatedAt: "2026-08-08T13:45:00.000Z",
};
const providers = [
  {
    displayName: "Jellyfin",
    id: "jellyfin",
    kind: "jellyfin",
    pairingRequiredAfterOidc: true,
    passwordLoginAvailable: true,
    quickConnectAvailable: true,
    state: "available",
  },
  {
    displayName: "Home identity",
    id: "home-identity",
    issuer: "https://identity.example.test/application/o/omnifin/",
    jitProvisioningEnabled: false,
    kind: "oidc",
    state: "available",
    supportsBackChannelLogout: true,
    supportsFrontChannelLogout: true,
    supportsRpInitiatedLogout: true,
  },
] satisfies readonly AuthProvider[];

function clientFixture(overrides: Partial<AdministratorRecoveryClient> = {}) {
  return {
    loadPreview: vi
      .fn<AdministratorRecoveryClient["loadPreview"]>()
      .mockResolvedValue({ administrator: preview, status: "available" }),
    loadProviders: vi
      .fn<AdministratorRecoveryClient["loadProviders"]>()
      .mockResolvedValue({ providers, status: "ready" }),
    pollQuickConnect: vi
      .fn<AdministratorRecoveryClient["pollQuickConnect"]>()
      .mockResolvedValue({ status: "expired" }),
    replaceWithPassword: vi
      .fn<AdministratorRecoveryClient["replaceWithPassword"]>()
      .mockResolvedValue({ status: "denied" }),
    startOidc: vi
      .fn<AdministratorRecoveryClient["startOidc"]>()
      .mockResolvedValue({ status: "unavailable" }),
    startQuickConnect: vi
      .fn<AdministratorRecoveryClient["startQuickConnect"]>()
      .mockResolvedValue({ status: "unavailable" }),
    verifySession: vi
      .fn<AdministratorRecoveryClient["verifySession"]>()
      .mockResolvedValue("recovery"),
    ...overrides,
  } satisfies AdministratorRecoveryClient;
}

describe("AdministratorRecoveryCeremony", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("shows the exact local revision and an unambiguous upstream-account warning", () => {
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture()}
        csrfToken={csrfToken}
        initialPreview={preview}
        initialProviders={providers}
      />,
    );

    expect(screen.getByRole("heading", { name: "Review the authority change" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Primary administrator" })).toBeVisible();
    expect(screen.getByText("3", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Jellyfin · OIDC")).toBeVisible();
    expect(screen.getByText("Only OmniFin authority is replaced")).toBeVisible();
    expect(screen.getByText(/Jellyfin and identity-provider accounts/u)).toBeVisible();
    expect(screen.getByText(/Aug 8, 2026/u)).toBeVisible();
  });

  it("requires the literal confirmation and binds password completion to the shown revision", async () => {
    const user = userEvent.setup();
    const replaceWithPassword = vi
      .fn<AdministratorRecoveryClient["replaceWithPassword"]>()
      .mockResolvedValue({ status: "replaced" });
    const verifySession = vi
      .fn<AdministratorRecoveryClient["verifySession"]>()
      .mockResolvedValue("administrator");
    const onAuthenticated = vi.fn();
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture({ replaceWithPassword, verifySession })}
        csrfToken={csrfToken}
        initialPreview={preview}
        initialProviders={providers}
        onAuthenticated={onAuthenticated}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue to confirmation" }));
    const continueButton = screen.getByRole("button", { name: "Choose fresh identity proof" });
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByLabelText("Confirmation phrase"), "REPLACE ADMIN");
    expect(continueButton).toBeDisabled();
    await user.clear(screen.getByLabelText("Confirmation phrase"));
    await user.type(
      screen.getByLabelText("Confirmation phrase"),
      ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
    );
    await user.click(continueButton);

    await user.type(screen.getByLabelText("Jellyfin username"), "replacement");
    const password = screen.getByLabelText("Jellyfin password", { selector: "input" });
    await user.type(password, "  private password  ");
    await user.click(screen.getByRole("button", { name: "Replace local administrator" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(replaceWithPassword).toHaveBeenCalledWith(
      {
        administratorId: preview.id,
        confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
        expectedUpdatedAt: preview.updatedAt,
        password: "  private password  ",
        username: "replacement",
      },
      csrfToken,
    );
    expect(verifySession).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Administrator access restored" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("private password");
  });

  it("stops on a stale target, clears confirmation material, and focuses the recovery state", async () => {
    const user = userEvent.setup();
    const replaceWithPassword = vi
      .fn<AdministratorRecoveryClient["replaceWithPassword"]>()
      .mockResolvedValue({ status: "stale_target" });
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture({ replaceWithPassword })}
        csrfToken={csrfToken}
        initialConfirmation={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}
        initialPreview={preview}
        initialProviders={providers}
        initialStep="proof"
      />,
    );

    await user.type(screen.getByLabelText("Jellyfin username"), "replacement");
    await user.type(
      screen.getByLabelText("Jellyfin password", { selector: "input" }),
      "private-password",
    );
    await user.click(screen.getByRole("button", { name: "Replace local administrator" }));

    const heading = await screen.findByRole("heading", {
      name: "The administrator preview is no longer current",
    });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("stopped before moving authority");
    expect(screen.queryByText("private-password")).not.toBeInTheDocument();
    expect(screen.queryByText("Primary administrator")).not.toBeInTheDocument();
  });

  it("uses a session check instead of resubmitting after an uncertain completion", async () => {
    const user = userEvent.setup();
    const replaceWithPassword = vi
      .fn<AdministratorRecoveryClient["replaceWithPassword"]>()
      .mockResolvedValue({ status: "uncertain" });
    const verifySession = vi
      .fn<AdministratorRecoveryClient["verifySession"]>()
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("administrator");
    const onAuthenticated = vi.fn();
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture({ replaceWithPassword, verifySession })}
        csrfToken={csrfToken}
        initialConfirmation={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}
        initialPreview={preview}
        initialProviders={providers}
        initialStep="proof"
        onAuthenticated={onAuthenticated}
      />,
    );

    await user.type(screen.getByLabelText("Jellyfin username"), "replacement");
    await user.type(
      screen.getByLabelText("Jellyfin password", { selector: "input" }),
      "private-password",
    );
    await user.click(screen.getByRole("button", { name: "Replace local administrator" }));

    expect(
      await screen.findByRole("heading", { name: "The new session needs to be checked" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Do not submit the authority change again");
    expect(replaceWithPassword).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Check current session" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(replaceWithPassword).toHaveBeenCalledOnce();
    expect(verifySession).toHaveBeenCalledTimes(2);
  });

  it("keeps Quick Connect pending without a timing trap and clears the code on cancellation", async () => {
    const user = userEvent.setup();
    const transaction = {
      code: "AB-1234",
      expiresAt: "2026-08-08T14:05:00.000Z",
      pollAfterMs: 2_000,
      transactionId: "replacement-quick-connect",
    };
    const startQuickConnect = vi
      .fn<AdministratorRecoveryClient["startQuickConnect"]>()
      .mockResolvedValue({ status: "started", transaction });
    render(
      <AdministratorRecoveryCeremony
        autoPollQuickConnect={false}
        client={clientFixture({ startQuickConnect })}
        csrfToken={csrfToken}
        initialConfirmation={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}
        initialMethod="quick-connect"
        initialPreview={preview}
        initialProviders={providers}
        initialStep="proof"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate Quick Connect code" }));
    expect(
      await screen.findByLabelText("Administrator recovery Quick Connect code"),
    ).toHaveTextContent("AB-1234");
    expect(screen.getByText("Waiting for Jellyfin approval")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel this code" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel this code" }));
    expect(screen.queryByText("AB-1234")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Quick Connect code" })).toBeEnabled();
  });

  it("supports arrow-key proof selection and starts only existing-account OIDC", async () => {
    const user = userEvent.setup();
    const onOidcRedirect = vi.fn();
    const startOidc = vi.fn<AdministratorRecoveryClient["startOidc"]>().mockResolvedValue({
      authorization: {
        authorizationUrl: "https://identity.example.test/application/o/authorize/?state=opaque",
        expiresAt: "2026-08-08T14:05:00.000Z",
      },
      status: "started",
    });
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture({ startOidc })}
        csrfToken={csrfToken}
        initialConfirmation={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}
        initialPreview={preview}
        initialProviders={providers}
        initialStep="proof"
        onOidcRedirect={onOidcRedirect}
      />,
    );

    const passwordTab = screen.getByRole("tab", { name: "Jellyfin password" });
    passwordTab.focus();
    await user.keyboard("{End}");
    const oidcTab = screen.getByRole("tab", { name: "Existing-account OIDC" });
    expect(oidcTab).toHaveFocus();
    expect(oidcTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/This flow does not create an account/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Home identity/u }));

    expect(startOidc).toHaveBeenCalledWith(
      "home-identity",
      {
        administratorId: preview.id,
        confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
        expectedUpdatedAt: preview.updatedAt,
      },
      csrfToken,
    );
    expect(onOidcRedirect).toHaveBeenCalledWith(
      "https://identity.example.test/application/o/authorize/?state=opaque",
    );
    expect(window.location.pathname).toBe("/recovery");
  });

  it("never exposes account details when no sole target is returned", async () => {
    const onFirstAdministratorSetup = vi.fn();
    const user = userEvent.setup();
    render(
      <AdministratorRecoveryCeremony
        client={clientFixture()}
        csrfToken={csrfToken}
        initialState="target_unavailable"
        onFirstAdministratorSetup={onFirstAdministratorSetup}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No account details were returned");
    expect(alert).not.toHaveTextContent(/zero|multiple|how many/iu);
    await user.click(
      screen.getByRole("button", { name: "New installation: establish first administrator" }),
    );
    expect(onFirstAdministratorSetup).toHaveBeenCalledOnce();
  });

  it("clears pending transaction material when the page enters history", async () => {
    render(
      <AdministratorRecoveryCeremony
        autoPollQuickConnect={false}
        client={clientFixture()}
        csrfToken={csrfToken}
        initialConfirmation={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}
        initialMethod="quick-connect"
        initialPreview={preview}
        initialProviders={providers}
        initialQuickConnectTransaction={{
          code: "HISTORY-CODE",
          expiresAt: "2026-08-08T14:05:00.000Z",
          pollAfterMs: 2_000,
          transactionId: "history-transaction",
        }}
        initialStep="proof"
      />,
    );

    expect(screen.getByText("HISTORY-CODE")).toBeVisible();
    fireEvent(window, new Event("pagehide"));
    await waitFor(() => expect(screen.queryByText("HISTORY-CODE")).not.toBeInTheDocument());
  });
});
