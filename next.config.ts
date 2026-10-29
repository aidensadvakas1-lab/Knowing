import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Telegram bot runs ffmpeg to pull frames and audio out of shared videos.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: { "/api/telegram": ["./node_modules/ffmpeg-static/ffmpeg"] },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
