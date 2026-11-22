/**
 * The portal's public address: PORTAL_URL if set (a custom domain), else the address Render gives every
 * web service (RENDER_EXTERNAL_URL), else local development. Used for sign-in and invite links.
 */
export function portalUrl(): string {
  return (process.env.PORTAL_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3100").replace(/\/+$/, "");
}

/** Cookies are marked Secure whenever the portal is served over https */
export const secureCookies = () => portalUrl().startsWith("https://");
