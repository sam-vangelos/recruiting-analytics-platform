import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // C3: self-contained server bundle for the Cloud Run container (.next/standalone
  // + server.js). Vercel ignores this setting, so the frozen deployment is unaffected.
  output: "standalone",
  // /ytd/agency moved to /agency/ytd (YTD is now a per-channel mode, not a standalone route).
  // permanent:false => 307, uncached, so bookmarks/links resolve while the IA settles.
  async redirects() {
    return [{ source: "/ytd/agency", destination: "/agency/ytd", permanent: false }];
  },
};

export default nextConfig;
