import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";

import type { LibraryLoadOutcome } from "./library-operations";

export const libraryDemoGeneratedAt = "2026-07-28T16:00:00.000Z";

export const libraryDemoPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-27T16:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
  displayName: "Stack operator",
  externalIdentity: {
    displayClaims: { displayName: "Stack operator", preferredUsername: "operator" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "oidc-home",
    subject: "operator-subject",
  },
  inactivityExpiresAt: "2026-07-28T17:00:00.000Z",
  issuedAt: libraryDemoGeneratedAt,
  linkedServices: [
    {
      displayName: "Home Jellyfin",
      externalUserId: "operator-external",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: libraryDemoGeneratedAt,
      linkedAt: libraryDemoGeneratedAt,
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

export const readyLibraryOutcome: Extract<LibraryLoadOutcome, { status: "ready" }> = {
  snapshot: {
    attention: {
      generatedAt: libraryDemoGeneratedAt,
      items: [
        {
          identityState: "unmatched",
          issues: ["missing_identity", "missing_overview"],
          kind: "movie",
          overview: null,
          posterPath: `/v1/media/media_${"a".repeat(22)}/images/poster`,
          referenceId: `media_${"a".repeat(22)}`,
          title: "Ember Coast",
          year: 2026,
        },
        {
          identityState: "identified",
          issues: ["missing_poster", "missing_year"],
          kind: "series",
          overview: "A radio astronomer follows an impossible signal across a winter coastline.",
          posterPath: null,
          referenceId: `media_${"b".repeat(22)}`,
          title: "Northern Lights",
          year: null,
        },
        {
          identityState: "identified",
          issues: ["missing_overview"],
          kind: "movie",
          overview: null,
          posterPath: `/v1/media/media_${"c".repeat(22)}/images/poster`,
          referenceId: `media_${"c".repeat(22)}`,
          title: "Parallel Lines",
          year: 2024,
        },
        {
          identityState: "unmatched",
          issues: ["missing_identity", "missing_poster"],
          kind: "movie",
          overview:
            "An archivist discovers that a forgotten harbour exists one minute out of phase.",
          posterPath: null,
          referenceId: `media_${"d".repeat(22)}`,
          title: "Glass Harbour",
          year: 2025,
        },
      ],
      nextCursor: null,
      scanned: 12,
      truncated: false,
    },
    csrfToken: "test_library_csrf_0123456789abcdefghijklmnop",
    principal: libraryDemoPrincipal,
  },
  status: "ready",
};

export const emptyLibraryOutcome: Extract<LibraryLoadOutcome, { status: "ready" }> = {
  snapshot: {
    ...readyLibraryOutcome.snapshot,
    attention: {
      ...readyLibraryOutcome.snapshot.attention,
      items: [],
      scanned: 68,
    },
  },
  status: "ready",
};
