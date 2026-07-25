export type ServiceStatus = "healthy" | "attention" | "offline";
export type DisplayProfile = "standard" | "ten-foot";
export type MediaArtwork = "aperture" | "archive" | "bloom" | "contour" | "monolith" | "signal";

export interface MediaCardModel {
  accent: string;
  artwork?: MediaArtwork;
  eyebrow: string;
  id: string;
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
  rate: string;
  service: string;
  title: string;
}

export interface DashboardModel {
  calendar: CalendarItemModel[];
  continueWatching: MediaCardModel[];
  discovery: MediaCardModel[];
  hero: {
    accent: string;
    description: string;
    eyebrow: string;
    facts: string[];
    title: string;
  };
  operations: OperationModel[];
  services: { label: string; status: ServiceStatus }[];
}

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
      rate: "42.8 MB/s",
      service: "Radarr · qBittorrent",
      title: "The Far Meridian",
    },
    {
      eta: "4m",
      id: "op-2",
      progress: 0.91,
      rate: "18.2 MB/s",
      service: "Sonarr · SABnzbd",
      title: "Signal · S01E07",
    },
  ],
  services: [
    { label: "Jellyfin", status: "healthy" },
    { label: "Seerr", status: "healthy" },
    { label: "Acquisition", status: "attention" },
  ],
};
