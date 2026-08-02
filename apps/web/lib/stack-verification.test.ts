import { ROLE_PERMISSIONS, sessionPrincipalSchema } from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";

import { stackVerificationDemo } from "./stack-verification-demo";
import { runStackVerification, stackVerificationFilename } from "./stack-verification";

const csrfToken = "stack_verification_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

function principal(role: "admin" | "viewer" = "admin") {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-31T12:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: "Administrator",
    externalIdentity: null,
    inactivityExpiresAt: "2026-08-01T13:00:00.000Z",
    issuedAt: "2026-08-01T12:00:00.000Z",
    linkedServices: [
      {
        displayName: "Administrator",
        externalUserId: "jellyfin-user",
        health: "linked",
        id: "jellyfin-link",
        lastVerifiedAt: "2026-08-01T12:00:00.000Z",
        linkedAt: "2026-08-01T12:00:00.000Z",
        service: "jellyfin",
        username: "administrator",
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `${role}-session`,
    userId: `${role}-user`,
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("runStackVerification", () => {
  it("loads a CSRF proof and parses the strict report contract", async () => {
    const report = stackVerificationDemo("ready");
    const request = vi
      .fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ csrfToken, principal: principal() }))
      .mockResolvedValueOnce(json(report));

    await expect(runStackVerification({ request })).resolves.toEqual({ report, status: "ready" });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/admin/setup/verification",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-omnifin-csrf": csrfToken },
        method: "POST",
      }),
    );
  });

  it("does not start the broad check for a partial role", async () => {
    const request = vi.fn(async () => json({ csrfToken, principal: principal("viewer") }));

    await expect(runStackVerification({ request })).resolves.toEqual({ status: "forbidden" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps an expired session and an overlapping run without trusting arbitrary errors", async () => {
    const signedOut = vi.fn(async () => json({ csrfToken: null, principal: null }));
    await expect(runStackVerification({ request: signedOut })).resolves.toEqual({
      status: "signed_out",
    });

    const inProgress = vi
      .fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ csrfToken, principal: principal() }))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "stack_verification_in_progress",
              message: "A stack verification is already running for this session.",
              requestId: "request-12345678",
            },
          },
          409,
        ),
      );
    await expect(runStackVerification({ request: inProgress })).resolves.toEqual({
      status: "in_progress",
    });
  });

  it("distinguishes an authorization change from an expired session", async () => {
    const request = vi
      .fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ csrfToken, principal: principal() }))
      .mockResolvedValueOnce(json({}, 403));

    await expect(runStackVerification({ request })).resolves.toEqual({ status: "forbidden" });
  });

  it("fails closed on an expanded or malformed report", async () => {
    const malicious = {
      ...stackVerificationDemo("ready"),
      connectorUrls: ["https://private.example.test/?token=secret"],
    };
    const request = vi
      .fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ csrfToken, principal: principal() }))
      .mockResolvedValueOnce(json(malicious));

    await expect(runStackVerification({ request })).resolves.toEqual({ status: "unavailable" });
  });
});

describe("stackVerificationFilename", () => {
  it("uses a deterministic, privacy-safe UTC filename", () => {
    expect(stackVerificationFilename("2026-08-01T12:34:56.000Z")).toBe(
      "omnifin-stack-verification-20260801T123456Z.json",
    );
    expect(stackVerificationFilename("not-a-date")).toBe("omnifin-stack-verification.json");
  });
});
