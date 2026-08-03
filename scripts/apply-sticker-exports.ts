import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { neon } from "@neondatabase/serverless";

import { splitSqlStatements } from "@/lib/sql-statements";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const sql = neon(databaseUrl);
const migration = await readFile(
  join(process.cwd(), "drizzle/0018_sticker_exports.sql"),
  "utf8",
);

const statements = splitSqlStatements(migration);
await sql.transaction(statements.map((statement) => sql.query(statement, [])));

console.log("sticker export schema applied");
