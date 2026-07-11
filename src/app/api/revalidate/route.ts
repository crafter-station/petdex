import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  expireNextCacheTags,
  revalidatePetTags,
} from "@/lib/db/cached-aggregates";

import { locales } from "@/i18n/config";

// Cross-app cache flush. revalidateTag only reaches the Next data cache
// of the app that calls it, so external writers that share the DB and
// Upstash (admin.petdex.dev approving submissions) still leave this
// app's unstable_cache layer stale: pre-approval 404s for `pet:{slug}`
// held for 24h, and the variant/dex indexes for up to their TTL. This
// endpoint lets those writers flush our tags after a write.

export const runtime = "nodejs";

const MAX_ITEMS = 100;
const MAX_ITEM_LENGTH = 200;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.PETDEX_REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeCompare(provided, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slugs = readStringArray(body, "slugs");
  const tags = readStringArray(body, "tags");
  if (!slugs && !tags) {
    return NextResponse.json(
      { error: "nothing_to_revalidate" },
      {
        status: 400,
      },
    );
  }

  if (slugs && slugs.length > 0) {
    await revalidatePetTags(...slugs);
    // Tag flushes clear the data cache, but a pre-approval notFound()
    // render leaves a full-route 404 entry that isn't linked to the
    // pet's cache tags, so it survives revalidateTag for the page's
    // whole 24h ISR window. Purge the route cache entries directly.
    await revalidatePetPaths(slugs);
  }
  if (tags && tags.length > 0) {
    await expireNextCacheTags(...tags);
  }

  return NextResponse.json({
    revalidated: { slugs: slugs ?? [], tags: tags ?? [] },
  });
}

async function revalidatePetPaths(slugs: string[]): Promise<void> {
  try {
    const { revalidatePath } = await import("next/cache");
    for (const slug of slugs) {
      // localePrefix="as-needed": the default locale serves at /pets/x
      // while the rest serve prefixed. Purge every public shape.
      revalidatePath(`/pets/${slug}`);
      for (const locale of locales) {
        revalidatePath(`/${locale}/pets/${slug}`);
      }
    }
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}

function readStringArray(body: unknown, field: string): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_ITEM_LENGTH,
    )
    .slice(0, MAX_ITEMS);
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
