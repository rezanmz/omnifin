export type ServiceStatus = "healthy" | "attention" | "offline";
export type DisplayProfile = "standard" | "ten-foot";
export type MediaArtwork = "aperture" | "archive" | "bloom" | "contour" | "monolith" | "signal";

export interface MediaCardModel {
  accent: string;
  artwork?: MediaArtwork;
  artworkPath?: string;
  eyebrow: string;
  id: string;
  positionSeconds?: number;
  progress?: number;
  title: string;
}

export interface CalendarItemModel {
  accent: string;
  day: string;
  id: string;
  service: "Movie" | "Series";
  title: string;
}

export interface OperationModel {
  eta: string;
  id: string;
  progress: number;
  provenance?: AcquisitionProvenanceResponse;
  rate: string;
  service: string;
  target: AcquisitionTargetInput;
  title: string;
}

export interface DashboardModel {
  calendar: CalendarItemModel[];
  continueWatching: MediaCardModel[];
  discovery: MediaCardModel[];
  hero: {
    actions?: "media" | "none";
    accent: string;
    description: string;
    eyebrow: string;
    facts: string[];
    title: string;
  };
  operations: OperationModel[];
  services: { label: string; status: ServiceStatus }[];
}

export const connectedDashboard: DashboardModel = {
  calendar: [],
  continueWatching: [],
  discovery: [],
  hero: {
    accent: "#8de9d5",
    actions: "none",
    description:
      "Your private Jellyfin watch state is ready here. Pick up a title on any screen and Omnifin will keep this view in step without exposing your media token to the browser.",
    eyebrow: "Your library, in focus",
    facts: ["Jellyfin linked", "Private by design", "No telemetry"],
    title: "Ready when you are",
  },
  operations: [],
  services: [{ label: "Jellyfin", status: "attention" }],
};

