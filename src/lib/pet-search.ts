// Server-side search backed by Postgres. All filtering, sorting and
// pagination happens in SQL with proper indexes (see schema.ts). Counts and
// facets are computed via grouped queries the DB can answer with the GIN
// indexes on `vibes` / `tags`.

import { neon } from "@neondatabase/serverless";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { COLOR_FAMILIES, type ColorFamily } from "@/lib/color-families";
import { AGGREGATE_KEYS, cachedAggregate } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { getAvailableBatches } from "@/lib/dex-batch.server";
import { PETDEX_EMBEDDING_MODEL } from "@/lib/embeddings";
import { withNextDataCache } from "@/lib/next-data-cache";
import { rowToPet } from "@/lib/pets";
import { embedQuery, looksLikeVibeQuery } from "@/lib/query-embed";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import {
  PET_KINDS,
  PET_VIBES,
  type PetdexPet,
  type PetKind,
  type PetVibe,
} from "@/lib/types";

const rawSql = neon(process.env.DATABASE_URL ?? "");

export type SortKey = "curated" | "popular" | "installed" | "alpha" | "recent";

export type SearchInput = {
  q?: string;
  kinds?: PetKind[];
  vibes?: PetVibe[];
  colorFamilies?: ColorFamily[];
  batches?: string[];
  sort?: SortKey;
  cursor?: number;
  limit?: number;
  /**
   * Per-visitor random hash used by the curated sort to give every
   * pet a fair shot at homepage exposure. See `lib/shuffle-seed.ts`
   * for how it's minted and persisted. Validated upstream — we still
   * pass it as a parameter binding so the SQL engine treats it as
   * data. Fallback ordering when missing is the legacy alpha sort.
   */
  shuffleSeed?: string;
};

export type SearchFacets = {
  kinds: Record<string, number>;
  vibes: Record<string, number>;
  colors: Record<ColorFamily, number>;
  batches: Array<{ key: string; label: string; count: number }>;
};

export type SearchPet = Pick<
  PetdexPet,
  | "slug"
  | "displayName"
  | "description"
  | "spritesheetPath"
  | "zipUrl"
  | "soundUrl"
  | "featured"
  | "kind"
  | "vibes"
  | "tags"
  | "dominantColor"
  | "submittedBy"
  | "source"
  | "approvedAt"
> & {
  dexNumber?: number | null;
  metrics: {
    installCount: number;
    likeCount: number;
    zipDownloadCount: number;
  };
};

export type SearchOutput = {
  pets: SearchPet[];
  total: number;
  nextCursor: number | null;
  /** Which path produced the results. 'vibe' = embedding cosine match,
   *  'keyword' = ILIKE filter, 'all' = no q. Lets the UI render hints. */
  searchMode: "vibe" | "keyword" | "all";
  facets: SearchFacets;
};

export type SearchPageOutput = Omit<SearchOutput, "total" | "facets"> & {
  total?: number;
  facets?: SearchFacets;
};

export type SearchOptions = {
  includeTotal?: boolean;
  includeFacets?: boolean;
};

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

