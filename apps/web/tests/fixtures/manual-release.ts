import type { Page } from "@playwright/test";

export const manualReleaseCsrfToken =
  "manual_release_fixture_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

export const manualReleaseCandidates = {
  approved: {
    ageMinutes: 48,
    customFormats: ["HDR10", "Surround sound"],
    customFormatScore: 1450,
    decision: "approved",
    downloadAllowed: true,
    episodeNumbers: [],
    fullSeason: false,
    id: "release_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    indexer: "Nebula Index",
    languages: ["English"],
    leechers: 4,
    protocol: "torrent",
    publishedAt: "2026-07-27T11:12:00.000Z",
    quality: "Bluray-2160p",
    rejectionReasons: [],
    releaseGroup: "SPECTRUM",
    requiresOverride: false,
    seeders: 92,
    sizeBytes: 18_400_000_000,
    title: "The.Far.Meridian.2026.2160p.UHD.BluRay.REMUX.HDR10.SPECTRUM",
  },
  rejected: {
    ageMinutes: 17,
    customFormats: ["WEB-DL"],
    customFormatScore: -10_000,
    decision: "rejected",
    downloadAllowed: true,
    episodeNumbers: [],
    fullSeason: false,
    id: "release_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    indexer: "Aurora Index",
    languages: ["English"],
    leechers: 1,
    protocol: "torrent",
    publishedAt: "2026-07-27T11:43:00.000Z",
    quality: "WEB-1080p",
    rejectionReasons: [
      "Quality profile does not allow WEB-1080p",
      "Release is not a preferred word",
    ],
    releaseGroup: "FROST",
    requiresOverride: true,
    seeders: 18,
    sizeBytes: 7_800_000_000,
    title: "The.Far.Meridian.2026.1080p.WEB-DL.DDP5.1.FROST",
  },
} as const;

export interface ManualReleaseCapture {
  body: unknown;
  csrfToken: string;
  idempotencyKey: string;
  requests: number;
}

export async function mockManualReleaseSession(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: manualReleaseCsrfToken,
        principal: {
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
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockManualReleaseSearch(page: Page) {
  await page.route("**/api/acquisitions/releases?*", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        expiresAt: "2026-07-27T12:05:00.000Z",
        generatedAt: "2026-07-27T12:00:00.000Z",
        releases: [manualReleaseCandidates.rejected, manualReleaseCandidates.approved],
        target: {
          episodeId: null,
          kind: "movie",
          mediaId: 42,
          seasonNumber: null,
          service: "radarr",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockManualReleaseGrab(page: Page) {
  const capture: ManualReleaseCapture = {
    body: null,
    csrfToken: "",
    idempotencyKey: "",
    requests: 0,
  };
  await page.route("**/api/acquisitions/releases/grabs", async (route) => {
    const request = route.request();
    capture.body = request.postDataJSON();
    capture.csrfToken = request.headers()["x-omnifin-csrf"] ?? "";
    capture.idempotencyKey = request.headers()["idempotency-key"] ?? "";
    capture.requests += 1;
    await route.fulfill({
      body: JSON.stringify({
        acceptedAt: "2026-07-27T12:01:00.000Z",
        operationId: "release_grab_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        releaseId: manualReleaseCandidates.rejected.id,
        service: "radarr",
        state: "accepted",
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 201,
    });
  });
  return capture;
}

export async function openManualReleaseWorkbench(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /2 acquisitions moving/i }).click();
  await page
    .getByRole("button", { name: "Inspect acquisition history for The Far Meridian" })
    .click();
  await page.getByRole("button", { name: "Browse releases" }).click();
  const workbench = page.getByRole("dialog", { name: "Release spectrum" });
  await workbench.getByRole("radio", { name: /2160p\.UHD/u }).waitFor();
  return workbench;
}
