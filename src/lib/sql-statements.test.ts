import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { splitSqlStatements } from "@/lib/sql-statements";

describe("SQL statement splitting", () => {
  it("preserves semicolons inside quoted and dollar-quoted values", () => {
    expect(
      splitSqlStatements(
        `SELECT ';' AS value; SELECT "semi;colon"; SELECT $$body;value$$;`,
      ),
    ).toEqual([
      "SELECT ';' AS value",
      'SELECT "semi;colon"',
      "SELECT $$body;value$$",
    ]);
  });

  it("round-trips the sticker export migration", () => {
    const migration = readFileSync(
      resolve("drizzle/0018_sticker_exports.sql"),
      "utf8",
    );
    const statements = splitSqlStatements(migration);

    expect(statements.length).toBeGreaterThan(20);
    expect(splitSqlStatements(statements.join(";\n"))).toEqual(statements);
  });
});
