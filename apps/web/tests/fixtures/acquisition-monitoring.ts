import type { Page } from "@playwright/test";

import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";

export const acquisitionMonitoringCsrfToken =
  "acquisition_monitoring_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

export async function mockAcquisitionMonitoringSession(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: acquisitionMonitoringCsrfToken,
        principal: {
          absoluteExpiresAt: "2026-08-28T12:00:00.000Z",
          accountState: "active",
          authenticationMethod: { kind: "jellyfin" },
          displayName: "Operator",
          externalIdentity: null,
          inactivityExpiresAt: "2026-07-28T14:00:00.000Z",
          issuedAt: "2026-07-28T12:00:00.000Z",
          linkedServices: [
            {
              displayName: "Operator’s Jellyfin",
              externalUserId: "jellyfin-monitoring-operator",
              health: "linked",
              id: "jellyfin-link-monitoring-operator",
              lastVerifiedAt: "2026-07-28T12:00:00.000Z",
              linkedAt: "2026-07-27T12:00:00.000Z",
              service: "jellyfin",
              username: "operator",
            },
          ],
          permissions: ROLE_PERMISSIONS.operator,
          role: "operator",
          sessionId: "monitoring-session",
          userId: "monitoring-user",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockAcquisitionMonitoringUpdate(page: Page) {
  const capture: { body: unknown; csrfToken: string | null; requests: number } = {
    body: null,
    csrfToken: null,
    requests: 0,
  };
  await page.route("**/api/acquisitions/monitoring", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    capture.requests += 1;
    capture.body = route.request().postDataJSON();
    capture.csrfToken = route.request().headers()["x-omnifin-csrf"] ?? null;
    await route.fulfill({
      body: JSON.stringify({
        monitored: false,
        target: { kind: "movie", mediaId: 42, service: "radarr" },
        verifiedAt: "2026-07-28T12:01:00.000Z",
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  return capture;
}
