import type {
  ManualReleaseCandidate,
  ManualReleaseSearchResponse,
} from "@omnifin/contracts/acquisition";
import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";

export const manualReleaseOperator: SessionPrincipal = {
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
      displayName: "Ari Jellyfin",
      externalUserId: "jellyfin-ari",
      health: "linked",
      id: "jellyfin-link-ari",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "ari",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "session-ari",
  userId: "user-ari",
};

export const approvedManualRelease: ManualReleaseCandidate = {
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
};

export const rejectedManualRelease: ManualReleaseCandidate = {
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
  rejectionReasons: ["Quality profile does not allow WEB-1080p", "Release is not a preferred word"],
  releaseGroup: "FROST",
  requiresOverride: true,
  seeders: 18,
  sizeBytes: 7_800_000_000,
  title: "The.Far.Meridian.2026.1080p.WEB-DL.DDP5.1.FROST",
};

export const manualReleaseSearch: ManualReleaseSearchResponse = {
  expiresAt: "2026-07-27T12:05:00.000Z",
  generatedAt: "2026-07-27T12:00:00.000Z",
  releases: [rejectedManualRelease, approvedManualRelease],
  target: {
    episodeId: null,
    kind: "movie",
    mediaId: 42,
    seasonNumber: null,
    service: "radarr",
  },
};
