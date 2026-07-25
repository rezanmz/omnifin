export const probeFixtures = {
  jellyfin: {
    LocalAddress: "https://jellyfin.example.test",
    ServerName: "Media",
    Version: "10.11.2",
    ProductName: "Jellyfin Server",
    Id: "fixture-server",
  },
  seerr: {
    version: "3.1.0",
    commitTag: "fixture",
    updateAvailable: false,
    commitsBehind: 0,
    restartRequired: false,
  },
  radarr: {
    appName: "Radarr",
    instanceName: "Radarr",
    version: "6.0.4.10291",
  },
  sonarr: {
    appName: "Sonarr",
    instanceName: "Sonarr",
    version: "4.0.16.2944",
  },
  prowlarr: {
    appName: "Prowlarr",
    instanceName: "Prowlarr",
    version: "2.3.0.5236",
  },
  bazarr: {
    data: {
      bazarr_version: "1.5.6",
      package_version: "fixture",
      operating_system: "fixture",
    },
  },
  sabnzbd: {
    version: "5.0.3",
  },
} as const;
