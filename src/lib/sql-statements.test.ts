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

  // The `--> statement-breakpoint` marker drizzle writes between statements is
  // itself a `--` line comment, so a splitter blind to comments breaks on the
  // first `;` inside one — which is every multi-statement file. Measured before
  // the fix: this input returned 3 fragments, two of them starting with comment
  // text (`"-- header"` and `"--> statement-breakpoint\nCREATE …"`).
  it("does not split on a semicolon inside a line comment", () => {
    const statements = splitSqlStatements(
      "-- header; note\nCREATE INDEX a ON t(x);\n--> statement-breakpoint\nCREATE INDEX b ON t(y);",
    );
    expect(statements).toEqual([
      "-- header; note\nCREATE INDEX a ON t(x)",
      "--> statement-breakpoint\nCREATE INDEX b ON t(y)",
    ]);
  });

  it("does not split on a semicolon inside a block comment", () => {
    expect(
      splitSqlStatements(`/* a;b */ CREATE TABLE t(x int); DROP TABLE t;`),
    ).toEqual(["/* a;b */ CREATE TABLE t(x int)", "DROP TABLE t"]);
  });

  it("treats nested block comments as one comment", () => {
    // Postgres allows `/* /* */ */`; the inner `;` and the inner close must not
    // end the statement or the comment.
    expect(
      splitSqlStatements(`/* outer /* inner; */ still; */ SELECT 1; SELECT 2;`),
    ).toEqual(["/* outer /* inner; */ still; */ SELECT 1", "SELECT 2"]);
  });
});
