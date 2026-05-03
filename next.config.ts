import type { NextConfig } from "next";

// Content-Security-Policy. Blocks inline <script> sources we didn't ship,
// caps img / connect / frame ancestors. The `unsafe-inline` allowance for
// styles is required by Next/Tailwind during hydration; for scripts we
// keep 'unsafe-inline' as well because Next embeds RSC payloads inline,
// but with our same-origin CSRF guard + JSON-LD escape this is acceptable.
//
// Hosts allowed:
// - self for everything we render
// - clerk.petdex.crafter.run + *.clerk.com / *.clerk.accounts.dev for
//   the Clerk client SDK
// - vercel-scripts / vitals for Vercel analytics
// - R2 public bucket + R2 write endpoint + UploadThing host + Clerk image
//   hosts + social avatar hosts for sprites, avatars, and direct uploads
const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.petdex.crafter.run https://*.clerk.com https://*.clerk.accounts.dev https://va.vercel-scripts.com https://vercel.live",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev https://yu2vz9gndp.ufs.sh https://img.clerk.com https://images.clerk.dev https://avatars.githubusercontent.com https://pbs.twimg.com https://storage.googleapis.com",
  "media-src 'self' https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
  "font-src 'self' data:",
  "connect-src 'self' https://clerk.petdex.crafter.run https://*.clerk.com https://*.clerk.accounts.dev https://api.clerk.com https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev https://*.r2.cloudflarestorage.com https://yu2vz9gndp.ufs.sh https://utfs.io https://va.vercel-scripts.com https://vitals.vercel-insights.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  // 2 years HSTS + subdomains. preload-ready when we want to submit to
  // hstspreload.org.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  // Block clickjacking. Modern frame-ancestors lives in CSP but we keep
  // the legacy header for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  // Stop MIME sniffing — a pet.json that's secretly HTML won't be
  // executed as HTML by the browser.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Conservative referrer to avoid leaking pet detail URLs to ad nets.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Lock down powerful APIs. We don't use any of these.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  },
  // CSP — see directives above.
  { key: "Content-Security-Policy", value: cspDirectives },
  // Cross-origin protections.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Hide the framework banner on every response.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
