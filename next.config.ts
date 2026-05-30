import path from "node:path";

import type { NextConfig } from "next";

import createNextIntlPlugin from "next-intl/plugin";

import { ensureBuildVersionFiles } from "./scripts/build-version";

const IS_MOCK = process.env.PETDEX_MOCK === "1";
const IS_MOCK_AUTH = IS_MOCK || process.env.PETDEX_MOCK_AUTH === "1";

const DEFAULT_R2_PUBLIC_HOST = "pub-94495283df974cfea5e98d6a9e3fa462.r2.dev";
ensureBuildVersionFiles();

function r2PublicHost(): string {
  if (!process.env.R2_PUBLIC_BASE) return DEFAULT_R2_PUBLIC_HOST;
  try {
    return new URL(process.env.R2_PUBLIC_BASE).hostname;
  } catch {
    return DEFAULT_R2_PUBLIC_HOST;
  }
}

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
// - R2 public bucket + UploadThing host + Clerk image hosts + social
//   avatar hosts for sprites and avatars
const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Clerk renders the sign-up CAPTCHA inside an iframe served from
  // challenges.cloudflare.com (Turnstile). Without it on frame-src and
  // its bootstrap script on script-src, the CAPTCHA fails to load and
  // the user can't create an account.
  "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com https://*.clerk.accounts.dev https://accounts.petdex.crafter.run https://clerk.petdex.crafter.run",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.petdex.crafter.run https://accounts.petdex.crafter.run https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https://va.vercel-scripts.com https://vercel.live",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev https://yu2vz9gndp.ufs.sh https://img.clerk.com https://images.clerk.dev https://avatars.githubusercontent.com https://pbs.twimg.com https://storage.googleapis.com",
  "media-src 'self' https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
  "font-src 'self' data:",
  // R2 reads via pub-*.r2.dev, R2 PUT uploads via the account-specific
  // S3 endpoint (*.r2.cloudflarestorage.com). Both must be on the
  // connect-src allowlist or browser fetch / XHR fail with a generic
  // network error (root cause of issues #22-#80+).
  "connect-src 'self' https://clerk.petdex.crafter.run https://accounts.petdex.crafter.run https://*.clerk.com https://*.clerk.accounts.dev https://api.clerk.com https://api.github.com https://challenges.cloudflare.com https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev https://*.r2.cloudflarestorage.com https://yu2vz9gndp.ufs.sh https://utfs.io https://va.vercel-scripts.com https://vitals.vercel-insights.com",
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

const mockRoot = path.resolve(__dirname, "src/lib/mock");

const nextConfig: NextConfig = {
  // Hide the framework banner on every response.
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: DEFAULT_R2_PUBLIC_HOST },
      { protocol: "https", hostname: r2PublicHost() },
      { protocol: "https", hostname: "yu2vz9gndp.ufs.sh" },
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "pbs.twimg.com" },
      { protocol: "https", hostname: "storage.googleapis.com" },
    ],
  },
  // Server-only modules that don't survive Turbopack/webpack bundling:
  // - @electric-sql/pglite (mock mode) — native wasm + workers
  // - ali-oss — uses urllib's dynamic require('proxy-agent') for an
  //   optional dependency that the bundler can't resolve and treats
  //   as fatal. Marking ali-oss external lets the server runtime do
  //   the require() lazily, where the missing optional is harmless.
  serverExternalPackages: [
    "ali-oss",
    ...(IS_MOCK ? ["@electric-sql/pglite"] : []),
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  // In mock auth mode, redirect every Clerk import to in-process mocks
  // so contributors can boot without a Clerk backend secret. We set both
  // webpack and turbopack aliases since `next dev` defaults to turbopack
  // on recent versions.
  ...(IS_MOCK_AUTH
    ? {
        turbopack: {
          // Turbopack expects relative paths (with leading "./") rooted at
          // the project. Absolute paths get re-resolved as file paths
          // under cwd and 404. See nextjs/issues/turbopack-aliases.
          resolveAlias: {
            "@clerk/nextjs/server": "./src/lib/mock/clerk-server.ts",
            "@clerk/nextjs": "./src/lib/mock/clerk-client.tsx",
          },
        },
        webpack: (config: { resolve?: { alias?: Record<string, string> } }) => {
          config.resolve = config.resolve ?? {};
          config.resolve.alias = {
            ...(config.resolve.alias ?? {}),
            "@clerk/nextjs/server$": path.join(mockRoot, "clerk-server.ts"),
            "@clerk/nextjs$": path.join(mockRoot, "clerk-client.tsx"),
          };
          return config;
        },
      }
    : {}),
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
