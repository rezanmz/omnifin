import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorAdmin, JellyfinProvisioningConfig } from "@omnifin/contracts/connectors";
import { describe, expect, it, vi } from "vitest";

import { ConnectorAdminClientError, type JellyfinProvisioningClient } from "../lib/connector-admin";
import { JellyfinProvisioningSettings } from "./jellyfin-provisioning-settings";

const connector = { id: "jellyfin", service: "jellyfin", enabled: true, healthState: "healthy" } as ConnectorAdmin;
const base: JellyfinProvisioningConfig = {
  connectorId: "jellyfin", credentialConfigured: false, credentialKind: null, enabled: false,
  revision: 1, template: null, validatedAt: null, validationState: "unvalidated",
};
const credentialed: JellyfinProvisioningConfig = {
  ...base, credentialConfigured: true, credentialKind: "access_token", validationState: "valid",
  validatedAt: "2026-07-26T12:00:00.000Z",
};
function renderSettings(overrides: Partial<JellyfinProvisioningClient> = {}, config = base) {
  const client: JellyfinProvisioningClient = {
    get: vi.fn(async () => config),
    templates: vi.fn(async () => ({ templates: [{ id: "template-1", displayName: "Household" }] })),
    update: vi.fn(async (_id, input) => ({ ...config, credentialConfigured: input.credential.kind !== "clear", enabled: input.enabled, revision: config.revision + 1 })),
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
    await waitFor(() => expect(client.update).toHaveBeenCalledWith("jellyfin", expect.objectContaining({ enabled: false }), "csrf"));
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
    await waitFor(() => expect(client.update).toHaveBeenCalledWith("jellyfin", expect.objectContaining({ enabled: true, templateUserId: "template-1" }), "csrf"));
  });

  it("reconciles a stale revision with a safe conflict message", async () => {
    const user = userEvent.setup();
    const get = vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, revision: 2 });
    const client = renderSettings({ get, update: vi.fn().mockRejectedValue(new ConnectorAdminClientError("rejected", "connector_jellyfin_provisioning_revision_conflict", "The provisioning configuration changed since it was loaded.")) }, credentialed);
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "secret-value");
    await user.click(await screen.findByRole("button", { name: "Save credential (disabled)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
    expect(get).toHaveBeenCalledTimes(2);
    expect(client.update).toHaveBeenCalled();
  });
});
