import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const sql = neon(databaseUrl);
const migration = await readFile(
  join(process.cwd(), "drizzle/0018_sticker_exports.sql"),
  "utf8",
);

for (const statement of migration
  .split(";")
  .map((value) => value.trim())
  .filter(Boolean)) {
  await sql.query(statement, []);
}

console.log("sticker export schema applied");