export async function searchPets(input: SearchInput): Promise<SearchOutput>;
export async function searchPets(
  input: SearchInput,
  options: SearchOptions,
): Promise<SearchPageOutput>;
export async function searchPets(
  input: SearchInput,
  options: SearchOptions = {},
): Promise<SearchOutput | SearchPageOutput> {
  const sortKey = input.sort ?? "curated";
  const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cursor = Math.max(0, input.cursor ?? 0);
  const q = input.q?.trim() ?? "";
  const includeTotal = options.includeTotal ?? true;
  const includeFacets = options.includeFacets ?? true;

  // Vibe path: natural-language query, no other filters / non-default sort.
  // Embedding-only ranking has its own tradeoffs (kinds/vibes filters
  // would tighten what's returned and break cosine ranking semantics)
  // so we only branch when the query truly looks vibey.
  const isVibe =
    sortKey === "curated" &&
    looksLikeVibeQuery(q) &&
    !(input.kinds && input.kinds.length > 0) &&
    !(input.vibes && input.vibes.length > 0) &&
    !(input.colorFamilies && input.colorFamilies.length > 0) &&
    !(input.batches && input.batches.length > 0);

  if (isVibe) {
    const out = await vibeSearch({
      q,
      limit,
      cursor,
      includeTotal,
      includeFacets,
    });
    if (out) return out;
    // fall through to keyword if embedding failed
  }

  const filters = [eq(schema.submittedPets.status, "approved")];

  if (input.kinds && input.kinds.length > 0) {
    filters.push(inArray(schema.submittedPets.kind, input.kinds));
  }

  if (input.vibes && input.vibes.length > 0) {
    // jsonb ?| text[]  — the GIN index on `vibes` answers this. Pass as a
    // pg text array literal so the driver doesn't try to JSON-encode it.
    const literal = `{${input.vibes.map((v) => `"${v.replace(/"/g, "")}"`).join(",")}}`;
    filters.push(sql`${schema.submittedPets.vibes} ?| ${literal}::text[]`);
  }

  if (input.batches && input.batches.length > 0) {
    const batchExpr = sql<string>`to_char(date_trunc('month', ${schema.submittedPets.approvedAt} AT TIME ZONE 'UTC'), 'YYYY-MM')`;
    filters.push(inArray(batchExpr, input.batches));
  }

  if (input.colorFamilies && input.colorFamilies.length > 0) {
    filters.push(
      inArray(schema.submittedPets.colorFamily, input.colorFamilies),
    );
  }

  if (q) {
    const like = `%${q}%`;
    // Tags are jsonb — cast to text so ILIKE can scan them. The substring
    // search on display_name + description is small enough to live without
    // a trigram index at our current scale.
    const keywordFilter = or(
      ilike(schema.submittedPets.displayName, like),
      ilike(schema.submittedPets.description, like),
      sql`${schema.submittedPets.tags}::text ILIKE ${like}`,
    );
    if (keywordFilter) {
      filters.push(keywordFilter);
    }
  }

  const where = and(...filters);

  // LEFT JOIN pet_metrics so 'popular' / 'installed' sorts can use real
  // counts in SQL. coalesce-to-0 keeps pets without a metrics row last.
  const installCountSql = sql<number>`coalesce(${schema.petMetrics.installCount}, 0)`;
  const likeCountSql = sql<number>`coalesce(${schema.petMetrics.likeCount}, 0)`;
  const zipDownloadCountSql = sql<number>`coalesce(${schema.petMetrics.zipDownloadCount}, 0)`;
  const orderBy = orderForSort(
    sortKey,
    installCountSql,
    likeCountSql,
    input.shuffleSeed,
  );

  const dexNumbers = db.$with("dex_numbers").as(
    db
      .select({
        slug: schema.submittedPets.slug,
        dexNumber:
          sql<number>`row_number() OVER (ORDER BY ${schema.submittedPets.approvedAt} ASC, ${schema.submittedPets.createdAt} ASC)::int`.as(
            "dex_number",
          ),
      })
      .from(schema.submittedPets)
      .where(
        and(
          eq(schema.submittedPets.status, "approved"),
          ne(schema.submittedPets.source, "discover"),
        ),
      ),
  );

  const pageRows = await db
    .with(dexNumbers)
    .select({
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      description: schema.submittedPets.description,
      spritesheetUrl: schema.submittedPets.spritesheetUrl,
      zipUrl: schema.submittedPets.zipUrl,
      soundUrl: schema.submittedPets.soundUrl,
      featured: schema.submittedPets.featured,
      kind: schema.submittedPets.kind,
      vibes: schema.submittedPets.vibes,
      tags: schema.submittedPets.tags,
      dominantColor: schema.submittedPets.dominantColor,
      creditName: schema.submittedPets.creditName,
      creditImage: schema.submittedPets.creditImage,
      source: schema.submittedPets.source,
      approvedAt: schema.submittedPets.approvedAt,
      installCount: installCountSql,
      likeCount: likeCountSql,
      zipDownloadCount: zipDownloadCountSql,
      dexNumber: dexNumbers.dexNumber,
    })
    .from(schema.submittedPets)
    .leftJoin(
      schema.petMetrics,
      eq(schema.petMetrics.petSlug, schema.submittedPets.slug),
    )
    .leftJoin(dexNumbers, eq(dexNumbers.slug, schema.submittedPets.slug))
    .where(where)
    .orderBy(...orderBy)
    .offset(cursor)
    .limit(limit + 1);

  const hasNext = pageRows.length > limit;
  const slice = hasNext ? pageRows.slice(0, limit) : pageRows;

  const pets = slice.map(toSearchPetFromRow);

  const out: SearchPageOutput = {
    pets,
    nextCursor: hasNext ? cursor + limit : null,
    searchMode: q ? "keyword" : "all",
  };
  if (includeTotal) {
    // total — same filters, count only.
    const totalRow = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.submittedPets)
      .where(where);
    out.total = totalRow[0]?.n ?? 0;
  }
  if (includeFacets) {
    // facets — always over the unfiltered universe of approved pets so users
    // see all options as they narrow.
    out.facets = await loadFacets();
  }
  return out;
}

