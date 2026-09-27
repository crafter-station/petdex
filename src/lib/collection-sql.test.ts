import { describe, expect, it } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";

const dialect = new PgDialect();

describe("collection cover SQL", () => {
  it("preserves the current cover only when it remains in the replacement list", () => {
    const query = dialect.sqlToQuery(
      collectionCoverForPetSlugsQuery(["first", "hero"]),
    );

    expect(query.sql).toContain('"cover_pet_slug" IS NOT NULL');
    expect(query.sql).toContain('"cover_pet_slug" IN ($1, $2)');
    expect(query.sql).toContain('THEN "cover_pet_slug"');
    expect(query.params).toEqual(["first", "hero", "first"]);
  });

  it("clears the cover for an empty replacement list", () => {
    expect(dialect.sqlToQuery(collectionCoverForPetSlugsQuery([]))).toEqual({
      sql: "NULL",
      params: [],
    });
  });
});