export const demoDashboard: DashboardModel = {
  calendar: [
    { accent: "#f6a66b", day: "MON 27", id: "cal-1", service: "Series", title: "Signal / 1×07" },
    { accent: "#78c7ff", day: "TUE 28", id: "cal-2", service: "Movie", title: "The Long Meridian" },
    {
      accent: "#d8ff70",
      day: "THU 30",
      id: "cal-3",
      service: "Series",
      title: "Northern Lights / 2×03",
    },
    { accent: "#c5a6ff", day: "FRI 31", id: "cal-4", service: "Movie", title: "Aperture" },
  ],
  continueWatching: [
    {
      accent: "#ce7759",
      artwork: "contour",
      eyebrow: "38 min left",
      id: "cw-1",
      progress: 0.64,
      title: "Ember Coast",
    },
    {
      accent: "#6ba19f",
      artwork: "archive",
      eyebrow: "S2 E4",
      id: "cw-2",
      progress: 0.31,
      title: "The Quiet Archive",
    },
    {
      accent: "#7e6a91",
      artwork: "aperture",
      eyebrow: "52 min left",
      id: "cw-3",
      progress: 0.78,
      title: "Glass Horizon",
    },
    {
      accent: "#a49a72",
      artwork: "monolith",
      eyebrow: "S1 E6",
      id: "cw-4",
      progress: 0.18,
      title: "Field Notes",
    },
  ],
  discovery: [
    { accent: "#b47b5b", artwork: "monolith", eyebrow: "Trending", id: "d-1", title: "Low Orbit" },
    {
      accent: "#4c7672",
      artwork: "signal",
      eyebrow: "94% match",
      id: "d-2",
      title: "The Last Frequency",
    },
    {
      accent: "#576a91",
      artwork: "aperture",
      eyebrow: "New this week",
      id: "d-3",
      title: "Afterimage",
    },
    {
      accent: "#875d67",
      artwork: "contour",
      eyebrow: "Because you watched Signal",
      id: "d-4",
      title: "Red Valley",
    },
    {
      accent: "#665b79",
      artwork: "bloom",
      eyebrow: "Critically acclaimed",
      id: "d-5",
      title: "Static Bloom",
    },
  ],
  hero: {
    accent: "#d8ff70",
    description:
      "A deep-space survey hears a pattern no instrument was designed to find—and every answer changes the shape of home.",
    eyebrow: "Tonight’s signal",
    facts: ["2026", "2h 08m", "4K Dolby Vision", "PG-13"],
    title: "The Far Meridian",
  },
  operations: [
    {
      eta: "12m",
      id: "op-1",
      progress: 0.72,
      provenance: {
        events: [
          {
            episodeNumbers: [],
            id: "radarr:queue:422",
            kind: "downloading",
            occurredAt: "2026-07-27T18:58:00.000Z",
            release: {
              downloadClient: "qBittorrent",
              indexer: "Northstar",
              protocol: "torrent",
              quality: "WEBDL-2160p",
              sizeBytes: 18_420_000_000,
              title: "The.Far.Meridian.2026.2160p.WEB-DL",
            },
            seasonNumber: null,
            state: "active",
            summary: "Download is moving through the configured client.",
          },
          {
            episodeNumbers: [],
            id: "radarr:history:421",
            kind: "grabbed",
            occurredAt: "2026-07-27T18:51:00.000Z",
            release: {
              downloadClient: "qBittorrent",
              indexer: "Northstar",
              protocol: "torrent",
              quality: "WEBDL-2160p",
              sizeBytes: null,
              title: "The.Far.Meridian.2026.2160p.WEB-DL",
            },
            seasonNumber: null,
            state: "success",
            summary: "Release was sent to the download client.",
          },
          {
            episodeNumbers: [],
            id: "radarr:history:417",
            kind: "download_failed",
            occurredAt: "2026-07-27T18:39:00.000Z",
            release: {
              downloadClient: "qBittorrent",
              indexer: "Orbit Index",
              protocol: "torrent",
              quality: "Bluray-2160p",
              sizeBytes: null,
              title: "The.Far.Meridian.2026.REMUX.2160p",
            },
            seasonNumber: null,
            state: "failure",
            summary: "The download failed before it could be imported.",
          },
          {
            episodeNumbers: [],
            id: "radarr:history:402",
            kind: "upgraded",
            occurredAt: "2026-07-24T02:12:00.000Z",
            release: {
              downloadClient: "SABnzbd",
              indexer: "Northstar",
              protocol: "usenet",
              quality: "WEBDL-1080p",
              sizeBytes: null,
              title: "The.Far.Meridian.2026.1080p.WEB-DL",
            },
            seasonNumber: null,
            state: "success",
            summary: "A higher-quality release replaced the previous file.",
          },
          {
            episodeNumbers: [],
            id: "radarr:history:398",
            kind: "imported",
            occurredAt: "2026-07-23T23:41:00.000Z",
            release: {
              downloadClient: "SABnzbd",
              indexer: "Northstar",
              protocol: "usenet",
              quality: "WEBDL-1080p",
              sizeBytes: null,
              title: "The.Far.Meridian.2026.1080p.WEB-DL",
            },
            seasonNumber: null,
            state: "success",
            summary: "Download was imported into the media library.",
          },
        ],
        failures: [],
        generatedAt: "2026-07-27T19:00:00.000Z",
        state: "complete",
        target: { kind: "movie", mediaId: 42, seasonNumber: null, service: "radarr" },
      },
      rate: "42.8 MB/s",
      service: "Radarr · qBittorrent",
      target: { mediaId: 42, service: "radarr" },
      title: "The Far Meridian",
    },
    {
      eta: "4m",
      id: "op-2",
      progress: 0.91,
      rate: "18.2 MB/s",
      service: "Sonarr · SABnzbd",
      target: { mediaId: 77, seasonNumber: 1, service: "sonarr" },
      title: "Signal · S01E07",
    },
  ],
  services: [
    { label: "Jellyfin", status: "healthy" },
    { label: "Seerr", status: "healthy" },
    { label: "Acquisition", status: "attention" },
  ],
};
import type {
  AcquisitionProvenanceResponse,
  AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";
