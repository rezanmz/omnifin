import type { Page } from "@playwright/test";

export const acquisitionRecoveryCsrfToken =
  "acquisition_recovery_fixture_csrf_0123456789abcdefghijklmnop";
export const acquisitionQueueRecoveryReference = `aqr_v2.${"A".repeat(100)}`;

export const acquisitionRecoveryPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Ari",
  externalIdentity: {
    displayClaims: { displayName: "Ari" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "ari-subject",
  },
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Ari’s Jellyfin",
      externalUserId: "jellyfin-ari",
      health: "linked",
      id: "jellyfin-link-ari",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "ari",
    },
  ],
  permissions: [
    "media.view",
    "playback.use",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
    "request.review",
    "acquisition.manage",
    "downloads.manage",
    "library.manage",
    "issue.manage",
  ],
  role: "operator",
  sessionId: "session-ari",
  userId: "user-ari",
} as const;

export interface AcquisitionRecoveryCapture {
  body: unknown;
  csrfToken: string;
  idempotencyKey: string;
}

export async function mockAcquisitionRecoverySession(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: acquisitionRecoveryCsrfToken,
        principal: acquisitionRecoveryPrincipal,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockAcquisitionSearch(page: Page) {
  const capture: AcquisitionRecoveryCapture = {
    body: null,
    csrfToken: "",
    idempotencyKey: "",
  };
  await page.route("**/api/acquisitions/searches", async (route) => {
    const request = route.request();
    capture.body = request.postDataJSON();
    capture.csrfToken = request.headers()["x-omnifin-csrf"] ?? "";
    capture.idempotencyKey = request.headers()["idempotency-key"] ?? "";
    await route.fulfill({
      body: JSON.stringify({
        acceptedAt: "2026-07-27T12:01:00.000Z",
        operationId: "radarr:command:88",
        state: "queued",
        target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 201,
    });
  });
  return capture;
}

export async function mockAcquisitionQueueRecovery(
  page: Page,
  outcome: "stale" | "success" = "success",
) {
  const capture: AcquisitionRecoveryCapture = {
    body: null,
    csrfToken: "",
    idempotencyKey: "",
  };
  await page.route("**/api/acquisitions/queue-recoveries", async (route) => {
    const request = route.request();
    capture.body = request.postDataJSON();
    capture.csrfToken = request.headers()["x-omnifin-csrf"] ?? "";
    capture.idempotencyKey = request.headers()["idempotency-key"] ?? "";
    if (outcome === "stale") {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: "acquisition_queue_recovery_stale",
            message: "That queue item changed or expired. Refresh before continuing.",
            requestId: "visual-queue-recovery-stale",
          },
        }),
        contentType: "application/json",
        status: 409,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        completedAt: "2026-07-27T19:02:00.000Z",
        eventId: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
        operationId: "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
        service: "radarr",
        state: "removed_and_blocklisted",
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 201,
    });
  });
  return capture;
}
