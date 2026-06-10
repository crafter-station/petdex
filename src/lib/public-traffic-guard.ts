type HeaderBag =
  | Pick<Headers, "get">
  | Record<string, string | null | undefined>;

const BLOCKED_IPS = new Set(["133.106.50.116"]);
const BLOCKED_USER_AGENTS = ["petoverlaycompose-pixelartclassifier"];

export type PublicTrafficGuardRule =
  | "catalog"
  | "metadata"
  | "pack"
  | "state"
  | "sticker";

export function publicTrafficGuardRule(input: {
  method: string;
  pathname: string;
}): PublicTrafficGuardRule | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const pathname = input.pathname;
  if (/^\/api\/pets\/[^/]+\/(?:thumb|sticker)\/?$/.test(pathname)) {
    return "sticker";
  }
  if (/^\/api\/pets\/[^/]+\/wastickers\/?$/.test(pathname)) return "pack";
  if (pathname === "/api/manifest") return "catalog";
  if (pathname === "/api/pets/random") return "catalog";
  if (pathname === "/api/pets/search") return "catalog";
  if (pathname === "/api/me/header-state") return "state";
  if (pathname === "/api/og") return "metadata";
  if (pathname === "/api/wechat-qr") return "metadata";
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:pets|collections|u)\/[^/]+\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:collections|download)\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (/^\/api\/pets\/[^/]+\/codex-theme\/?$/.test(pathname)) {
    return "catalog";
  }
  if (/^\/api\/pets\/[^/]+\/metrics\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/pets\/[^/]+\/variants\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/install-pet\/[^/]+\/?$/.test(pathname)) return "catalog";
  if (/^\/(?:en\/|es\/|zh\/)?install\/[^/]+\/?$/.test(pathname)) {
    return "catalog";
  }
  return null;
}

export function shouldBlockKnownAbusiveClient(
  headers: HeaderBag | undefined,
): boolean {
  const ip = publicTrafficGuardKey(headers);
  if (BLOCKED_IPS.has(ip)) return true;
  const userAgent = readHeader(headers, "user-agent").toLowerCase();
  return BLOCKED_USER_AGENTS.some((blocked) => userAgent.includes(blocked));
}

export function publicTrafficGuardKey(headers: HeaderBag | undefined): string {
  const ip =
    readHeader(headers, "x-real-ip") ||
    readHeader(headers, "x-forwarded-for").split(",")[0]?.trim() ||
    "anon";
  return ip;
}

function readHeader(headers: HeaderBag | undefined, name: string): string {
  if (!headers) return "";
  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    return (headers as Pick<Headers, "get">).get(name) ?? "";
  }
  const bag = headers as Record<string, string | null | undefined>;
  return bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()] ?? "";
}
