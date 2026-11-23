import type { NextConfig } from "next";

const config: NextConfig = {
  // The portal runs the controller (release gate) and the control plane's db helpers from sibling folders
  experimental: { externalDir: true },
  serverExternalPackages: ["pg"],
  // The build checks the app only: tests use packages (PGlite, vitest) a host build doesn't install
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The release gate runs the scripted suite (release-gate.ts): free mode is the call app's default
  // now, so the portal pins the script unless its host sets MAX_MODE explicitly
  env: { MAX_MODE: process.env.MAX_MODE || "script" },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
