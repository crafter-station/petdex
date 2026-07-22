import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("home page data source", () => {
  it("renders the pet count from static data, not a database query", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

    expect(source).toContain("TOTAL_PET_COUNT");
    expect(source).not.toContain("searchPets");
    expect(source).not.toContain("getDexNumberMap");
    expect(source).not.toContain("dexMap=");
  });
});
