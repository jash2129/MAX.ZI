/**
 * The portal's public address: PORTAL_URL if set (a custom domain), else the address the host gives it
 * (Render: RENDER_EXTERNAL_URL; Vercel: the project's production domain), else local development. Used
 * for sign-in and invite links.
 */
export function portalUrl(): string {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "";
  return (process.env.PORTAL_URL || process.env.RENDER_EXTERNAL_URL || vercel || "http://localhost:3100").replace(/\/+$/, "");
}

/** Cookies are marked Secure whenever the portal is served over https */
export const secureCookies = () => portalUrl().startsWith("https://");
