import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { fetchVisibleRequestVotes } from "@/lib/visible-request-votes";

// Own PGlite connection, same reasoning as collection-empty-list.test.ts: the
// root suite never sets DATABASE_URL, so anything importing @/lib/db/client
// dies on load. The library under test takes the db as a parameter for exactly
// this reason, and its `db` is type-only — erased at runtime, never touching
// the client. Only the two tables its SQL references are created, with their
// DDL written out here rather than inherited, so this suite's schema stays
// explicit about what it depends on.

const pg = new PGlite();
const db = drizzle(pg);

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE pet_request_votes (
      request_id text NOT NULL,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (request_id, user_id)
    );
  `);
  await db.execute(sql`
    CREATE TABLE pet_requests (
      id text PRIMARY KEY,
      requested_by text
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM pet_request_votes`);
  await db.execute(sql`DELETE FROM pet_requests`);
});

async function seedRequest(id: string, requestedBy: string | null) {
  await db.execute(sql`
    INSERT INTO pet_requests (id, requested_by) VALUES (${id}, ${requestedBy})
  `);
}

async function seedVote(requestId: string, userId: string, ageMinutes: number) {
  await db.execute(sql`
    INSERT INTO pet_request_votes (request_id, user_id, created_at)
    VALUES (
      ${requestId},
      ${userId},
      now() - make_interval(mins => ${ageMinutes})
    )
  `);
}

describe("fetchVisibleRequestVotes", () => {
  it("returns no rows for an empty id list", async () => {
    expect(await fetchVisibleRequestVotes(db, [], 3)).toEqual([]);
  });

  it("keeps only the newest N voters per request", async () => {
    await seedRequest("req_1", null);
    // ages 0..4 minutes: user_0 is newest → visible = user_0, user_1, user_2
    for (let i = 0; i < 5; i++) {
      await seedVote("req_1", `user_${i}`, i);
    }

    const rows = await fetchVisibleRequestVotes(db, ["req_1"], 3);
    expect(rows.map((r) => r.userId)).toEqual(["user_0", "user_1", "user_2"]);
  });

  it("excludes the requester's own vote without consuming a slot", async () => {
    await seedRequest("req_1", "requester");
    // The requester voted first (oldest), then three real voters.
    await seedVote("req_1", "requester", 10);
    for (let i = 0; i < 3; i++) {
      await seedVote("req_1", `voter_${i}`, i);
    }

    const rows = await fetchVisibleRequestVotes(db, ["req_1"], 3);
    expect(rows.map((r) => r.userId)).toEqual([
      "voter_0",
      "voter_1",
      "voter_2",
    ]);
    expect(rows.map((r) => r.userId)).not.toContain("requester");
  });

  it("caps each request independently and ignores ids without votes", async () => {
    await seedRequest("req_1", null);
    await seedRequest("req_2", null);
    for (let i = 0; i < 4; i++) await seedVote("req_1", `a_${i}`, i);
    for (let i = 0; i < 2; i++) await seedVote("req_2", `b_${i}`, i);

    const rows = await fetchVisibleRequestVotes(
      db,
      ["req_1", "req_2", "req_empty"],
      3,
    );
    const byRequest = new Map<string, string[]>();
    for (const row of rows) {
      byRequest.set(row.requestId, [
        ...(byRequest.get(row.requestId) ?? []),
        row.userId,
      ]);
    }
    expect(byRequest.get("req_1")).toEqual(["a_0", "a_1", "a_2"]);
    expect(byRequest.get("req_2")).toEqual(["b_0", "b_1"]);
    expect(byRequest.has("req_empty")).toBe(false);
  });

  it("only counts voters whose request is in the asked-for set", async () => {
    await seedRequest("req_1", null);
    await seedRequest("req_other", null);
    await seedVote("req_1", "only", 1);
    await seedVote("req_other", "other_0", 0);
    await seedVote("req_other", "other_1", 1);

    const rows = await fetchVisibleRequestVotes(db, ["req_1"], 3);
    expect(rows).toEqual([{ requestId: "req_1", userId: "only" }]);
  });
});
