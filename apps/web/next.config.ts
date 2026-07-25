import type { NextConfig } from "next";

const gatewayUrl = process.env.OMNIFIN_GATEWAY_URL ?? "http://127.0.0.1:4000";
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
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${gatewayUrl}/v1/:path*` }];
  },
};

export default nextConfig;
