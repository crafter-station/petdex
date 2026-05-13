import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import {
  cachedAggregate,
  publicProfileCacheKey,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROFILE_ME_TTL_SECONDS = 300;

type ProfileMe = {
  handle: string | null;
  displayName: string | null;
};

// Returns the canonical profile fields the client components need
// (handle, displayName) sourced from our DB, not Clerk metadata.
// Clerk's username is allowed to drift (Thib's was null while his
// DB handle was "thibgl"), so the avatar dropdown was deep-linking
// to /u/<id-last-8> instead of /u/<real-handle>.
export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ handle: null, displayName: null });
  }

  const profile = await cachedAggregate<ProfileMe>(
    {
      key: publicProfileCacheKey(userId),
      ttlSeconds: PROFILE_ME_TTL_SECONDS,
    },
    async () => {
      const storedProfile = await db.query.userProfiles.findFirst({
        where: eq(schema.userProfiles.userId, userId),
        columns: { handle: true, displayName: true },
      });
      return (
        storedProfile ?? {
          handle: null,
          displayName: null,
        }
      );
    },
  );

  return NextResponse.json({
    handle: profile.handle,
    displayName: profile.displayName,
  });
}
