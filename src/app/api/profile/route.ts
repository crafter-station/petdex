import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

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

import { hasLocale, type Locale } from "@/i18n/config";

export const runtime = "nodejs";

type PatchBody = {
  displayName?: string | null;
  handle?: string | null;
  bio?: string | null;
  preferredLocale?: Locale;
  featuredPetSlugs?: string[] | null;
  pin?: { slug: string };
  unpin?: { slug: string };
};

// No database in this repo — there's no profile row to persist a patch
// into. Validation and rate limiting stay so callers see the same
// contract; the "write" just isn't kept anywhere.
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
    if (nextSlugs === null) nextSlugs = [];
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
    patch.featuredPetSlugs = nextSlugs;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    displayName: patch.displayName,
    handle: patch.handle,
    preferredLocale: patch.preferredLocale,
    featuredPetSlugs: patch.featuredPetSlugs,
  });
}
