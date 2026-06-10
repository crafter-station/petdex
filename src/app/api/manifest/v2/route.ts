import { NextResponse } from "next/server";

import { R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export const runtime = "nodejs";
export const revalidate = 300;

const BROWSER_CACHE_CONTROL = "public, max-age=300";
const CDN_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=3600";
const COMPACT_MANIFEST_URL =
  process.env.PETDEX_MANIFEST_V2_URL ??
  `${R2_PUBLIC_BASE}/manifests/petdex-v2.json`;

export async function GET(): Promise<Response> {
  const res = NextResponse.redirect(COMPACT_MANIFEST_URL, 307);
  res.headers.set("Cache-Control", BROWSER_CACHE_CONTROL);
  res.headers.set("CDN-Cache-Control", CDN_CACHE_CONTROL);
  res.headers.set("Vercel-CDN-Cache-Control", CDN_CACHE_CONTROL);
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
