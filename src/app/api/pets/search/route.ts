import { NextResponse } from "next/server";

import { COLOR_FAMILIES, type ColorFamily } from "@/lib/color-families";
import { SEARCH_LIMITS, type SortKey, searchPets } from "@/lib/pet-search";
import { readShuffleSeed } from "@/lib/shuffle-seed";
import { PET_KINDS, PET_VIBES, type PetKind, type PetVibe } from "@/lib/types";

export const runtime = "nodejs";
// Search responses for non-curated sorts are deterministic per-query
// and can sit in the edge cache. Curated falls back to per-visitor
// (shuffle seed cookie) so it's tagged below as private. Letting Next
// decide dynamism (instead of force-dynamic) means the deterministic
// path can hit the edge cache via the s-maxage hint we set.

const KIND_SET = new Set<string>(PET_KINDS);
const VIBE_SET = new Set<string>(PET_VIBES);
const COLOR_SET = new Set<string>(COLOR_FAMILIES);
const BATCH_KEY_RE = /^\d{4}-\d{2}$/;
const SORT_SET = new Set<SortKey>([
  "curated",
  "popular",
  "installed",
  "alpha",
  "recent",
]);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;

  const q = params.get("q") ?? undefined;

  const kinds = parseList(params.get("kinds")).filter((k) =>
    KIND_SET.has(k),
  ) as PetKind[];
  const vibes = parseList(params.get("vibes")).filter((v) =>
    VIBE_SET.has(v),
  ) as PetVibe[];
  const colors = parseList(params.get("colors")).filter((family) =>
    COLOR_SET.has(family),
  ) as ColorFamily[];
  const batches = parseBatchList(params.get("batches"));

  const sortRaw = (params.get("sort") ?? "curated").toLowerCase();
  const sort: SortKey = SORT_SET.has(sortRaw as SortKey)
    ? (sortRaw as SortKey)
    : "curated";

  const cursor = parseIntSafe(params.get("cursor"), 0);
  const limit = parseIntSafe(params.get("limit"), SEARCH_LIMITS.DEFAULT_LIMIT);

  // Read-only — the SSR home page is responsible for minting the seed
  // on first hit. Pagination requests don't need to set the cookie
  // again, just re-use whatever was minted.
  const shuffleSeed = sort === "curated" ? await readShuffleSeed() : null;

  const result = await searchPets({
    q,
    kinds,
    vibes,
    colorFamilies: colors,
    batches,
    sort,
    cursor,
    limit,
    shuffleSeed: shuffleSeed ?? undefined,
  });

  // Curated results are per-visitor (shuffle seed cookie) so the edge
  // can't share them across users. Other sorts (popular, installed,
  // alpha, recent) are deterministic per (filters, cursor, limit), so
  // the edge serves them shared with a generous SWR window.
  const cacheHeader =
    sort === "curated"
      ? "private, no-store"
      : "public, max-age=60, s-maxage=120, stale-while-revalidate=600";

  return NextResponse.json(result, {
    headers: { "Cache-Control": cacheHeader },
  });
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseIntSafe(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBatchList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => BATCH_KEY_RE.test(value));
}
