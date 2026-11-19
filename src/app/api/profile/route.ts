import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { and, eq, inArray, ne } from "drizzle-orm";

import {
  invalidatePublicHandleCaches,
  invalidatePublicProfileCaches,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  dedupePins,
  isPinOnlyProfilePatch,
  MAX_PINNED_PETS,
  normalizeProfileDisplayName,
  normalizeProfileHandle,
  validateProfileHandle,
} from "@/lib/profiles";
import { profileEditRatelimit, profilePinRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

import { defaultLocale, hasLocale, type Locale } from "@/i18n/config";

export const runtime = "nodejs";

type PatchBody = {
  displayName?: string | null;
  handle?: string | null;
  bio?: string | null;
  preferredLocale?: Locale;
  // Either pass the full ordered list of pins (preferred) or a single
  // toggle action that adds/removes a slug from the existing set.
  featuredPetSlugs?: string[] | null;
  pin?: { slug: string };
  unpin?: { slug: string };
};

export async function PATCH(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const limiter = isPinOnlyProfilePatch(body)
    ? profilePinRatelimit
    : profileEditRatelimit;
  const lim = await limiter.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const patch: {
    displayName?: string | null;
    handle?: string | null;
    bio?: string | null;
    preferredLocale?: Locale;
    featuredPetSlugs?: string[];
  } = {};

  if (body.displayName !== undefined) {
    if (body.displayName === null || body.displayName === "") {
      patch.displayName = null;
    } else {
      const normalized = normalizeProfileDisplayName(body.displayName);
      if (normalized === null) {
        return NextResponse.json(
          { error: "invalid_display_name" },
          { status: 400 },
        );
      }
      patch.displayName = normalized;
    }
  }

  if (body.handle !== undefined) {
    if (body.handle !== null && typeof body.handle !== "string") {
      return NextResponse.json({ error: "invalid_handle" }, { status: 400 });
    }
    // Clearing the handle is a legal edit — the column is nullable and
    // `validateProfileHandle(null)` answers "ok" — and both web editors
    // send `handle.trim() || null`. Rejecting it here 400'd the whole
    // PATCH, so clearing the field also blocked a bio-only save. Mirror
    // the displayName/bio blocks: null means "clear".
    if (body.handle === null || body.handle === "") {
      patch.handle = null;
    } else {
      const normalized = normalizeProfileHandle(body.handle);
      if (normalized === null) {
        return NextResponse.json(
          { error: "handle_too_short" },
          { status: 400 },
        );
      }
      const validation = validateProfileHandle(normalized);
      if (validation !== "ok") {
        return NextResponse.json(
          { error: `handle_${validation}` },
          { status: 400 },
        );
      }
      if (normalized) {
        const existing = await db.query.userProfiles.findFirst({
          columns: { userId: true },
          where: and(
            eq(schema.userProfiles.handle, normalized),
            ne(schema.userProfiles.userId, userId),
          ),
        });
        if (existing) {
          return NextResponse.json({ error: "handle_taken" }, { status: 409 });
        }
      }
      patch.handle = normalized;
    }
  }

  if (body.bio !== undefined) {
    if (body.bio === null || body.bio === "") {
      patch.bio = null;
    } else if (typeof body.bio === "string") {
      const v = body.bio.trim().slice(0, 280);
      patch.bio = v.length > 0 ? v : null;
    } else {
      return NextResponse.json({ error: "invalid_bio" }, { status: 400 });
    }
  }

  if (body.preferredLocale !== undefined) {
    if (!hasLocale(body.preferredLocale)) {
      return NextResponse.json(
        { error: "invalid_preferred_locale" },
        { status: 400 },
      );
    }
    patch.preferredLocale = body.preferredLocale;
  }

  // Resolve next pins set. Three input shapes are supported so callers
  // can pick the simplest one for their UI: a full list (multi-select
  // editor), or pin/unpin (per-card button).
  let nextSlugs: string[] | null = null;

  if (body.featuredPetSlugs !== undefined) {
    if (body.featuredPetSlugs === null) {
      nextSlugs = [];
    } else if (Array.isArray(body.featuredPetSlugs)) {
      nextSlugs = dedupePins(body.featuredPetSlugs);
    } else {
      return NextResponse.json({ error: "invalid_featured" }, { status: 400 });
    }
  }

  if (body.pin || body.unpin) {
    // `pin`/`unpin` are typed as `{ slug: string }` but the body is an
    // unchecked cast: `{pin:{slug:5}}` made `.trim` throw and 500 the route.
    // The sibling fields above validate their shape; do the same here.
    const slugOf = (value: unknown): string | null =>
      typeof (value as { slug?: unknown })?.slug === "string"
        ? (value as { slug: string }).slug.trim().toLowerCase()
        : null;
    const pinSlug = slugOf(body.pin);
    const unpinSlug = slugOf(body.unpin);
    if ((body.pin && pinSlug === null) || (body.unpin && unpinSlug === null)) {
      return NextResponse.json({ error: "invalid_featured" }, { status: 400 });
    }
    // Read current set if the caller didn't override via featuredPetSlugs.
    if (nextSlugs === null) {
      const current = await db.query.userProfiles.findFirst({
        where: eq(schema.userProfiles.userId, userId),
      });
      nextSlugs = (current?.featuredPetSlugs as string[] | undefined) ?? [];
    }
    if (pinSlug) {
      const slug = pinSlug;
      if (!nextSlugs.includes(slug)) {
        if (nextSlugs.length >= MAX_PINNED_PETS) {
          return NextResponse.json(
            { error: "pin_cap_reached", max: MAX_PINNED_PETS },
            { status: 400 },
          );
        }
        nextSlugs = [...nextSlugs, slug];
      }
    }
    if (unpinSlug) {
      const slug = unpinSlug;
      nextSlugs = nextSlugs.filter((s) => s !== slug);
    }
  }

  if (nextSlugs !== null) {
    if (nextSlugs.length === 0) {
      patch.featuredPetSlugs = [];
    } else {
      // Validate: every slug must be approved AND owned by this user.
      const owned = await db
        .select({ slug: schema.submittedPets.slug })
        .from(schema.submittedPets)
        .where(
          and(
            eq(schema.submittedPets.ownerId, userId),
            eq(schema.submittedPets.status, "approved"),
            inArray(schema.submittedPets.slug, nextSlugs),
          ),
        );
      const ownedSet = new Set(owned.map((r) => r.slug));
      const filtered = nextSlugs.filter((s) => ownedSet.has(s));
      if (filtered.length !== nextSlugs.length) {
        return NextResponse.json(
          { error: "pet_not_owned_or_not_approved" },
          { status: 400 },
        );
      }
      patch.featuredPetSlugs = filtered;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  let previousHandle: string | null = null;
  if (patch.handle !== undefined) {
    const current = await db.query.userProfiles.findFirst({
      columns: { handle: true },
      where: eq(schema.userProfiles.userId, userId),
    });
    previousHandle = current?.handle ?? null;
  }

  try {
    await db
      .insert(schema.userProfiles)
      .values({
        userId,
        displayName: patch.displayName ?? null,
        handle: patch.handle ?? null,
        bio: patch.bio ?? null,
        preferredLocale: patch.preferredLocale ?? defaultLocale,
        featuredPetSlugs: patch.featuredPetSlugs ?? [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.userProfiles.userId,
        set: {
          ...patch,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // The handle check above is a not-in-the-same-statement read, so two
    // accounts taking the same handle at once both pass it and the second
    // INSERT hits `user_profiles_handle_unique`. Answer the 409 the check
    // would have, instead of an uncaught 23505 → 500. Same-shape race as
    // `isSlugUniqueViolation` covers for submission slugs.
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "handle_taken" }, { status: 409 });
    }
    throw error;
  }
  await Promise.all([
    invalidatePublicProfileCaches(userId),
    invalidatePublicHandleCaches(previousHandle, patch.handle),
  ]);

  // Sync Clerk username with the DB handle so Clerk's fallback browser
  // user object also lands on the right /u/<handle>. Clerk username has
  // stricter rules (uniqueness across the whole instance, format
  // constraints) — if the call fails, log and move on. The DB stays
  // source-of-truth and /api/me/header-state is the primary source.
  if (patch.handle !== undefined && patch.handle) {
    try {
      const cc = await clerkClient();
      await cc.users.updateUser(userId, { username: patch.handle });
    } catch (err) {
      console.warn(
        "[profile] failed to sync Clerk username:",
        (err as Error).message,
      );
    }
  }

  if (patch.displayName !== undefined || patch.handle !== undefined) {
    revalidatePath("/[locale]/requests", "page");
  }

  return NextResponse.json({
    ok: true,
    displayName: patch.displayName,
    handle: patch.handle,
    preferredLocale: patch.preferredLocale,
    featuredPetSlugs: patch.featuredPetSlugs,
  });
}
