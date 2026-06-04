export type RouteCostKind = "api" | "asset-api" | "metadata" | "page";

export type RouteCostSample = {
  method: string;
  route: string;
  routeKind: RouteCostKind;
  sampleWeight: number;
  at: string;
};

const LOCALE_SET = new Set(["en", "es", "zh"]);
const DYNAMIC_ROUTE_PATTERNS = [
  ["admin", "feedback", "[id]"],
  ["advertise", "dashboard", "[campaignId]", "edit"],
  ["collections", "[slug]"],
  ["collections", "[slug]", "opengraph-image"],
  ["install", "[slug]"],
  ["kind", "[kind]"],
  ["my-feedback", "[id]"],
  ["pets", "[slug]"],
  ["pets", "[slug]", "opengraph-image"],
  ["u", "[handle]"],
  ["u", "[handle]", "opengraph-image"],
  ["vibe", "[vibe]"],
  ["api", "admin", "[id]"],
  ["api", "admin", "[id]", "feature"],
  ["api", "admin", "collection-requests", "[id]"],
  ["api", "admin", "edits", "[id]"],
  ["api", "admin", "feedback", "[id]"],
  ["api", "admin", "requests", "[id]"],
  ["api", "ads", "[id]"],
  ["api", "collections", "[slug]", "request"],
  ["api", "feedback", "[id]"],
  ["api", "feedback", "[id]", "replies"],
  ["api", "install-pet", "[slug]"],
  ["api", "internal", "submissions", "[id]", "review"],
  ["api", "my-pets", "[id]", "edit"],
  ["api", "my-pets", "[id]", "edit-presign"],
  ["api", "my-pets", "[id]", "withdraw"],
  ["api", "pet-requests", "[id]", "candidates"],
  ["api", "pets", "[slug]", "can-delete"],
  ["api", "pets", "[slug]", "codex-theme"],
  ["api", "pets", "[slug]", "like"],
  ["api", "pets", "[slug]", "metrics"],
  ["api", "pets", "[slug]", "owner"],
  ["api", "pets", "[slug]", "owner-state"],
  ["api", "pets", "[slug]", "sticker"],
  ["api", "pets", "[slug]", "thumb"],
  ["api", "pets", "[slug]", "track-zip"],
  ["api", "pets", "[slug]", "variants"],
  ["api", "pets", "[slug]", "wastickers"],
  ["api", "profile", "collections", "[id]"],
];
const STATIC_ROUTE_SET = new Set([
  "-/collections/-/opengraph-image",
  "-/collections/opengraph-image",
  "-/download/opengraph-image",
  "-/pets/-/opengraph-image",
  "-/u/-/opengraph-image",
  "about",
  "admin",
  "admin/campaigns",
  "admin/collection-requests",
  "admin/edits",
  "admin/feedback",
  "admin/insights",
  "admin/mailing",
  "admin/mailing/new",
  "admin/mailing/subscribers",
  "admin/manifest",
  "admin/requests",
  "admin/telemetry",
  "advertise",
  "advertise/dashboard",
  "advertise/new",
  "api/admin/request-candidates",
  "api/admin/telemetry/summary",
  "api/ads",
  "collections/opengraph-image",
  "api/ads/checkout",
  "api/ads/event",
  "api/ads/image/presign",
  "api/ads/impression",
  "api/cli/auth-config",
  "api/cli/edit-presign",
  "api/cli/submit",
  "api/cli/submit/check",
  "api/cli/submit/register",
  "api/desktop/latest-release",
  "api/feedback",
  "api/feedback/unread",
  "api/internal/route-cost",
  "api/manifest",
  "api/manifest/full",
  "api/me/caught-slugs",
  "api/me/header-state",
  "api/my-pets/approved",
  "api/my-pets/claim",
  "api/notifications",
  "api/notifications/read",
  "api/og",
  "api/pet-requests",
  "api/pet-requests/image",
  "api/pets/random",
  "api/pets/search",
  "api/profile",
  "api/profile/collection",
  "api/profile/collections",
  "api/profile/gallery-order",
  "api/profile/me",
  "api/r2/presign",
  "api/stripe/webhook",
  "api/submit",
  "api/telemetry/event",
  "api/uploadthing",
  "api/webhooks/resend",
  "api/wechat-qr",
  "brand",
  "built-with",
  "collaborator",
  "collaborator/collection-requests",
  "collaborator/edits",
  "collaborator/moderation",
  "collaborator/requests",
  "collaborator/wechat-qr",
  "collections",
  "community",
  "create",
  "docs",
  "download",
  "download/opengraph-image",
  "favicon.ico",
  "leaderboard",
  "legal/takedown",
  "legal/telemetry",
  "my-feedback",
  "requests",
  "robots.txt",
  "sitemap.xml",
  "submit",
  "unsubscribe",
]);
const ASSET_API_SEGMENTS = new Set([
  "codex-theme",
  "latest-release",
  "og",
  "sticker",
  "thumb",
  "variants",
  "wastickers",
  "wechat-qr",
]);

export function routeCostSampleRate(): number {
  const configured = process.env.PETDEX_ROUTE_COST_SAMPLE_RATE?.trim();
  if (!configured) return 0;
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.max(raw, 0.000001), 0.05);
}

export function routeCostSecret(): string | null {
  return firstNonEmpty(process.env.PETDEX_ROUTE_COST_SECRET);
}

export function shouldSampleRouteCost(rate = routeCostSampleRate()): boolean {
  return rate > 0 && Math.random() < rate;
}

export function buildRouteCostSample(input: {
  method: string;
  pathname: string;
  sampleRate?: number;
}): RouteCostSample | null {
  if (input.pathname === "/api/internal/route-cost") return null;
  const sampleRate = input.sampleRate ?? routeCostSampleRate();
  if (sampleRate <= 0) return null;
  const route = normalizeRouteCostPath(input.pathname);
  return {
    method: normalizeMethod(input.method),
    route,
    routeKind: routeCostKind(route),
    sampleWeight: Math.max(1, Math.round(1 / sampleRate)),
    at: new Date().toISOString(),
  };
}

export function normalizeRouteCostPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const routeParts = LOCALE_SET.has(parts[0] ?? "") ? parts.slice(1) : parts;
  if (routeParts.length === 0) return "/";
  if (STATIC_ROUTE_SET.has(routeParts.join("/"))) {
    return `/${routeParts.join("/")}`;
  }
  const pattern = matchDynamicRoutePattern(routeParts);
  if (pattern) return `/${pattern.join("/")}`;
  return routeParts[0] === "api" ? "/api/[unmatched]" : "/[unmatched]";
}

export function routeCostKind(route: string): RouteCostKind {
  if (route.includes("opengraph-image")) return "metadata";
  if (route.startsWith("/api/")) {
    return [...ASSET_API_SEGMENTS].some((segment) =>
      route.includes(`/${segment}`),
    )
      ? "asset-api"
      : "api";
  }
  return "page";
}

export async function signRouteCostPayload(
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper.length <= 12 ? upper : "OTHER";
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function matchDynamicRoutePattern(parts: string[]): string[] | null {
  for (const pattern of DYNAMIC_ROUTE_PATTERNS) {
    if (pattern.length !== parts.length) continue;
    const matches = pattern.every((part, index) => {
      return isDynamicPart(part) || part === parts[index];
    });
    if (matches) return pattern;
  }
  return null;
}

function isDynamicPart(part: string): boolean {
  return part.startsWith("[") && part.endsWith("]");
}
