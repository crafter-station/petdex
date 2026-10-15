// Fire-and-forget telemetry for /api/manifest fetches. Writes one row
// per request with hashed IP, UA, and Vercel geo headers. Designed to
// fail silently — the manifest response should never block on a log
// write.

import { normalizeCountry, normalizeRegion } from "@/lib/country-code";
import { db, schema } from "@/lib/db/client";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";

function newId(): string {
  return `mfetch_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

function dailySalt(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function hashIp(ip: string): Promise<string> {
  const enc = new TextEncoder().encode(`${dailySalt()}::${ip}`);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32); // half the digest is plenty for grouping
}

export async function logManifestFetch(
  req: Request,
  variant: "slim" | "full",
): Promise<void> {
  try {
    const h = req.headers;
    // Same key helper as the rate limiters: prefers the platform-set
    // `x-real-ip`, falls through to `x-forwarded-for`, then a constant.
    const ip = publicTrafficGuardKey(h);
    const ipHash = await hashIp(ip);
    const userAgent = h.get("user-agent")?.slice(0, 200) ?? null;
    // Vercel sets this header, but a self-hosted/proxied deployment can carry
    // anything, and `normalizeCountry`'s own doc requires every endpoint that
    // stores a country to run it. The telemetry endpoint does; this one stored
    // the raw string, so the same dimension landed in two tables in two
    // formats (case, whitespace, non-ISO values) and split the geo rollups.
    const country = normalizeCountry(h.get("x-vercel-ip-country"));
    // The same reasoning as `country`, applied to the region dimension. Vercel
    // sets a short code ("CA", "ENG", "13"), but a proxied deployment can carry
    // anything and this lands in an unbounded `text` column. Unlike country
    // there is no ISO list to check against, so bound the shape instead:
    // a short run of letters/digits/dash, anything else stored as unknown.
    const region = normalizeRegion(h.get("x-vercel-ip-country-region"));
    const referer = h.get("referer")?.slice(0, 200) ?? null;

    await db.insert(schema.manifestFetches).values({
      id: newId(),
      ipHash,
      userAgent,
      country,
      region,
      referer,
      variant,
    });
  } catch {
    /* swallow — telemetry must not break the response */
  }
}
