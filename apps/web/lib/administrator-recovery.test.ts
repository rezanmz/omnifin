import { RECOVERY_PERMISSIONS, ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
  loadAdministratorRecoveryPreview,
  parseAdministratorRecoveryBrowserSession,
  pollAdministratorRecoveryQuickConnect,
  replaceAdministratorWithJellyfinPassword,
  startAdministratorRecoveryOidc,
  startAdministratorRecoveryQuickConnect,
  verifyAdministratorRecoverySession,
} from "./administrator-recovery";

const csrfToken = "administrator_recovery_csrf_0123456789abcdefghij";
const target = {
  administratorId: "administrator-primary",
  confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
  expectedUpdatedAt: "2026-08-08T13:45:00.000Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function linkedService() {
  return {
    displayName: "Replacement administrator",
    externalUserId: "jellyfin-replacement",
    health: "linked",
    id: "replacement-link",
    lastVerifiedAt: "2026-08-08T14:00:00.000Z",
    linkedAt: "2026-08-01T12:00:00.000Z",
    service: "jellyfin",
    username: "replacement",
  };
}

function administratorSession() {
  return {
    csrfToken,
    principal: {
      absoluteExpiresAt: "2026-08-09T14:00:00.000Z",
      accountState: "active",
      authenticationMethod: { kind: "jellyfin" },
      displayName: "Replacement administrator",
      externalIdentity: null,
      inactivityExpiresAt: "2026-08-08T15:00:00.000Z",
      issuedAt: "2026-08-08T14:00:00.000Z",
      linkedServices: [linkedService()],
      permissions: [...ROLE_PERMISSIONS.admin],
      role: "admin",
      sessionId: "replacement-session",
      userId: "replacement-account",
    },
  };
}

function recoverySession() {
  return {
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
  };
}

describe("administrator recovery client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads only the bounded sole-administrator preview with same-origin CSRF proof", async () => {
    const administrator = {
      activeSessions: 3,
      authenticationMethods: ["jellyfin", "oidc"],
      displayName: "Primary administrator",
      id: "administrator-primary",
      updatedAt: target.expectedUpdatedAt,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ administrator, status: "available" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAdministratorRecoveryPreview(csrfToken)).resolves.toEqual({
      administrator,
      status: "available",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/recovery/administrator-replacement/preview",
      expect.objectContaining({
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        method: "POST",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
  });

  it("keeps zero and multiple administrator states in one generic unavailable outcome", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "unavailable" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "rate_limit_exceeded", message: "Wait", requestId: "request-1" } },
          { headers: { "retry-after": "90" }, status: 429 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAdministratorRecoveryPreview(csrfToken)).resolves.toEqual({
      status: "target_unavailable",
    });
    await expect(loadAdministratorRecoveryPreview(csrfToken)).resolves.toEqual({
      retryAfterSeconds: 90,
      status: "rate_limited",
    });
  });

  it("submits the literal, target revision, and exact password bytes without retaining a success principal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        csrfToken,
        revokedSessions: { recovery: 1, replacement: 2, target: 3 },
        status: "replaced",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...target, password: "  fresh private password  ", username: "replacement" };

    await expect(replaceAdministratorWithJellyfinPassword(input, csrfToken)).resolves.toEqual({
      status: "replaced",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/auth/recovery/administrator-replacement/jellyfin/password",
    );
  });

  it("distinguishes stale targets from an uncertain network completion", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "unavailable" }, { status: 409 }))
      .mockRejectedValueOnce(new TypeError("connection closed"));
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...target, password: "private", username: "replacement" };

    await expect(replaceAdministratorWithJellyfinPassword(input, csrfToken)).resolves.toEqual({
      status: "stale_target",
    });
    await expect(replaceAdministratorWithJellyfinPassword(input, csrfToken)).resolves.toEqual({
      status: "uncertain",
    });
  });

  it("starts and polls a revision-bound Quick Connect transaction", async () => {
    const transaction = {
      code: "AB-1234",
      expiresAt: "2026-08-08T14:05:00.000Z",
      pollAfterMs: 2_000,
      transactionId: "replacement-quick-connect",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(transaction))
      .mockResolvedValueOnce(
        jsonResponse({
          expiresAt: transaction.expiresAt,
          pollAfterMs: 3_000,
          status: "pending",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(startAdministratorRecoveryQuickConnect(target, csrfToken)).resolves.toEqual({
      status: "started",
      transaction,
    });
    await expect(
      pollAdministratorRecoveryQuickConnect(transaction.transactionId, csrfToken),
    ).resolves.toEqual({
      expiresAt: transaction.expiresAt,
      pollAfterMs: 3_000,
      status: "pending",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/auth/recovery/administrator-replacement/jellyfin/quick-connect/replacement-quick-connect/poll",
    );
  });

  it("validates the OIDC authorization contract before exposing its URL", async () => {
    const authorization = {
      authorizationUrl: "https://identity.example.test/application/o/authorize/?state=opaque",
      expiresAt: "2026-08-08T14:05:00.000Z",
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(authorization));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startAdministratorRecoveryOidc("home-identity", target, csrfToken),
    ).resolves.toEqual({ authorization, status: "started" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/auth/recovery/administrator-replacement/oidc/home-identity/start",
    );
  });

  it("reports success only for a contract-valid normal administrator session", async () => {
    await expect(parseAdministratorRecoveryBrowserSession(recoverySession())).resolves.toEqual({
      csrfToken,
      status: "recovery",
    });
    await expect(parseAdministratorRecoveryBrowserSession(administratorSession())).resolves.toEqual(
      {
        csrfToken,
        status: "administrator",
      },
    );
    await expect(
      parseAdministratorRecoveryBrowserSession({
        csrfToken,
        principal: { accountState: "active", role: "admin" },
      }),
    ).resolves.toEqual({ status: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(administratorSession())),
    );
    await expect(verifyAdministratorRecoverySession()).resolves.toBe("administrator");
  });
});
