import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#060807",
    description: "A cinematic, secure control plane for the self-hosted media stack.",
    display: "standalone",
    name: "Omnifin",
    short_name: "Omnifin",
    start_url: "/",
    theme_color: "#060807",
  };
}
