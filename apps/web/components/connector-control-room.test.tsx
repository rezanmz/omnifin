import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { ConnectorAdmin } from "@omnifin/contracts/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorAdminClientError,
  type ConnectorAdminClient,
  type ConnectorAdminLoadOutcome,
} from "../lib/connector-admin";
import { ConnectorControlRoom } from "./connector-control-room";

const csrfToken = "test_connector_csrf_0123456789abcdefghijklmnop";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administrator",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
    },
  ],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};
const jellyfin: ConnectorAdmin = {
  baseUrl: "https://jellyfin.example.test",
  createdAt: "2026-07-26T12:00:00.000Z",
  credentialKind: "none",
  credentialsConfigured: true,
  displayName: "Living Room Jellyfin",
  enabled: false,
  healthState: "healthy",
  id: "jellyfin-primary",
  insecureHttpApproved: false,
  lastProbe: {
    capabilities: ["connector.health", "connector.version", "media.playback"],
    checkedAt: "2026-07-26T12:00:00.000Z",
    connectorId: "jellyfin-primary",
    displayName: "Living Room Jellyfin",
    failure: null,
    latencyMs: 18,
    service: "jellyfin",
    status: "healthy",
    version: "10.10.7",
  },
  publicUiUrl: null,
  revision: "revision_0123456789abcdef",
  service: "jellyfin",
  tlsCaCertificateConfigured: false,
  tlsPolicy: "strict",
  updatedAt: "2026-07-26T12:00:00.000Z",
};
const radarr: ConnectorAdmin = {
  ...jellyfin,
  baseUrl: "https://radarr.example.test",
  credentialKind: "api_key",
  displayName: "Radarr",
  healthState: "degraded",
  id: "radarr-primary",
  lastProbe: {
    capabilities: ["connector.health", "acquisition.search"],
    checkedAt: "2026-07-26T11:00:00.000Z",
    connectorId: "radarr-primary",
    displayName: "Radarr",
    failure: {
      code: "timeout",
      message: "Radarr did not answer before the connector deadline.",
      occurredAt: "2026-07-26T11:00:00.000Z",
      operation: "connector.probe",
      retryable: true,
      service: "radarr",
    },
    latencyMs: 5000,
    service: "radarr",
    status: "degraded",
    version: "5.27.5",
  },
  revision: "revision_1234567890abcdef",
  service: "radarr",
};

function ready(
  connectors: readonly ConnectorAdmin[] = [jellyfin, radarr],
): ConnectorAdminLoadOutcome {
  return {
    snapshot: { connectors, csrfToken, principal, recoveryOnly: false },
    status: "ready",
  };
}

function client(overrides: Partial<ConnectorAdminClient> = {}): ConnectorAdminClient {
  return {
    create: vi.fn(async () => jellyfin),
    delete: vi.fn(async (connectorId) => ({ deletedConnectorId: connectorId })),
    get: vi.fn(async () => jellyfin),
    load: vi.fn(async () => ready()),
    probe: vi.fn(async () => jellyfin),
    update: vi.fn(async (_connectorId, input) => ({ ...jellyfin, ...input })),
    ...overrides,
  };
}

