import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { RequestReviewItem } from "@omnifin/contracts/requests";

import type { RequestReviewLoadOutcome } from "./request-review";

export const requestReviewGeneratedAt = "2026-07-28T16:20:00.000Z";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-28T16:20:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Stack operator",
  externalIdentity: {
    displayClaims: { displayName: "Stack operator" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "operator-subject",
  },
  inactivityExpiresAt: "2026-07-28T17:20:00.000Z",
  issuedAt: requestReviewGeneratedAt,
  linkedServices: [
    {
      displayName: "Stack operator",
      externalUserId: "operator-external",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: requestReviewGeneratedAt,
      linkedAt: requestReviewGeneratedAt,
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

export const demoRequestReviews: RequestReviewItem[] = [
  {
    createdAt: "2026-07-28T15:54:00.000Z",
    id: "request:184",
    is4k: true,
    kind: "movie",
    qualityProfile: "4K Opt-in",
    requestedBy: "Mara Chen",
    seasons: null,
    source: "seerr",
    status: "pending",
    title: "A House of Dynamite",
    tmdbId: 1234821,
    updatedAt: "2026-07-28T15:54:00.000Z",
    year: 2025,
  },
  {
    createdAt: "2026-07-28T14:31:00.000Z",
    id: "request:183",
    is4k: false,
    kind: "series",
    qualityProfile: "Balanced",
    requestedBy: "Jon Bell",
    seasons: [1, 2],
    source: "seerr",
    status: "pending",
    title: "The Eternaut",
    tmdbId: 1242011,
    updatedAt: "2026-07-28T14:31:00.000Z",
    year: 2025,
  },
  {
    createdAt: "2026-07-28T12:18:00.000Z",
    id: "request:181",
    is4k: false,
    kind: "movie",
    qualityProfile: "1080p",
    requestedBy: "Drew Palmer",
    seasons: null,
    source: "seerr",
    status: "approved",
    title: "The Phoenician Scheme",
    tmdbId: 1137350,
    updatedAt: "2026-07-28T12:47:00.000Z",
    year: 2025,
  },
  {
    createdAt: "2026-07-28T10:04:00.000Z",
    id: "request:179",
    is4k: false,
    kind: "series",
    qualityProfile: "Web optimized",
    requestedBy: "Nina Rao",
    seasons: [3],
    source: "seerr",
    status: "declined",
    title: "Foundation",
    tmdbId: 93740,
    updatedAt: "2026-07-28T10:26:00.000Z",
    year: 2021,
  },
];

export const readyRequestReviewOutcome: RequestReviewLoadOutcome = {
  snapshot: {
    csrfToken: "test_request_review_csrf_0123456789abcdefghijklmnop",
    page: {
      generatedAt: requestReviewGeneratedAt,
      items: demoRequestReviews,
      nextCursor: null,
      status: "all",
    },
    principal,
  },
  status: "ready",
};

export const emptyRequestReviewOutcome: RequestReviewLoadOutcome = {
  snapshot: {
    ...readyRequestReviewOutcome.snapshot,
    page: {
      generatedAt: requestReviewGeneratedAt,
      items: [],
      nextCursor: null,
      status: "pending",
    },
  },
  status: "ready",
};
