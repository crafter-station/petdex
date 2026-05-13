// Resolve a pet's "submitted by" credit from Clerk at render time
// instead of the row's frozen credit_* columns.
//
// Why: credit_* gets stale. A user who connects GitHub after submitting
// keeps showing email-prefix as their name forever. The columns stay as
// a fallback for orphan rows (Clerk user deleted, lookup throws, etc.).
//
// API:
//   resolveOwnerCredits([id1, id2, ...]) -> Map<userId, OwnerCredit>
//   resolveOwnerCreditFor(row) -> OwnerCredit (single row convenience)
//
// Both prefer fresh Clerk data; missing fields fall through to whatever
// the row already has, then to a final "anonymous" sentinel.

import { cache } from "react";

import { clerkClient } from "@clerk/nextjs/server";
import { inArray } from "drizzle-orm";

import {
  cachedAggregate,
  publicProfileCacheKey,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";

export type OwnerExternal = {
  provider: "github" | "x";
  username: string;
  url: string;
};

export type OwnerCredit = {
  // Clerk user id; useful for /u/<handle> links
  userId: string;
  // Public display label, prefer realName -> @username -> email-prefix
  // -> stored row credit -> "anonymous"
  name: string;
  // /u/<handle>; built from username, falls back to last 8 chars of id
  handle: string;
  // Optional Clerk username for "@" rendering when present
  username: string | null;
  // External profiles (GitHub + X). Empty if none, in display priority.
  externals: OwnerExternal[];
  // Avatar; clerk image first, stored credit second
  imageUrl: string | null;
};

export type RowCreditFallback = {
  ownerId: string;
  creditName: string | null;
  creditUrl: string | null;
  creditImage: string | null;
  /**
   * When true, the ownerId points at an admin (or whoever did the
   * import on someone else's behalf), NOT the actual author. In that
   * case we ignore the live Clerk profile of the ownerId and trust
   * the stored credit_* fields exclusively — they're what credits
   * the real author. Set this for any row whose source = 'discover'.
   */
  ownerIsProxy?: boolean;
};

type StoredPublicProfile = {
  displayName: string | null;
  handle: string | null;
};

const PUBLIC_PROFILE_TTL_SECONDS = 300;

function fallbackHandle(userId: string): string {
  return userId.slice(-8).toLowerCase();
}

function externalsFor(
  externalAccounts: Array<{ provider?: string; username?: string }>,
): OwnerExternal[] {
  // GitHub first, then X. Each shows as its own chip in the UI.
  let github: OwnerExternal | null = null;
  let x: OwnerExternal | null = null;
  for (const acc of externalAccounts ?? []) {
    if (!acc.username) continue;
    if (acc.provider === "oauth_github" && !github) {
      github = {
        provider: "github",
        username: acc.username,
        url: `https://github.com/${acc.username}`,
      };
    }
    if (
      (acc.provider === "oauth_x" || acc.provider === "oauth_twitter") &&
      !x
    ) {
      x = {
        provider: "x",
        username: acc.username,
        url: `https://x.com/${acc.username}`,
      };
    }
  }
  return [github, x].filter((v): v is OwnerExternal => Boolean(v));
}

function buildName(
  username: string | null,
  firstName: string | null,
  lastName: string | null,
  email: string | null,
  fallbackName: string | null,
): string {
  // Prefer real first+last name in full. Initials looked weird ("Chris M.")
  // and lost information. If there's no first/last, fall through to
  // username -> email-prefix -> stored fallback -> anonymous.
  const first = firstName?.trim() || null;
  const last = lastName?.trim() || null;
  if (first || last) {
    return [first, last].filter(Boolean).join(" ");
  }
  if (username) return username;
  if (email?.includes("@")) return email.split("@")[0];
  if (fallbackName) return fallbackName;
  return "anonymous";
}

// React cache() ensures one call per render pass — repeated invocations
// with the same input share the underlying Clerk fetch.
export const resolveOwnerCredits = cache(
  async (fallbacks: RowCreditFallback[]): Promise<Map<string, OwnerCredit>> => {
    const out = new Map<string, OwnerCredit>();
    const ids = [...new Set(fallbacks.map((f) => f.ownerId))];
    if (ids.length === 0) return out;

    const proxyIds = new Set(
      fallbacks.filter((f) => f.ownerIsProxy).map((f) => f.ownerId),
    );
    const profileByOwner = new Map<
      string,
      { displayName: string | null; handle: string | null }
    >();
    const profileIds = ids.filter((id) => !proxyIds.has(id));
    if (profileIds.length > 0) {
      try {
        const profiles = await db
          .select({
            userId: schema.userProfiles.userId,
            displayName: schema.userProfiles.displayName,
            handle: schema.userProfiles.handle,
          })
          .from(schema.userProfiles)
          .where(inArray(schema.userProfiles.userId, profileIds));
        for (const profile of profiles) {
          profileByOwner.set(profile.userId, {
            displayName: profile.displayName,
            handle: profile.handle,
          });
        }
      } catch {
        profileByOwner.clear();
      }
    }

    // Pre-fill from row fallbacks so even if Clerk fails entirely we
    // still return something for every owner.
    const fallbackByOwner = new Map<string, RowCreditFallback>();
    for (const f of fallbacks) {
      if (!fallbackByOwner.has(f.ownerId)) fallbackByOwner.set(f.ownerId, f);
      if (out.has(f.ownerId)) continue;
      const profile = profileByOwner.get(f.ownerId);
      const externals: OwnerExternal[] = [];
      if (f.creditUrl) {
        try {
          const u = new URL(f.creditUrl);
          if (u.host === "github.com") {
            externals.push({
              provider: "github",
              username: u.pathname.slice(1),
              url: f.creditUrl,
            });
          } else if (u.host === "x.com" || u.host === "twitter.com") {
            externals.push({
              provider: "x",
              username: u.pathname.slice(1),
              url: f.creditUrl,
            });
          }
        } catch {
          /* ignore malformed stored URL */
        }
      }
      const fallbackName = f.creditName?.trim() || "anonymous";
      out.set(f.ownerId, {
        userId: f.ownerId,
        name: profile?.displayName ?? fallbackName,
        handle: profile?.handle ?? fallbackHandle(f.ownerId),
        username: null,
        externals,
        imageUrl: f.creditImage,
      });
    }

    let client: Awaited<ReturnType<typeof clerkClient>>;
    try {
      client = await clerkClient();
    } catch {
      return out;
    }

    // We only resolve live Clerk data for owners whose Clerk profile
    // actually represents the author. Proxy owners (an admin who
    // imported the row on someone else's behalf) keep the row-level
    // credit_* values we already pre-filled above.
    const idsToFetch = ids.filter(
      (id) => !fallbackByOwner.get(id)?.ownerIsProxy,
    );

    for (let i = 0; i < idsToFetch.length; i += 100) {
      const batch = idsToFetch.slice(i, i + 100);
      try {
        const list = await client.users.getUserList({
          userId: batch,
          limit: 100,
        });
        for (const u of list.data) {
          const fallback = fallbackByOwner.get(u.id);
          const primary = u.emailAddresses.find(
            (e) => e.id === u.primaryEmailAddressId,
          );
          const externalAccounts = (u.externalAccounts ?? []) as Array<{
            provider?: string;
            username?: string;
          }>;
          const externals = externalsFor(externalAccounts);
          const name = buildName(
            u.username ?? null,
            u.firstName ?? null,
            u.lastName ?? null,
            primary?.emailAddress ?? null,
            fallback?.creditName ?? null,
          );
          const profile = profileByOwner.get(u.id);
          out.set(u.id, {
            userId: u.id,
            name: profile?.displayName ?? name,
            handle:
              profile?.handle ??
              (u.username ? u.username.toLowerCase() : fallbackHandle(u.id)),
            username: u.username ?? null,
            externals,
            imageUrl: u.imageUrl ?? fallback?.creditImage ?? null,
          });
        }
      } catch {
        /* keep the row-fallback entry already in `out` */
      }
    }

    return out;
  },
);

export async function resolveOwnerCreditFor(
  row: RowCreditFallback,
): Promise<OwnerCredit> {
  const map = await resolveOwnerCredits([row]);
  return (
    map.get(row.ownerId) ?? {
      userId: row.ownerId,
      name: row.creditName?.trim() || "anonymous",
      handle: fallbackHandle(row.ownerId),
      username: null,
      externals: [],
      imageUrl: row.creditImage,
    }
  );
}

export async function resolveStoredOwnerCreditFor(
  row: RowCreditFallback,
): Promise<OwnerCredit> {
  // ISR pet pages render from persisted public identity fields only.
  // Keeping live Clerk avatar/external-account freshness requires a future
  // DB sync/webhook rather than a per-render Clerk lookup.
  let profile: { displayName: string | null; handle: string | null } | null =
    null;

  if (!row.ownerIsProxy) {
    profile = await getStoredPublicProfile(row.ownerId);
  }

  const externals: OwnerExternal[] = [];
  if (row.creditUrl) {
    try {
      const url = new URL(row.creditUrl);
      const username = url.pathname.slice(1);
      if (url.host === "github.com" && username) {
        externals.push({ provider: "github", username, url: row.creditUrl });
      } else if (
        (url.host === "x.com" || url.host === "twitter.com") &&
        username
      ) {
        externals.push({ provider: "x", username, url: row.creditUrl });
      }
    } catch {
      /* ignore malformed stored URL */
    }
  }

  return {
    userId: row.ownerId,
    name: (profile?.displayName ?? row.creditName?.trim()) || "anonymous",
    handle: profile?.handle ?? fallbackHandle(row.ownerId),
    username: null,
    externals,
    imageUrl: row.creditImage,
  };
}

async function getStoredPublicProfile(
  userId: string,
): Promise<StoredPublicProfile | null> {
  return cachedAggregate(
    {
      key: publicProfileCacheKey(userId),
      ttlSeconds: PUBLIC_PROFILE_TTL_SECONDS,
    },
    async () => {
      try {
        const [storedProfile] = await db
          .select({
            displayName: schema.userProfiles.displayName,
            handle: schema.userProfiles.handle,
          })
          .from(schema.userProfiles)
          .where(inArray(schema.userProfiles.userId, [userId]));
        return storedProfile ?? { displayName: null, handle: null };
      } catch {
        return null;
      }
    },
  );
}
