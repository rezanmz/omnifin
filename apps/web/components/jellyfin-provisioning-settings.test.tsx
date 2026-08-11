import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorAdmin, JellyfinProvisioningConfig } from "@omnifin/contracts/connectors";
import { describe, expect, it, vi } from "vitest";

import { ConnectorAdminClientError, type JellyfinProvisioningClient } from "../lib/connector-admin";
import { JellyfinProvisioningSettings } from "./jellyfin-provisioning-settings";

const connector = {
  id: "jellyfin",
  service: "jellyfin",
  enabled: true,
  healthState: "healthy",
} as ConnectorAdmin;
const base: JellyfinProvisioningConfig = {
  connectorId: "jellyfin",
  credentialConfigured: false,
  credentialKind: null,
  enabled: false,
  revision: 1,
  template: null,
  validatedAt: null,
  validationState: "unvalidated",
};
const credentialed: JellyfinProvisioningConfig = {
  ...base,
  credentialConfigured: true,
  credentialKind: "access_token",
  validationState: "valid",
  validatedAt: "2026-07-26T12:00:00.000Z",
};
function renderSettings(overrides: Partial<JellyfinProvisioningClient> = {}, config = base) {
  const client: JellyfinProvisioningClient = {
    get: vi.fn(async () => config),
    templates: vi.fn(async () => ({ templates: [{ id: "template-1", displayName: "Household" }] })),
    update: vi.fn(async (_id, input) => ({
      ...config,
      credentialConfigured: input.credential.kind !== "clear",
      enabled: input.enabled,
      revision: config.revision + 1,
    })),
    ...overrides,
  };
  render(<JellyfinProvisioningSettings client={client} connector={connector} csrfToken="csrf" />);
  return client;
}