// Vector search via pgvector. We rank everything by cosine similarity to
// the embedded query, then page through that ranked list. Only includes
// rows whose similarity clears MIN_VIBE_SCORE so 'no results' is a real
// signal we can surface as a 'request this pet' CTA.
// Calibrated against the live 217-pet catalog. The mean similarity
// against an arbitrary embedded query sits at ~0.34, so we need to
// land above the baseline noise floor to surface real semantic
// matches without false positives:
//   'cozy night programmer' real hits -> 0.42-0.55
//   'fierce dragon' real hits          -> 0.45-0.55
//   'anti-gravity ... wizard' top hit  -> 0.366 (pure noise, false positive)
// 0.42 keeps real matches and triggers the empty-state 'request this
// pet' CTA on novel concepts the catalog truly doesn't cover.
const MIN_VIBE_SCORE = 0.42;

async function vibeSearch(args: {
  q: string;
  limit: number;
  cursor: number;
  includeTotal: boolean;
  includeFacets: boolean;
}): Promise<SearchPageOutput | null> {
  const vec = await embedQuery(args.q);
  if (!vec) return null;
  const literal = `[${vec.join(",")}]`;

  // pgvector cosine distance: <=> returns 0 (identical) -> 2 (opposite).
  // similarity = 1 - distance, so 1.0 = perfect match.
  const rows = (await rawSql`
    WITH dex_numbers AS (
      SELECT slug, row_number() OVER (ORDER BY approved_at ASC, created_at ASC)::int AS dex_number
      FROM submitted_pets
      WHERE status = 'approved' AND source <> 'discover'
    )
    SELECT
      sp.id, sp.slug, sp.display_name, sp.description,
      sp.spritesheet_url, sp.pet_json_url, sp.zip_url, sp.sound_url,
      sp.kind, sp.vibes, sp.tags, sp.dominant_color, sp.color_family,
      sp.featured, sp.dhash, sp.status, sp.source,
      sp.owner_id, sp.owner_email,
      sp.credit_name, sp.credit_url, sp.credit_image,
      sp.created_at, sp.approved_at, sp.rejected_at, sp.rejection_reason,
      coalesce(pm.install_count, 0) as install_count,
      coalesce(pm.like_count, 0) as like_count,
      coalesce(pm.zip_download_count, 0) as zip_download_count,
      dn.dex_number,
      1 - (sp.embedding <=> ${literal}::vector) as similarity
    FROM submitted_pets sp
    LEFT JOIN pet_metrics pm ON pm.pet_slug = sp.slug
    LEFT JOIN dex_numbers dn ON dn.slug = sp.slug
    WHERE sp.status = 'approved'
      AND sp.embedding IS NOT NULL
      AND sp.embedding_model = ${PETDEX_EMBEDDING_MODEL}
    ORDER BY sp.embedding <=> ${literal}::vector
    LIMIT ${args.limit + args.cursor + 1}
  `) as Array<Record<string, unknown> & { similarity: number }>;

  const ranked = rows.filter((r) => r.similarity >= MIN_VIBE_SCORE);
  const slice = ranked.slice(args.cursor, args.cursor + args.limit);
  const hasNext = ranked.length > args.cursor + args.limit;

  const pets = slice.map((row) =>
    toSearchPet(rowToPet(rowToSchema(row)), {
      dexNumber: row.dex_number == null ? null : Number(row.dex_number),
      installCount: Number(row.install_count) || 0,
      likeCount: Number(row.like_count) || 0,
      zipDownloadCount: Number(row.zip_download_count) || 0,
    }),
  );

  const out: SearchPageOutput = {
    pets,
    nextCursor: hasNext ? args.cursor + args.limit : null,
    searchMode: "vibe",
  };
  if (args.includeTotal) out.total = ranked.length;
  if (args.includeFacets) out.facets = await loadFacets();
  return out;
}

