import type { NextConfig } from "next";

const buildStandalone = process.env.OMNIFIN_BUILD_STANDALONE === "true";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  compress: true,
  devIndicators: false,
  ...(buildStandalone ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  serverExternalPackages: [],
  experimental: {
    inlineCss: true,
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