describe("ConnectorControlRoom", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders normalized signal health and never exposes credential values", () => {
    render(<ConnectorControlRoom client={client()} initialOutcome={ready()} />);

    expect(screen.getByRole("heading", { name: "Every service. One signal." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Living Room Jellyfin" })).toBeVisible();
    expect(screen.getByText("10.10.7")).toBeVisible();
    expect(screen.getByText("18 ms")).toBeVisible();
    expect(screen.getByText("Jul 26, 12:00 PM UTC")).toBeVisible();
    expect(screen.getByText("media · playback")).toBeVisible();
    expect(screen.getByText("Not required")).toBeVisible();
    expect(
      screen.queryByText(/api.?key value|password value|token value/i),
    ).not.toBeInTheDocument();
  });

  it("creates a disabled connector only after contract-valid destination input", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async (input) => ({ ...jellyfin, ...input }) as ConnectorAdmin);
    render(<ConnectorControlRoom client={client({ create })} initialOutcome={ready([])} />);

    await user.click(await screen.findByRole("button", { name: "Save disabled connector" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/url/i);
    await user.type(screen.getByRole("textbox", { name: /Service URL/ }), jellyfin.baseUrl);
    await user.click(screen.getByRole("button", { name: "Save disabled connector" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { kind: "none" },
        id: "jellyfin-primary",
        service: "jellyfin",
      }),
      csrfToken,
    );
    expect(screen.getByRole("status")).toHaveTextContent("saved in standby");
  });

  it("clears a browser destination when changing the service type", async () => {
    const user = userEvent.setup();
    render(<ConnectorControlRoom client={client()} initialOutcome={ready([])} />);

    await user.click(await screen.findByRole("button", { name: "Radarr" }));
    const browserUrl = screen.getByRole("textbox", { name: /Browser URL/ });
    await user.type(browserUrl, "https://radarr.example.test");
    await user.click(screen.getByRole("button", { name: "Sonarr" }));

    expect(screen.getByRole("textbox", { name: /Browser URL/ })).toHaveValue("");
  });

  it("probes before bringing a connector online", async () => {
    const user = userEvent.setup();
    const unknown = { ...jellyfin, healthState: "unknown" as const, lastProbe: null };
    const probe = vi.fn(async () => ({ ...jellyfin, revision: "revision_healthy1234567890" }));
    const update = vi.fn(async (_connectorId, input) => ({
      ...jellyfin,
      ...input,
      revision: "revision_enabled123456789",
    }));
    render(
      <ConnectorControlRoom client={client({ probe, update })} initialOutcome={ready([unknown])} />,
    );

    expect(screen.getByRole("button", { name: "Bring online" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Probe signal" }));
    await waitFor(() => expect(probe).toHaveBeenCalledWith(unknown.id, csrfToken));
    expect(screen.getByRole("button", { name: "Bring online" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Bring online" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        unknown.id,
        { enabled: true, revision: "revision_healthy1234567890" },
        csrfToken,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("is online");
  });

  it("recovers from an unavailable initial load without keeping stale state", async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ready());
    render(<ConnectorControlRoom client={client({ load })} />);

    expect(screen.getByLabelText("Loading service connections")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      await screen.findByRole("heading", { name: "The gateway signal is unavailable." }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByRole("heading", { name: "Living Room Jellyfin" })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("moves to the signed-out state when a mutation reports a changed session", async () => {
    const user = userEvent.setup();
    const probe = vi.fn(async () => {
      throw new ConnectorAdminClientError(
        "session_changed",
        "session_signed_out",
        "Your administrative session changed.",
      );
    });
    render(<ConnectorControlRoom client={client({ probe })} initialOutcome={ready([jellyfin])} />);

    await user.click(screen.getByRole("button", { name: "Probe signal" }));

    expect(
      await screen.findByRole("heading", { name: "Your administrative session ended." }),
    ).toBeVisible();
  });

  it("preserves sealed credentials when an edit submits no replacement", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async (_connectorId, input) => ({ ...radarr, ...input }));
    render(<ConnectorControlRoom client={client({ update })} initialOutcome={ready([radarr])} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const displayName = await screen.findByRole("textbox", { name: "Display name" });
    await user.clear(displayName);
    await user.type(displayName, "Cinema Radarr");
    await user.click(screen.getByRole("button", { name: "Save and re-probe" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      radarr.id,
      expect.not.objectContaining({ credentials: expect.anything() }),
      csrfToken,
    );
    expect(update.mock.calls[0]?.[1]).toMatchObject({ displayName: "Cinema Radarr" });
  });

  it("validates and submits the separate browser-facing URL", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async (_connectorId, input) => ({ ...radarr, ...input }));
    render(<ConnectorControlRoom client={client({ update })} initialOutcome={ready([radarr])} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const browserUrl = await screen.findByRole("textbox", { name: /Browser URL/ });
    await user.type(browserUrl, "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Save and re-probe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/url/i);
    expect(update).not.toHaveBeenCalled();

    await user.clear(browserUrl);
    await user.type(browserUrl, "https://media.example.test/radarr");
    await user.click(screen.getByRole("button", { name: "Save and re-probe" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      radarr.id,
      expect.objectContaining({ publicUiUrl: "https://media.example.test/radarr" }),
      csrfToken,
    );
  });

  it("requires an intentional method change and can clear optional API authentication", async () => {
    const user = userEvent.setup();
    const seerr = {
      ...radarr,
      baseUrl: "https://seerr.example.test",
      displayName: "Seerr",
      id: "seerr-primary",
      service: "seerr" as const,
    };
    const update = vi.fn(async (_connectorId, input) => ({ ...seerr, ...input }));
    render(<ConnectorControlRoom client={client({ update })} initialOutcome={ready([seerr])} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Authentication method" }),
      ["none"],
    );
    await user.click(screen.getByRole("button", { name: "Save and re-probe" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      seerr.id,
      expect.objectContaining({ credentials: { kind: "none" } }),
      csrfToken,
    );
  });

  it("requires explicit confirmation before deleting a disabled connector", async () => {
    const user = userEvent.setup();
    const deleteConnector = vi.fn(async (connectorId) => ({ deletedConnectorId: connectorId }));
    render(
      <ConnectorControlRoom
        client={client({ delete: deleteConnector })}
        initialOutcome={ready([jellyfin])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteConnector).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm connector deletion" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() =>
      expect(deleteConnector).toHaveBeenCalledWith(jellyfin.id, jellyfin.revision, csrfToken),
    );
    expect(screen.getByRole("status")).toHaveTextContent("sealed credentials were deleted");
  });

  it("surfaces normalized degraded failures with safe retry guidance", async () => {
    const user = userEvent.setup();
    render(<ConnectorControlRoom client={client()} initialOutcome={ready([jellyfin, radarr])} />);

    await user.click(screen.getByRole("button", { name: /Radarr/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Radarr did not answer before the connector deadline.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("retried safely");
    expect(screen.getByText("timeout")).toBeVisible();
  });

  it("keeps recovery sessions inside the Jellyfin repair boundary", () => {
    const recoveryPrincipal: SessionPrincipal = {
      ...principal,
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
      linkedServices: [],
      permissions: ["recovery.oidc.manage", "recovery.jellyfin.manage", "recovery.sessions.revoke"],
      userId: null,
    };
    render(
      <ConnectorControlRoom
        client={client()}
        initialOutcome={{
          snapshot: {
            connectors: [jellyfin],
            csrfToken,
            principal: recoveryPrincipal,
            recoveryOnly: true,
          },
          status: "ready",
        }}
      />,
    );

    expect(screen.getByText("Recovery boundary active")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add service connection" })).toBeDisabled();
    expect(screen.queryByText("Radarr")).not.toBeInTheDocument();
  });

  it.each([
    ["signed_out", "Your administrative session ended."],
    ["forbidden", "This control room is restricted."],
    ["unavailable", "The gateway signal is unavailable."],
  ] as const)("renders the %s route state", (status, heading) => {
    render(
      <ConnectorControlRoom
        client={client()}
        initialOutcome={{ status } as ConnectorAdminLoadOutcome}
      />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  });
});
