import { and, eq, isNull } from "drizzle-orm";

import {
  type ColorFamily,
  classifyColorFamily,
  extractDominantColor,
} from "../src/lib/color-extract";
import { db, schema } from "../src/lib/db/client";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const CONCURRENCY = 4;

type Row = {
  id: string;
  slug: string;
  spritesheetUrl: string;
};

const familyCounts = new Map<ColorFamily, number>();
const failures: string[] = [];

async function main() {
  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      spritesheetUrl: schema.submittedPets.spritesheetUrl,
    })
    .from(schema.submittedPets)
    .where(
      and(
        isNull(schema.submittedPets.dominantColor),
        eq(schema.submittedPets.status, "approved"),
      ),
    );

  console.log(
    `${DRY ? "[DRY] " : ""}backfilling colors for ${rows.length} approved pets`,
  );

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= rows.length) return;
      await processRow(rows[index], index, rows.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
  );

  console.log(`done. failures=${failures.length}`);
  if (failures.length > 0) {
    console.log("failed slugs:");
    for (const slug of failures) {
      console.log(`- ${slug}`);
    }
    // Non-zero so a scripted run is not read as complete when rows were left
    // without a colour.
    process.exitCode = 1;
  }
  for (const [family, count] of [...familyCounts.entries()].sort()) {
    console.log(`${family}: ${count}`);
  }
}

async function processRow(row: Row, index: number, total: number) {
  const color = await extractDominantColor(row.spritesheetUrl);
  if (!color) {
    failures.push(row.slug);
    console.log(`[${index + 1}/${total}] ${row.slug} -> null / failed`);
    return;
  }

  const family = classifyColorFamily(color);
  familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);

  console.log(`[${index + 1}/${total}] ${row.slug} -> ${color} / ${family}`);

  if (DRY) return;

  await db
    .update(schema.submittedPets)
    .set({
      dominantColor: color,
      colorFamily: family,
    })
    .where(eq(schema.submittedPets.id, row.id));
}

await main();
