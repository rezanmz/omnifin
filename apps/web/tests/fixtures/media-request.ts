import type { Page } from "@playwright/test";

export const mediaRequestCsrfToken =
  "media_request_fixture_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

export function mediaRequestRoutingReference(name: string) {
  return `routing-v1.v2.${name}.${"e".repeat(32)}.${"f".repeat(32)}`;
}

export const mediaRequestRoutingOptions = {
  destinations: [
    {
      id: mediaRequestRoutingReference("radarr-primary"),
      isDefault: true,
      label: "Cinema primary",
      languageProfiles: [],
      qualityProfiles: [
        {
          id: mediaRequestRoutingReference("quality-balanced"),
          isDefault: true,
          label: "Balanced",
        },
        {
          id: mediaRequestRoutingReference("quality-remux"),
          isDefault: false,
          label: "Remux",
        },
      ],
      rootFolders: [
        {
          availableBytes: 860_000_000_000,
          capacityBytes: 2_000_000_000_000,
          id: mediaRequestRoutingReference("root-cinema"),
          isDefault: true,
          label: "Cinema",
        },
        {
          availableBytes: 1_620_000_000_000,
          capacityBytes: 4_000_000_000_000,
          id: mediaRequestRoutingReference("root-archive"),
          isDefault: false,
          label: "Archive",
        },
      ],
      service: "radarr",
    },
  ],
  expiresAt: "2026-07-27T12:15:00.000Z",
  failures: [],
  generatedAt: "2026-07-27T12:00:00.000Z",
  is4k: false,
  kind: "movie",
} as const;

export const mediaRequestPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Mina",
  externalIdentity: {
    displayClaims: { displayName: "Mina" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "mina-subject",
  },
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Mina’s Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "mina",
    },
  ],
  permissions: [
    "media.view",
    "playback.use",
    "identities.self.manage",
    "sessions.self.revoke",
    "request.create",
  ],
  role: "requester",
  sessionId: "session-mina",
  userId: "user-mina",
} as const;

export interface MediaRequestCapture {
  body: unknown;
  csrfToken: string;
  idempotencyKey: string;
}

export async function mockMediaRequestSession(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrfToken: mediaRequestCsrfToken,
        principal: mediaRequestPrincipal,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockMediaRequestRouting(page: Page) {
  await page.route("**/api/requests/routing-options?*", async (route) => {
    await route.fulfill({
      body: JSON.stringify(mediaRequestRoutingOptions),
      contentType: "application/json",
      status: 200,
    });
  });
}

export async function mockMediaRequestCreation(page: Page) {
  const capture: MediaRequestCapture = { body: null, csrfToken: "", idempotencyKey: "" };
  await page.route("**/api/requests", async (route) => {
    const request = route.request();
    capture.body = request.postDataJSON();
    capture.csrfToken = request.headers()["x-omnifin-csrf"] ?? "";
    capture.idempotencyKey = request.headers()["idempotency-key"] ?? "";
    await route.fulfill({
      body: JSON.stringify({
        createdAt: "2026-07-27T12:01:00.000Z",
        id: "request:42",
        is4k: false,
        kind: "movie",
        seasons: null,
        source: "seerr",
        status: "pending",
        tmdbId: 603,
      }),
      contentType: "application/json",
      headers: { "idempotency-replayed": "false" },
      status: 201,
    });
  });
  return capture;
}
