import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type OidcProviderAdmin,
  type OidcProviderCapabilities,
  type RoleMapping,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IdentityProviderAdminClientError,
  type IdentityProviderAdminClient,
  type IdentityProviderAdminLoadOutcome,
} from "../lib/identity-provider-admin";
import { IdentityProviderConsole } from "./identity-provider-console";

const csrfToken = "test_csrf_token_0123456789abcdefghijklmnopqrstuvwxyz";
const provider: OidcProviderAdmin = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://identity.example.test"],
  clientId: "omnifin-web",
  clientSecretConfigured: true,
  createdAt: "2026-07-25T12:00:00.000Z",
  discoveryCheckedAt: "2026-07-26T12:00:00.000Z",
  discoveryState: "ready",
  displayName: "Authentik",
  enabled: false,
  id: "oidc-authentik",
  idTokenSigningAlg: "RS256",
  issuer: "https://identity.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email", "groups"],
  slug: "authentik",
  tokenEndpointAuthMethod: "client_secret_basic",
  updatedAt: "2026-07-26T12:00:00.000Z",
};
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin-1",
      health: "linked",
      id: "jellyfin-link-admin",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin",
      username: "admin",
    },
  ],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin",
  sessionId: "session-admin-1",
  userId: "user-admin-1",
};
const mapping: RoleMapping = {
  claimPath: ["groups"],
  enabled: true,
  id: "mapping-operators",
  operator: "contains_any",
  priority: 500,
  providerId: provider.id,
  role: "operator",
  values: ["media-operators"],
};
const capabilities: OidcProviderCapabilities = {
  authorizationCodeFlow: true,
  idTokenSigningAlg: "RS256",
  logout: {
    backChannel: true,
    backChannelSession: true,
    frontChannel: true,
    frontChannelSession: true,
    rpInitiated: true,
  },
  pkceS256: true,
  schemaVersion: 1,
  tokenEndpointAuthMethod: "client_secret_basic",
  userInfo: true,
};

function ready(
  providers: readonly OidcProviderAdmin[] = [provider],
): IdentityProviderAdminLoadOutcome {
  return { snapshot: { csrfToken, principal, providers }, status: "ready" };
}

function client(overrides: Partial<IdentityProviderAdminClient> = {}): IdentityProviderAdminClient {
  return {
    createProvider: vi.fn(async () => provider),
    createRoleMapping: vi.fn(async () => ({ mapping, revokedSessions: 0 })),
    deleteProvider: vi.fn(async () => ({
      deletedProviderId: provider.id,
      deletedRoleMappings: 1,
      revokedSessions: 0,
    })),
    deleteRoleMapping: vi.fn(async () => ({
      deletedMappingId: mapping.id,
      revokedSessions: 1,
    })),
    listRoleMappings: vi.fn(async () => [mapping]),
    load: vi.fn(async () => ready()),
    startAdministratorBootstrap: vi.fn(async () => ({
      authorizationUrl: "https://identity.example.test/application/o/authorize/?state=fixture",
      expiresAt: "2026-07-26T12:10:00.000Z",
    })),
    updateProvider: vi.fn(async (_providerId, input) => ({
      provider: { ...provider, ...input },
      revokedSessions: 0,
    })),
    updateRoleMapping: vi.fn(async (_providerId, _mappingId, input) => ({
      mapping: { ...mapping, ...input },
      revokedSessions: 0,
    })),
    validateProvider: vi.fn(async () => ({ capabilities, provider })),
    ...overrides,
  };
}

