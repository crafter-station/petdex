import { updateTag } from "next/cache";
import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, ne } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
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
    const normalized = normalizeProfileHandle(body.handle);
    if (normalized === null) {
      return NextResponse.json({ error: "handle_too_short" }, { status: 400 });
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
    // Read current set if the caller didn't override via featuredPetSlugs.
    if (nextSlugs === null) {
      const current = await db.query.userProfiles.findFirst({
        where: eq(schema.userProfiles.userId, userId),
      });
      nextSlugs = (current?.featuredPetSlugs as string[] | undefined) ?? [];
    }
    if (body.pin?.slug) {
      const slug = body.pin.slug.trim().toLowerCase();
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
    if (body.unpin?.slug) {
      const slug = body.unpin.slug.trim().toLowerCase();
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

  updateTag(`profile:${userId}`);
  if (typeof patch.handle === "string") {
    updateTag(`profile:${patch.handle}`);
  }

  return NextResponse.json({
    ok: true,
    displayName: patch.displayName,
    handle: patch.handle,
    preferredLocale: patch.preferredLocale,
    featuredPetSlugs: patch.featuredPetSlugs,
  });
}
