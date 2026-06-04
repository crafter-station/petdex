import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("home gallery payload", () => {
  it("keeps the server-rendered gallery page smaller than the client page size", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

    expect(source).toContain("const HOME_INITIAL_GALLERY_LIMIT = 10;");
    expect(source).toContain(
      'searchPets({ sort: "alpha", limit: HOME_INITIAL_GALLERY_LIMIT })',
    );
  });
});