describe("IdentityProviderConsole", () => {
  afterEach(() => vi.restoreAllMocks());

  it("presents exact endpoints, validation state, and typed mappings without secret material", async () => {
    render(
      <IdentityProviderConsole
        client={client()}
        initialMappings={{ [provider.id]: [mapping] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test/"
      />,
    );

    expect(screen.getByRole("heading", { name: "Trust, made visible." })).toBeVisible();
    expect(screen.getByText("Validated")).toBeVisible();
    expect(
      screen.getByText("https://omnifin.example.test/api/auth/oidc/callback/oidc-authentik"),
    ).toBeVisible();
    expect(await screen.findByText(/media-operators/)).toBeVisible();
    expect(screen.getByText("operator")).toBeVisible();
    expect(screen.queryByText(/client secret value/i)).not.toBeInTheDocument();
  });

  it("offers an explicit OIDC first-admin claim only to recovery access", async () => {
    const startAdministratorBootstrap = vi.fn(async () => ({
      authorizationUrl: "https://identity.example.test/application/o/authorize/?state=fixture",
      expiresAt: "2026-07-26T12:10:00.000Z",
    }));
    const recoveryPrincipal: SessionPrincipal = {
      ...principal,
      accountState: "recovery",
      authenticationMethod: { kind: "recovery" },
      displayName: "Recovery access",
      linkedServices: [],
      permissions: [...RECOVERY_PERMISSIONS],
      userId: null,
    };
    render(
      <IdentityProviderConsole
        client={client({ startAdministratorBootstrap })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={{
          snapshot: {
            csrfToken,
            principal: recoveryPrincipal,
            providers: [{ ...provider, enabled: true }],
          },
          status: "ready",
        }}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    const button = await screen.findByRole("button", { name: "Continue with OIDC" });
    expect(button).toBeEnabled();
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(startAdministratorBootstrap).toHaveBeenCalledWith(provider.id, csrfToken),
    );
  });

  it("guides an Authentik connection from reserved endpoints to a disabled provider", async () => {
    const user = userEvent.setup();
    const createProvider = vi.fn(async () => provider);
    render(
      <IdentityProviderConsole
        client={client({ createProvider })}
        initialOutcome={ready([])}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("complete issuer URL");
    await user.type(
      screen.getByRole("textbox", { name: /Issuer URL/ }),
      "https://identity.example.test/application/o/omnifin/",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText("https://omnifin.example.test/api/auth/oidc/callback/oidc-authentik"),
    ).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: /Client ID/ }), "omnifin-web");
    await user.type(screen.getByLabelText(/Client secret/), "sealed-value");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByLabelText(/Request Authentik group claims/));
    await user.click(screen.getByRole("button", { name: "Save disabled provider" }));

    await waitFor(() => expect(createProvider).toHaveBeenCalledOnce());
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedEndpointOrigins: ["https://identity.example.test"],
        clientSecret: "sealed-value",
        enabled: false,
        scopes: ["openid", "profile", "email", "groups"],
      }),
      csrfToken,
    );
    expect(screen.getByRole("status")).toHaveTextContent("saved disabled");
  });

  it("validates discovery before enabling sign-in and renders advertised capabilities", async () => {
    const user = userEvent.setup();
    const validateProvider = vi.fn(async () => ({ capabilities, provider }));
    const updateProvider = vi.fn(async (_providerId, input) => ({
      provider: { ...provider, ...input, enabled: true },
      revokedSessions: 0,
    }));
    render(
      <IdentityProviderConsole
        client={client({ updateProvider, validateProvider })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Validate now" }));
    await waitFor(() => expect(validateProvider).toHaveBeenCalledWith(provider.id, csrfToken));
    expect(screen.getByLabelText("Validated OIDC capabilities")).toHaveTextContent("PKCE S256");

    await user.click(screen.getByRole("button", { name: "Enable sign-in" }));
    await waitFor(() => expect(updateProvider).toHaveBeenCalledOnce());
    expect(updateProvider).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({ enabled: true }),
      csrfToken,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sign-in is now enabled");
  });

  it("reviews all configuration steps while retaining a sealed client secret", async () => {
    const user = userEvent.setup();
    const updateProvider = vi.fn(async (_providerId, input) => ({
      provider: { ...provider, ...input },
      revokedSessions: 3,
    }));
    render(
      <IdentityProviderConsole
        client={client({ updateProvider })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit configuration" }));
    expect(
      await screen.findByRole("list", { name: "Provider editing progress" }),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Display name" }));
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "Authentik Home");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText(/Client secret/)).toHaveValue("");
    expect(screen.getByText("Leave blank to keep the sealed secret.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByLabelText(/Just-in-time provisioning/));
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    await waitFor(() => expect(updateProvider).toHaveBeenCalledOnce());
    const update = updateProvider.mock.calls[0]?.[1];
    expect(update).toMatchObject({
      allowJitProvisioning: false,
      displayName: "Authentik Home",
    });
    expect(update).not.toHaveProperty("clientSecret");
    expect(screen.getByRole("status")).toHaveTextContent("3 OIDC sessions closed");
  });

  it("announces copied provider endpoints and recovers an offline view", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const load = vi.fn(async () => ready());
    const { rerender } = render(
      <IdentityProviderConsole
        client={client()}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy Redirect URI" }));
    expect(writeText).toHaveBeenCalledWith(
      "https://omnifin.example.test/api/auth/oidc/callback/oidc-authentik",
    );
    expect(screen.getByText("Redirect URI copied")).toBeInTheDocument();

    rerender(
      <IdentityProviderConsole
        client={client({ load })}
        initialOutcome={{ status: "unavailable" }}
        key="offline"
        publicBaseUrl="https://omnifin.example.test"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Authentik" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
  });

  it("creates, edits, and deliberately removes exact typed role mappings", async () => {
    const user = userEvent.setup();
    const booleanMapping: RoleMapping = {
      ...mapping,
      id: "mapping-staff",
      role: "requester",
      values: [true],
    };
    const createRoleMapping = vi.fn(async () => ({
      mapping: booleanMapping,
      revokedSessions: 2,
    }));
    const deleteRoleMapping = vi.fn(async () => ({
      deletedMappingId: booleanMapping.id,
      revokedSessions: 1,
    }));
    const updateRoleMapping = vi.fn(async (_providerId, _mappingId, input) => ({
      mapping: { ...booleanMapping, ...input, priority: 720 },
      revokedSessions: 2,
    }));
    render(
      <IdentityProviderConsole
        client={client({ createRoleMapping, deleteRoleMapping, updateRoleMapping })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.selectOptions(screen.getByLabelText("Omnifin role"), "requester");
    await user.selectOptions(screen.getByLabelText("Value type"), "boolean");
    await user.clear(screen.getByLabelText(/Matching values/));
    await user.type(screen.getByLabelText(/Matching values/), "true");
    await user.click(screen.getByRole("button", { name: "Add mapping" }));

    await waitFor(() => expect(createRoleMapping).toHaveBeenCalledOnce());
    expect(createRoleMapping).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({ role: "requester", values: [true] }),
      csrfToken,
    );
    await user.click(screen.getByRole("button", { name: "Edit groups mapping" }));
    expect(screen.getByRole("heading", { name: "Edit role mapping" })).toHaveFocus();
    await user.clear(screen.getByLabelText("Priority"));
    await user.type(screen.getByLabelText("Priority"), "720");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() =>
      expect(updateRoleMapping).toHaveBeenCalledWith(
        provider.id,
        booleanMapping.id,
        expect.objectContaining({ priority: 720, role: "requester", values: [true] }),
        csrfToken,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 role-derived sessions closed");
    await user.click(screen.getByRole("button", { name: "Remove groups mapping" }));
    expect(screen.getByRole("group", { name: /Remove/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(deleteRoleMapping).toHaveBeenCalledWith(provider.id, booleanMapping.id, csrfToken),
    );
  });

  it("preserves mixed scalar claim values while editing", async () => {
    const user = userEvent.setup();
    const mixedMapping: RoleMapping = {
      ...mapping,
      id: "mapping-mixed-entitlements",
      values: ["media-staff", 7, true],
    };
    const updateRoleMapping = vi.fn(async (_providerId, _mappingId, input) => ({
      mapping: { ...mixedMapping, ...input },
      revokedSessions: 1,
    }));
    render(
      <IdentityProviderConsole
        client={client({ updateRoleMapping })}
        initialMappings={{ [provider.id]: [mixedMapping] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit groups mapping" }));
    expect(screen.getByLabelText("Value type")).toHaveValue("mixed");
    expect(screen.getByLabelText(/Matching values/)).toHaveValue(
      "string:media-staff\nnumber:7\nboolean:true",
    );
    await user.clear(screen.getByLabelText("Priority"));
    await user.type(screen.getByLabelText("Priority"), "501");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    await waitFor(() =>
      expect(updateRoleMapping).toHaveBeenCalledWith(
        provider.id,
        mixedMapping.id,
        expect.objectContaining({ priority: 501, values: ["media-staff", 7, true] }),
        csrfToken,
      ),
    );
  });

  it("keeps the editor open when an equivalent mapping conflicts", async () => {
    const user = userEvent.setup();
    const updateRoleMapping = vi.fn(async () => {
      throw new IdentityProviderAdminClientError(
        "rejected",
        "oidc_role_mapping_conflict",
        "An equivalent role mapping already exists.",
      );
    });
    render(
      <IdentityProviderConsole
        client={client({ updateRoleMapping })}
        initialMappings={{ [provider.id]: [mapping] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit groups mapping" }));
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An equivalent role mapping already exists.",
    );
    expect(screen.getByRole("heading", { name: "Edit role mapping" })).toBeVisible();
  });

  it("requires confirmation before deleting a disabled, unbound provider", async () => {
    const user = userEvent.setup();
    const deleteProvider = vi.fn(async () => ({
      deletedProviderId: provider.id,
      deletedRoleMappings: 1,
      revokedSessions: 0,
    }));
    render(
      <IdentityProviderConsole
        client={client({ deleteProvider })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm provider deletion" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith(provider.id, csrfToken));
    expect(await screen.findByRole("heading", { name: "Connect Authentik" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Provider deleted");
  });

  it("moves to signed-out state when a mutation reports a changed session", async () => {
    const user = userEvent.setup();
    const validateProvider = vi.fn(async () => {
      throw new IdentityProviderAdminClientError(
        "session_changed",
        "session_changed",
        "Your administrative session changed.",
      );
    });
    render(
      <IdentityProviderConsole
        client={client({ validateProvider })}
        initialMappings={{ [provider.id]: [] }}
        initialOutcome={ready()}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Validate now" }));
    expect(await screen.findByText("Your administrative session ended.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it.each([
    ["forbidden", "This control room is restricted."],
    ["signed_out", "Your administrative session ended."],
    ["unavailable", "Identity controls are temporarily offline."],
  ] as const)("renders the %s degraded state", (status, heading) => {
    render(
      <IdentityProviderConsole
        client={client()}
        initialOutcome={{ status }}
        publicBaseUrl="https://omnifin.example.test"
      />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  });
});
