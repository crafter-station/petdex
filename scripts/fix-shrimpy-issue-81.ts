// Fix Shrimpy metadata per issue #81
//
// Original tags incorrectly classified Shrimpy as "shrimp" because the
// description didn't mention "cat". Owner clarified Shrimpy is their real
// cat. Updates description + replaces "shrimp" tag with "cat".
//
// Usage:
//   bun scripts/fix-shrimpy-issue-81.ts           # preview (no writes)
//   bun scripts/fix-shrimpy-issue-81.ts --apply   # write
// Same dry-by-default gate as every other write script here; this one
// originally defaulted to applying, the only inversion in the directory.

import { eq } from "drizzle-orm";

import { db, schema } from "../src/lib/db/client";

const APPLY = process.argv.includes("--apply");

const SLUG = "shrimpy";

const NEW_DESCRIPTION =
  "Shrimpy, my sweet cuddly real life cat companion, reimagined as a cozy Codex digital pet for gentle coding sessions.";

async function main() {
  const [pet] = await db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.slug, SLUG))
    .limit(1);

  if (!pet) {
    console.error(`pet not found: slug=${SLUG}`);
    process.exit(1);
  }

  const oldTags = Array.isArray(pet.tags) ? pet.tags : [];
  const filtered = oldTags.filter((t) => t.toLowerCase() !== "shrimp");
  const newTags = filtered.includes("cat") ? filtered : ["cat", ...filtered];

  console.log("Current state:");
  console.log("  id:", pet.id);
  console.log("  slug:", pet.slug);
  console.log("  displayName:", pet.displayName);
  console.log("  description:", pet.description);
  console.log("  kind:", pet.kind);
  console.log("  vibes:", pet.vibes);
  console.log("  tags:", oldTags);
  console.log("");
  console.log("Proposed update:");
  console.log("  description:", NEW_DESCRIPTION);
  console.log("  tags:", newTags);
  console.log("");

  if (!APPLY) {
    console.log("(dry run) no changes written; pass --apply to write");
    return;
  }

  await db
    .update(schema.submittedPets)
    .set({
      description: NEW_DESCRIPTION,
      tags: newTags,
    })
    .where(eq(schema.submittedPets.slug, SLUG));

  console.log("updated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
