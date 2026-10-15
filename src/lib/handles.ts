// Handle <-> userId resolution for /u/[handle] gallery pages.
//
// Source of truth: Petdex profile handle, then Clerk username, then a
// deterministic short suffix of the Clerk userId.

import { clerkClient } from "@clerk/nextjs/server";

import {
  cachedAggregate,
  handleForUserCacheKey,
  userIdForHandleCacheKey,
} from "@/lib/db/cached-aggregates";

export const FALLBACK_HANDLE_LENGTH = 8;
const HANDLE_CACHE_TTL_SECONDS = 300;

export function fallbackHandle(userId: string): string {
  return userId.slice(-FALLBACK_HANDLE_LENGTH).toLowerCase();
}

// A handle the reverse lookup's id-suffix sweep will accept: exactly
// FALLBACK_HANDLE_LENGTH characters, lowercased. The character class has to
// cover everything `fallbackHandle` can emit, or the /u/<handle> links built
// from it 404 for the very user they were generated for. Clerk ids and the
// seed/mock ids are alphanumeric plus `_` (`user_seed_dev` → `seed_dev`),
// and profile handles additionally allow `-`; a narrower class here silently
// rejects those tails.
export function isFallbackHandleShape(handle: string): boolean {
  return (
    handle.length === FALLBACK_HANDLE_LENGTH && /^[a-z0-9_-]+$/.test(handle)
  );
}

export function viewerIdForFallbackHandle(
  handle: string,
  viewerId: string | null,
): string | null {
  if (!viewerId) return null;
  return fallbackHandle(viewerId) === handle.trim().toLowerCase()
    ? viewerId
    : null;
}

// Forward: userId -> handle. Used to build /u/<handle> URLs from a
// pet's ownerId (e.g. credit chip, /my-pets header).
//
// The fallback suffix is a best-effort link, not a reserved name: nothing
// stops another user from registering a profile handle that equals someone
// else's id tail, and that registration wins (profile/Clerk lookups run
// before the suffix sweep). The displaced user's fallback link 404s until
// they set a real handle. Closing this would mean reserving every current
// suffix across registrations — a full-table check per handle save — which
// the fallback's purpose (a link for users who never picked a handle) does
// not justify. `userIdForHandle`'s ambiguity refusal keeps one squatted
// name from hijacking resolution to the wrong user when several ids share
// a tail.
export async function handleForUser(userId: string): Promise<string> {
  const cached = await cachedAggregate(
    {
      key: handleForUserCacheKey(userId),
      ttlSeconds: HANDLE_CACHE_TTL_SECONDS,
    },
    async () => resolveHandleForUser(userId, true),
  );
  return (
    cached ??
    (await resolveHandleForUser(userId, false)) ??
    fallbackHandle(userId)
  );
}

async function resolveHandleForUser(
  userId: string,
  cacheableOnly: boolean,
): Promise<string | null> {
  try {
    const { db, schema } = await import("@/lib/db/client");
    const { eq } = await import("drizzle-orm");
    const profile = await db.query.userProfiles.findFirst({
      columns: { handle: true },
      where: eq(schema.userProfiles.userId, userId),
    });
    if (profile?.handle) return profile.handle;
  } catch {
    if (cacheableOnly) return null;
    /* ignore */
  }

  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    if (u.username) return u.username.toLowerCase();
  } catch {
    if (cacheableOnly) return null;
    /* ignore */
  }
  return fallbackHandle(userId);
}

// Reverse: handle -> userId. Used by the /u/[handle] page to find the
// owner. Returns null if no user matches, so the page can 404.
//
// Strategy: query Clerk by username first (fast path, indexed), then
// fall back to scanning users by id-suffix only when needed. The fallback
// path uses our DB to narrow: any user who has submitted a pet whose
// ownerId ends with the requested suffix.
export async function userIdForHandle(handle: string): Promise<string | null> {
  const normalized = handle.trim().toLowerCase();

  const cached = await cachedAggregate(
    {
      key: userIdForHandleCacheKey(normalized),
      ttlSeconds: HANDLE_CACHE_TTL_SECONDS,
    },
    async () => resolveUserIdForHandle(normalized, true),
  );
  return cached ?? resolveUserIdForHandle(normalized, false);
}

