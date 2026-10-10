import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Externalize pino to avoid bundling issues with worker threads
  // This prevents Next.js from trying to bundle pino's test files
  serverExternalPackages: ["pino", "pino-pretty"],

  // PostHog calls /ingest/... with meaningful trailing slashes; Next's
  // trailing-slash normalisation would 308 them and break capture.
  skipTrailingSlashRedirect: true,

  /**
   * First-party reverse proxy for PostHog (EU cloud). Analytics requests go
   * to app.stackradar.io/ingest instead of eu.i.posthog.com directly, so
   * they are not swallowed by ad-blockers that list the PostHog domains.
   * `/ingest` is also in `publicRoutes` in `proxy.ts` — the auth gate would
   * otherwise redirect capture calls to /login.
   */
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },

  /**
   * Security response headers. The ingress only sets HSTS; these are the
   * app-level complement. `frame-ancestors 'none'` + `X-Frame-Options: DENY`
   * keep the signed-in app (API-key reveal, danger-zone deletes) unframeable.
   * The `/invite/:token` routes additionally send `Referrer-Policy:
   * no-referrer` because the invite token is a bearer credential in the URL
   * and must not leak to GitHub/Google via the Referer header during OAuth.
   */
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      {
        source: "/invite/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },

  /**
   * The legal pages live once, on the marketing site. These redirects exist so
   * that `app.stackradar.io/terms` — typed, bookmarked, or linked from an old
   * email — lands somewhere real instead of bouncing through the sign-in gate.
   *
   * `permanent: false` (307) on purpose: a 308 is cached by browsers
   * indefinitely, which would make it painful to ever serve these paths from
   * the app itself. `/terms` and `/privacy` are also in `publicRoutes` in
   * `proxy.ts` — config redirects run before the proxy, so that is belt and
   * braces, but the belt is one line and the failure it prevents is a legal
   * page that demands a login.
   */
  async redirects() {
    return [
      { source: "/terms", destination: "https://stackradar.io/terms", permanent: false },
      { source: "/privacy", destination: "https://stackradar.io/privacy", permanent: false },
      /* The cluster's running-container pages lived under `/workloads` until
         2026-09-13. Bookmarks, the post-install redirect in older tabs and
         links pasted before the rename keep working. 308 is fine here: the
         old path is not coming back. */
      { source: "/clusters/:id/workloads", destination: "/clusters/:id/containers", permanent: true },
      { source: "/clusters/:id/workloads/:containerId", destination: "/clusters/:id/containers/:containerId", permanent: true },
    ];
  },
};

export default nextConfig;