describe("JellyfinProvisioningSettings", () => {
  it("stages a credential disabled and clears secret fields after saving", async () => {
    const user = userEvent.setup();
    const client = renderSettings();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret-value");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));
    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith(
        "jellyfin",
        expect.objectContaining({ enabled: false }),
        "csrf",
      ),
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByText(/remains disabled/i)).toBeVisible();
  });

  it("loads a display-name template and enables only after selection", async () => {
    const user = userEvent.setup();
    const client = renderSettings({}, credentialed);
    await user.click(await screen.findByRole("button", { name: "Load templates" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Template user" }), "template-1");
    await user.click(screen.getByLabelText(/Provisioning is enabled|Keep provisioning disabled/));
    await user.click(screen.getByRole("button", { name: "Save template settings" }));
    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith(
        "jellyfin",
        expect.objectContaining({ enabled: true, templateUserId: "template-1" }),
        "csrf",
      ),
    );
  });

  it("reconciles a stale revision with a safe conflict message", async () => {
    const user = userEvent.setup();
    const get = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, revision: 2 });
    const client = renderSettings(
      {
        get,
        update: vi
          .fn()
          .mockRejectedValue(
            new ConnectorAdminClientError(
              "rejected",
              "connector_jellyfin_provisioning_revision_conflict",
              "The provisioning configuration changed since it was loaded.",
            ),
          ),
      },
      credentialed,
    );
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret-value");
    await user.click(await screen.findByRole("button", { name: "Save credential (disabled)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
    expect(get).toHaveBeenCalledTimes(2);
    expect(client.update).toHaveBeenCalled();
  });

  it("clears a configured template with an explicit empty template payload", async () => {
    const user = userEvent.setup();
    const config = {
      ...credentialed,
      template: { id: "template-1", displayName: "Household" },
      enabled: true,
    };
    const client = renderSettings({}, config);
    await user.click(await screen.findByRole("button", { name: "Clear credential" }));
    await user.click(screen.getByRole("button", { name: "Clear credential", hidden: true }));
    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith(
        "jellyfin",
        expect.objectContaining({
          credential: { kind: "clear" },
          templateUserId: null,
          enabled: false,
          revision: 1,
        }),
        "csrf",
      ),
    );
    expect(screen.getByText(/Credential cleared/)).toBeVisible();
    expect(screen.getByText(/No provisioning credential configured/)).toBeVisible();
  });

  it("does not let a pending connector A response update connector B", async () => {
    let resolveA!: (value: JellyfinProvisioningConfig) => void;
    let resolveB!: (value: JellyfinProvisioningConfig) => void;
    const get = vi.fn(
      (id: string) =>
        new Promise<JellyfinProvisioningConfig>((resolve) => {
          if (id === "jellyfin") resolveA = resolve;
          else resolveB = resolve;
        }),
    );
    const { rerender } = render(
      <JellyfinProvisioningSettings
        client={{ get, templates: vi.fn(), update: vi.fn() } as JellyfinProvisioningClient}
        connector={connector}
        csrfToken="csrf"
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledWith("jellyfin"));
    rerender(
      <JellyfinProvisioningSettings
        client={{ get, templates: vi.fn(), update: vi.fn() } as JellyfinProvisioningClient}
        connector={{ ...connector, id: "jellyfin-secondary" } as ConnectorAdmin}
        csrfToken="csrf"
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledWith("jellyfin-secondary"));
    resolveA({
      ...credentialed,
      connectorId: "jellyfin",
      revision: 99,
      template: { id: "from-a", displayName: "A" },
    });
    resolveB({ ...base, connectorId: "jellyfin-secondary", revision: 2 });
    await waitFor(() =>
      expect(screen.getByText(/No provisioning credential configured/)).toBeVisible(),
    );
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("keeps a retryable error when conflict reconciliation fails", async () => {
    const get = vi.fn().mockResolvedValueOnce(base).mockRejectedValueOnce(new Error("offline"));
    renderSettings(
      {
        get,
        update: vi
          .fn()
          .mockRejectedValue(
            new ConnectorAdminClientError(
              "rejected",
              "connector_jellyfin_provisioning_revision_conflict",
              "changed",
            ),
          ),
      },
      credentialed,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Save credential (disabled)" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/could not be completed|offline/i),
    );
    expect(screen.queryByText(/latest version loaded/i)).not.toBeInTheDocument();
  });

  it("clears entered secrets when saving fails", async () => {
    const user = userEvent.setup();
    const client = renderSettings({ update: vi.fn().mockRejectedValue(new Error("offline")) });
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret-value");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue(""));
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByText(/Re-enter any credential/i)).toBeVisible();
    expect(client.update).toHaveBeenCalled();
  });

  it("resets entered secrets when the connector changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <JellyfinProvisioningSettings
        client={
          {
            get: vi.fn(async () => base),
            templates: vi.fn(),
            update: vi.fn(),
          } as JellyfinProvisioningClient
        }
        connector={connector}
        csrfToken="csrf"
      />,
    );
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret-value");
    rerender(
      <JellyfinProvisioningSettings
        client={
          {
            get: vi.fn(async () => base),
            templates: vi.fn(),
            update: vi.fn(),
          } as JellyfinProvisioningClient
        }
        connector={{ ...connector, id: "jellyfin-secondary" } as ConnectorAdmin}
        csrfToken="csrf"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue(""));
    expect(screen.getByLabelText("Username")).toHaveValue("");
  });

  it("announces template loading and retries in place", async () => {
    const user = userEvent.setup();
    let resolveTemplates!: (value: { templates: { id: string; displayName: string }[] }) => void;
    const templates = vi.fn(
      () =>
        new Promise<{ templates: { id: string; displayName: string }[] }>((resolve) => {
          resolveTemplates = resolve;
        }),
    );
    const get = vi.fn().mockResolvedValue(credentialed);
    const client = renderSettings(
      { templates, get, update: vi.fn().mockRejectedValue(new Error("offline")) },
      credentialed,
    );
    await user.click(await screen.findByRole("button", { name: "Load templates" }));
    expect(screen.getByRole("button", { name: "Loading templates…" })).toBeVisible();
    expect(screen.getByText("Loading template users…").closest("[role=status]")).toBeTruthy();
    resolveTemplates({ templates: [] });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load templates" })).toBeVisible(),
    );
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(client.update).toHaveBeenCalled();
  });
});
