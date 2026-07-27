import type { ManagedConnectorService } from "@omnifin/contracts/connectors";
import {
  Captions,
  Database,
  Download,
  Film,
  HardDriveDownload,
  Radar,
  Search,
  Tv,
  type LucideIcon,
} from "lucide-react";

export const connectorServices = [
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
] as const satisfies readonly ManagedConnectorService[];

export interface ServicePresentation {
  description: string;
  icon: LucideIcon;
  label: string;
}

export const connectorServicePresentation: Record<ManagedConnectorService, ServicePresentation> = {
  bazarr: { description: "Subtitle intelligence", icon: Captions, label: "Bazarr" },
  jellyfin: { description: "Media identity & playback", icon: Tv, label: "Jellyfin" },
  prowlarr: { description: "Indexer intelligence", icon: Radar, label: "Prowlarr" },
  qbittorrent: { description: "Torrent acquisition", icon: Download, label: "qBittorrent" },
  radarr: { description: "Film acquisition", icon: Film, label: "Radarr" },
  sabnzbd: { description: "Usenet acquisition", icon: HardDriveDownload, label: "SABnzbd" },
  seerr: { description: "Requests & discovery", icon: Search, label: "Seerr" },
  sonarr: { description: "Series acquisition", icon: Database, label: "Sonarr" },
};
