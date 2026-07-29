import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { SystemStatusResponse } from "@omnifin/contracts/system";

export const demoSystemStatusGeneratedAt = "2026-07-28T23:50:00.000Z";

export const demoSystemStatusPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-27T23:50:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Stack operator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-29T00:50:00.000Z",
  issuedAt: demoSystemStatusGeneratedAt,
  linkedServices: [
    {
      displayName: "Stack operator",
      externalUserId: "operator-external",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: demoSystemStatusGeneratedAt,
      linkedAt: demoSystemStatusGeneratedAt,
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
};

export const demoSystemStatus: SystemStatusResponse = {
  generatedAt: demoSystemStatusGeneratedAt,
  sources: [
    {
      displayName: "Cinema",
      failure: null,
      id: "source_1234567890123456789012",
      service: "radarr",
      signals: [
        {
          id: "signal_1234567890123456789012",
          message: "One configured root folder is waiting to reconnect.",
          severity: "warning",
          sourceLabel: "Root folder",
        },
      ],
      status: "attention",
      storage: [
        {
          freeBytes: 84_000_000_000,
          id: "storage_1234567890123456789012",
          label: "Cinema storage 1",
          state: "warning",
          totalBytes: 800_000_000_000,
        },
      ],
    },
    {
      displayName: "Television",
      failure: null,
      id: "source_abcdefghijklmnopqrstuv",
      service: "sonarr",
      signals: [],
      status: "healthy",
      storage: [
        {
          freeBytes: 680_000_000_000,
          id: "storage_abcdefghijklmnopqrstuv",
          label: "Television storage 1",
          state: "healthy",
          totalBytes: 1_200_000_000_000,
        },
      ],
    },
    {
      displayName: "Indexers",
      failure: null,
      id: "source_ZYXWVUTSRQPONMLKJIHGFE",
      service: "prowlarr",
      signals: [],
      status: "healthy",
      storage: [],
    },
  ],
  state: "complete",
  summary: {
    attentionSources: 1,
    criticalStorage: 0,
    errorSignals: 0,
    healthySources: 2,
    noticeSignals: 0,
    sources: 3,
    unavailableSources: 0,
    warningSignals: 1,
    warningStorage: 1,
  },
};
