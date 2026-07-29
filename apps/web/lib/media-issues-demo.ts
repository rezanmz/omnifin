import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { MediaIssueWorkbenchItem } from "@omnifin/contracts/issues";

import type { MediaIssueLoadOutcome } from "./media-issues";

export const mediaIssueGeneratedAt = "2026-07-28T20:12:00.000Z";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-28T20:12:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Stack operator",
  externalIdentity: {
    displayClaims: { displayName: "Stack operator" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "operator-subject",
  },
  inactivityExpiresAt: "2026-07-28T21:12:00.000Z",
  issuedAt: mediaIssueGeneratedAt,
  linkedServices: [
    {
      displayName: "Stack operator",
      externalUserId: "operator-external",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: mediaIssueGeneratedAt,
      linkedAt: mediaIssueGeneratedAt,
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

export const demoMediaIssues: MediaIssueWorkbenchItem[] = [
  {
    category: "subtitles",
    createdAt: "2026-07-28T19:24:00.000Z",
    episodeNumber: 3,
    id: `issue_${"a".repeat(22)}`,
    kind: "episode",
    positionSeconds: null,
    reportedBy: "Mara Chen",
    seasonNumber: 2,
    source: "seerr",
    status: "open",
    summary: "Captions drift after the opening scene.",
    title: "Northern Lights",
    updatedAt: "2026-07-28T19:31:00.000Z",
    year: 2026,
  },
  {
    category: "buffering",
    createdAt: "2026-07-28T18:42:00.000Z",
    episodeNumber: null,
    id: `issue_${"b".repeat(22)}`,
    kind: "movie",
    positionSeconds: 615,
    reportedBy: "Jon Bell",
    seasonNumber: null,
    source: "omnifin",
    status: "open",
    summary: "Playback stops after the second scene.",
    title: "The Long Meridian",
    updatedAt: "2026-07-28T18:42:00.000Z",
    year: 2026,
  },
  {
    category: "audio",
    createdAt: "2026-07-28T17:56:00.000Z",
    episodeNumber: null,
    id: `issue_${"c".repeat(22)}`,
    kind: "movie",
    positionSeconds: null,
    reportedBy: "Nina Rao",
    seasonNumber: null,
    source: "seerr",
    status: "open",
    summary: "The English 5.1 track is silent on direct play.",
    title: "Ember Coast",
    updatedAt: "2026-07-28T18:03:00.000Z",
    year: 2025,
  },
  {
    category: "video_quality",
    createdAt: "2026-07-28T15:17:00.000Z",
    episodeNumber: 7,
    id: `issue_${"d".repeat(22)}`,
    kind: "episode",
    positionSeconds: 1_284,
    reportedBy: "Drew Palmer",
    seasonNumber: 1,
    source: "omnifin",
    status: "resolved",
    summary: "Image becomes blocky during the final sequence.",
    title: "Signal / Noise",
    updatedAt: "2026-07-28T16:02:00.000Z",
    year: 2026,
  },
];

export const readyMediaIssueOutcome: MediaIssueLoadOutcome = {
  snapshot: {
    csrfToken: "test_media_issue_csrf_0123456789abcdefghijklmnopqr",
    page: {
      generatedAt: mediaIssueGeneratedAt,
      items: demoMediaIssues,
      limit: 50,
      source: "all",
      sourceStates: { omnifin: "available", seerr: "available" },
      status: "all",
      truncated: false,
    },
    principal,
  },
  status: "ready",
};

export const emptyMediaIssueOutcome: MediaIssueLoadOutcome = {
  snapshot: {
    ...readyMediaIssueOutcome.snapshot,
    page: {
      ...readyMediaIssueOutcome.snapshot.page,
      items: [],
      status: "open",
    },
  },
  status: "ready",
};

export const degradedMediaIssueOutcome: MediaIssueLoadOutcome = {
  snapshot: {
    ...readyMediaIssueOutcome.snapshot,
    page: {
      ...readyMediaIssueOutcome.snapshot.page,
      items: demoMediaIssues.filter((issue) => issue.source === "omnifin"),
      sourceStates: { omnifin: "available", seerr: "unavailable" },
    },
  },
  status: "ready",
};