function toSearchPet(
  pet: PetdexPet,
  metrics: SearchPet["metrics"] & { dexNumber?: number | null },
): SearchPet {
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    spritesheetPath: pet.spritesheetPath,
    zipUrl: pet.zipUrl,
    soundUrl: pet.soundUrl,
    featured: pet.featured,
    kind: pet.kind,
    vibes: pet.vibes,
    tags: pet.tags,
    dominantColor: pet.dominantColor,
    submittedBy: pet.submittedBy,
    source: pet.source,
    approvedAt: pet.approvedAt,
    dexNumber: metrics.dexNumber,
    metrics: {
      installCount: metrics.installCount,
      likeCount: metrics.likeCount,
      zipDownloadCount: metrics.zipDownloadCount,
    },
  };
}

function toSearchPetFromRow(row: {
  slug: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  zipUrl: string | null;
  soundUrl: string | null;
  featured: boolean;
  kind: string;
  vibes: unknown;
  tags: unknown;
  dominantColor: string | null;
  creditName: string | null;
  creditImage: string | null;
  source: PetdexPet["source"];
  approvedAt: Date | null;
  dexNumber: number | null;
  installCount: number | null;
  likeCount: number | null;
  zipDownloadCount: number | null;
}): SearchPet {
  return {
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    spritesheetPath: toCurrentR2PublicUrl(row.spritesheetUrl),
    zipUrl: toCurrentR2PublicUrl(row.zipUrl) ?? undefined,
    soundUrl: toCurrentR2PublicUrl(row.soundUrl),
    featured: row.featured,
    kind: row.kind as PetKind,
    vibes: Array.isArray(row.vibes) ? (row.vibes as PetVibe[]) : [],
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    dominantColor: row.dominantColor,
    submittedBy: row.creditName
      ? { name: row.creditName, imageUrl: row.creditImage ?? undefined }
      : undefined,
    source: row.source,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    dexNumber: row.dexNumber,
    metrics: {
      installCount: row.installCount ?? 0,
      likeCount: row.likeCount ?? 0,
      zipDownloadCount: row.zipDownloadCount ?? 0,
    },
  };
}

