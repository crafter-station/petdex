import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("home gallery payload", () => {
  it("keeps the server-rendered gallery page smaller than the client page size", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

    const limit = Number(
      source.match(/HOME_INITIAL_GALLERY_LIMIT = (\d+)/)?.[1],
    );
    const pageSize = Number(
      readFileSync(
        join(__dirname, "..", "..", "components", "pets", "pet-gallery.tsx"),
        "utf8",
      ).match(/const PAGE_SIZE = (\d+)/)?.[1],
    );
    // The invariant in the test name: the first paint must not carry a full
    // client page, or the client's own first fetch duplicates it. Asserted as
    // numbers — a substring match passes even after the two constants swap.
    expect(limit).toBeGreaterThan(0);
    expect(pageSize).toBeGreaterThan(0);
    expect(limit).toBeLessThan(pageSize);
    expect(source).toContain(
      'searchPets({ sort: "installed", limit: HOME_INITIAL_GALLERY_LIMIT })',
    );
    expect(source).not.toContain("getDexNumberMap");
    expect(source).not.toContain("dexMap=");
  });
});