async function resolveUserIdForHandle(
  normalized: string,
  cacheableOnly: boolean,
): Promise<string | null> {
  try {
    const { db, schema } = await import("@/lib/db/client");
    const { eq } = await import("drizzle-orm");
    const profile = await db.query.userProfiles.findFirst({
      columns: { userId: true },
      where: eq(schema.userProfiles.handle, normalized),
    });
    if (profile?.userId) return profile.userId;
  } catch {
    if (cacheableOnly) return null;
    /* fall through */
  }

  // Fast path: username lookup via Clerk Backend API.
  try {
    const client = await clerkClient();
    const list = await client.users.getUserList({
      username: [normalized],
      limit: 1,
    });
    if (list.data.length > 0) return list.data[0].id;
  } catch {
    if (cacheableOnly) return null;
    /* fall through */
  }

  // Fallback: id-suffix lookup. We accept the handle if it matches the
  // fallback shape, then sweep the tables that store userIds (pets,
  // requests, feedback, profiles) for any id whose tail matches. Refuses
  // ambiguous matches (>1 user).
  if (isFallbackHandleShape(normalized)) {
    try {
      const { db, schema } = await import("@/lib/db/client");
      const { sql } = await import("drizzle-orm");
      // Same predicate against four tables. We use a single query per
      // table because cross-table UNION through Drizzle is awkward, and
      // four cheap indexed scans is plenty fast at our row counts.
      const candidates = new Set<string>();
      const fromPets = await db
        .selectDistinct({ id: schema.submittedPets.ownerId })
        .from(schema.submittedPets)
        .where(
          sql`lower(right(${schema.submittedPets.ownerId}, ${FALLBACK_HANDLE_LENGTH})) = ${normalized}`,
        )
        .limit(2);
      for (const r of fromPets) candidates.add(r.id);

      if (candidates.size < 2) {
        const fromRequests = await db
          .selectDistinct({ id: schema.petRequests.requestedBy })
          .from(schema.petRequests)
          .where(
            sql`${schema.petRequests.requestedBy} IS NOT NULL AND lower(right(${schema.petRequests.requestedBy}, ${FALLBACK_HANDLE_LENGTH})) = ${normalized}`,
          )
          .limit(2);
        for (const r of fromRequests) if (r.id) candidates.add(r.id);
      }

      if (candidates.size < 2) {
        const fromFeedback = await db
          .selectDistinct({ id: schema.feedback.userId })
          .from(schema.feedback)
          .where(
            sql`${schema.feedback.userId} IS NOT NULL AND lower(right(${schema.feedback.userId}, ${FALLBACK_HANDLE_LENGTH})) = ${normalized}`,
          )
          .limit(2);
        for (const r of fromFeedback) if (r.id) candidates.add(r.id);
      }

      if (candidates.size < 2) {
        const fromProfiles = await db
          .selectDistinct({ id: schema.userProfiles.userId })
          .from(schema.userProfiles)
          .where(
            sql`lower(right(${schema.userProfiles.userId}, ${FALLBACK_HANDLE_LENGTH})) = ${normalized}`,
          )
          .limit(2);
        for (const r of fromProfiles) candidates.add(r.id);
      }

      if (candidates.size === 1) return [...candidates][0];
    } catch {
      return null;
    }
  }

  return null;
}

// Helper for the few places (e.g. SubmittedBy) that already have a Clerk
// user object cached and just want a handle without a fresh fetch.
export function handleFromClerk(user: {
  username: string | null;
  id: string;
}): string {
  return user.username ? user.username.toLowerCase() : fallbackHandle(user.id);
}