// Map a snake_case row out of the raw query into the camelCase shape
// rowToPet expects. Drizzle's findFirst would do this for us but raw SQL
// gives us the embedding ordering we need.
function rowToSchema(
  row: Record<string, unknown>,
): typeof schema.submittedPets.$inferSelect {
  return {
    id: row.id as string,
    slug: row.slug as string,
    displayName: row.display_name as string,
    description: row.description as string,
    spritesheetUrl: row.spritesheet_url as string,
    petJsonUrl: row.pet_json_url as string,
    zipUrl: row.zip_url as string,
    soundUrl: (row.sound_url as string | null) ?? null,
    kind: row.kind as "creature" | "object" | "character",
    vibes: row.vibes as string[],
    tags: row.tags as string[],
    dominantColor: (row.dominant_color as string | null) ?? null,
    colorFamily: (row.color_family as string | null) ?? null,
    featured: row.featured as boolean,
    dhash: (row.dhash as string | null) ?? null,
    status: row.status as "approved" | "pending" | "rejected",
    source:
      (row.source as "submit" | "discover" | "claimed" | undefined) ?? "submit",
    ownerId: row.owner_id as string,
    ownerEmail: (row.owner_email as string | null) ?? null,
    creditName: (row.credit_name as string | null) ?? null,
    creditUrl: (row.credit_url as string | null) ?? null,
    creditImage: (row.credit_image as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    approvedAt: row.approved_at ? new Date(row.approved_at as string) : null,
    rejectedAt: row.rejected_at ? new Date(row.rejected_at as string) : null,
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    pendingDisplayName: (row.pending_display_name as string | null) ?? null,
    pendingDescription: (row.pending_description as string | null) ?? null,
    pendingTags: (row.pending_tags as string[] | null) ?? null,
    pendingSubmittedAt: row.pending_submitted_at
      ? new Date(row.pending_submitted_at as string)
      : null,
    pendingRejectionReason:
      (row.pending_rejection_reason as string | null) ?? null,
    pendingSpritesheetUrl:
      (row.pending_spritesheet_url as string | null) ?? null,
    pendingPetJsonUrl: (row.pending_pet_json_url as string | null) ?? null,
    pendingZipUrl: (row.pending_zip_url as string | null) ?? null,
    pendingSpritesheetWidth:
      (row.pending_spritesheet_width as number | null) ?? null,
    pendingSpritesheetHeight:
      (row.pending_spritesheet_height as number | null) ?? null,
    pendingDhash: (row.pending_dhash as string | null) ?? null,
    pendingReviewId: (row.pending_review_id as string | null) ?? null,
    pendingAutoApprovedAt: row.pending_auto_approved_at
      ? new Date(row.pending_auto_approved_at as string)
      : null,
    editCount: (row.edit_count as number | null) ?? 0,
    lastEditAt: row.last_edit_at ? new Date(row.last_edit_at as string) : null,
    galleryPosition: (row.gallery_position as number | null) ?? 0,
  };
}

function orderForSort(
  key: SortKey,
  installCountSql: SQL<number>,
  likeCountSql: SQL<number>,
  shuffleSeed?: string,
) {
  switch (key) {
    case "popular":
      return [desc(likeCountSql), asc(schema.submittedPets.displayName)];
    case "installed":
      return [desc(installCountSql), asc(schema.submittedPets.displayName)];
    case "alpha":
      return [asc(schema.submittedPets.displayName)];
    case "recent":
      // Newest approvals first. Falls back to displayName so two pets
      // approved in the same second still get a stable order.
      return [
        desc(schema.submittedPets.approvedAt),
        asc(schema.submittedPets.displayName),
      ];
    default: {
      // Per-visitor stable shuffle: featured pets keep their pinned
      // tier, then everything else is ordered by a deterministic hash
      // of (slug + visitor_seed). Different visitors get different
      // orderings; the same visitor gets a stable order for the life
      // of their cookie. Falls back to alpha when no seed is supplied
      // (e.g. cookies disabled, server-side debug calls).
      // See https://github.com/crafter-station/petdex/issues/82
      if (shuffleSeed) {
        return [
          desc(schema.submittedPets.featured),
          sql`md5(${schema.submittedPets.slug} || ${shuffleSeed})`,
        ];
      }
      return [
        desc(schema.submittedPets.featured),
        asc(schema.submittedPets.displayName),
      ];
    }
  }
}

const computeFacets = withNextDataCache(
  async (): Promise<SearchFacets> => {
    const [kindRows, vibeRows, batches] = await Promise.all([
      db
        .select({
          kind: schema.submittedPets.kind,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.submittedPets)
        .where(eq(schema.submittedPets.status, "approved"))
        .groupBy(schema.submittedPets.kind),
      db.execute<{
        vibe: string;
        n: number;
      }>(sql`
      SELECT v::text AS vibe, count(*)::int AS n
      FROM submitted_pets,
           jsonb_array_elements_text(vibes) AS v
      WHERE status = 'approved'
      GROUP BY v
    `),
      getAvailableBatches(),
    ]);

    const kinds: Record<string, number> = {};
    for (const k of PET_KINDS) kinds[k] = 0;
    for (const row of kindRows) kinds[row.kind] = row.n;

    const vibes: Record<string, number> = {};
    for (const v of PET_VIBES) vibes[v] = 0;
    for (const row of vibeRows.rows ?? []) {
      vibes[row.vibe] = row.n;
    }

    const colorRows = await db
      .select({
        colorFamily: schema.submittedPets.colorFamily,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.submittedPets)
      .where(eq(schema.submittedPets.status, "approved"))
      .groupBy(schema.submittedPets.colorFamily);

    const colors = Object.fromEntries(
      COLOR_FAMILIES.map((family) => [family, 0]),
    ) as Record<ColorFamily, number>;
    for (const row of colorRows) {
      if (row.colorFamily && row.colorFamily in colors) {
        colors[row.colorFamily as ColorFamily] = row.n;
      }
    }

    return { kinds, vibes, colors, batches };
  },
  ["petdex-facets"],
  { tags: ["petdex:facets"], revalidate: 300 },
);

// Two-tier cache for the facet aggregate. Upstash sits in front of the
// Next per-instance cache so cross-lambda fan-out doesn't recompute
// the same `GROUP BY` query on every cold instance.
const loadFacets = (): Promise<SearchFacets> =>
  cachedAggregate(
    { key: AGGREGATE_KEYS.facets, ttlSeconds: 300 },
    computeFacets,
  );

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const SEARCH_LIMITS = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
} as const;
