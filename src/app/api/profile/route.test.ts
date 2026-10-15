// Clearing the handle is a legal edit — the column is nullable, both web
// editors send `handle.trim() || null`, and `validateProfileHandle(null)`
// answers "ok". The route rejected it with `handle_too_short` before reaching
// that validator, so clearing the field 400'd the whole PATCH and blocked even
// a bio-only save. This pins the null/"" branch: the patch must carry
// `handle: null` and reach the write.
import { describe, expect, it, mock } from "bun:test";

import * as realSchema from "@/lib/db/schema";

const written: Record<string, unknown>[] = [];
const conflictSets: Record<string, unknown>[] = [];

mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
  clerkClient: async () => ({
    users: { updateUser: async () => ({}) },
  }),
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/ratelimit", () => ({
  profileEditRatelimit: { limit: async () => ({ success: true, reset: 0 }) },
  profilePinRatelimit: { limit: async () => ({ success: true, reset: 0 }) },
}));
mock.module("@/lib/db/cached-aggregates", () => ({
  invalidatePublicProfileCaches: async () => {},
  invalidatePublicHandleCaches: async () => {},
}));

mock.module("@/lib/db/client", () => ({
  schema: realSchema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
  db: {
    query: {
      // No stored profile: the handle-uniqueness check is skipped for a null
      // handle, and the previous-handle read returns nothing.
      userProfiles: { findFirst: async () => undefined },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({
          set,
        }: {
          set: Record<string, unknown>;
        }) => {
          written.push(v);
          conflictSets.push(set);
        },
      }),
    }),
  },
}));

const { PATCH } = await import("@/app/api/profile/route");

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request("https://petdex.dev/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/profile handle clearing", () => {
  it("accepts handle: null and writes the clear", async () => {
    written.length = 0;
    conflictSets.length = 0;
    const res = await patch({ handle: null, bio: "new bio" });
    expect(res.status).toBe(200);
    expect(conflictSets[0]?.handle).toBeNull();
    expect(conflictSets[0]?.bio).toBe("new bio");
  });

  it("accepts handle: '' the way the web editors send it", async () => {
    written.length = 0;
    conflictSets.length = 0;
    const res = await patch({ handle: "" });
    expect(res.status).toBe(200);
    expect(conflictSets[0]?.handle).toBeNull();
  });

  it("still rejects a too-short handle", async () => {
    const res = await patch({ handle: "ab" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "handle_too_short",
    );
  });
});
