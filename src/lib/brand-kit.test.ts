import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  BRAND_ASSETS,
  BRAND_COLORS,
  BRAND_JSON_LD,
  LOGO_GEOMETRY,
} from "@/lib/brand-kit";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");

describe("brand-kit", () => {
  test("every declared preview and download asset exists under public/", () => {
    for (const asset of BRAND_ASSETS) {
      const previewPath = path.join(PUBLIC_DIR, asset.preview);
      expect(existsSync(previewPath)).toBe(true);
      for (const download of asset.downloads) {
        const downloadPath = path.join(PUBLIC_DIR, download.href);
        expect(existsSync(downloadPath)).toBe(true);
      }
    }
  });

  test("color tokens carry valid HEX, OKLCH, and CSS var values", () => {
    for (const color of BRAND_COLORS) {
      expect(color.hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(color.oklch.startsWith("oklch(")).toBe(true);
      expect(color.cssVar.startsWith("var(--")).toBe(true);
    }
  });

  test("tactile mark ships as a downloadable SVG", () => {
    const tactile = BRAND_ASSETS.find((asset) => asset.key === "tactileMark");
    expect(tactile?.preview).toBe("/brand/petdex-tactile-mark.svg");
    expect(tactile?.downloads.map((d) => d.format)).toContain("svg");
  });

  test("colors follow the Pocket Toy kawaii-hardware palette", () => {
    expect(BRAND_COLORS.map((color) => [color.key, color.hex])).toEqual([
      ["cobalt", "#3B59F2"],
      ["deepNavy", "#101944"],
      ["pearlShell", "#F7F8FC"],
      ["voltYellow", "#FFE259"],
      ["sakuraPink", "#FF7AA2"],
      ["mint", "#34D399"],
    ]);
  });

  test("logo geometry matches the 64x64 pixel mark specification", () => {
    expect(LOGO_GEOMETRY.viewBox).toBe(64);
    expect(LOGO_GEOMETRY.pixelUnit).toBe(6);
    expect(LOGO_GEOMETRY.clearspaceRatio).toBe(0.25);
  });

  test("brand JSON-LD links Petdex, Railly Hugo, and Crafter Station", () => {
    const ids = BRAND_JSON_LD["@graph"].map((node) => node["@id"]);
    expect(ids).toContain("https://crafter.run/#organization");
    expect(ids).toContain("https://www.railly.dev/#person");
    expect(ids).toContain("https://petdex.dev/#website");
  });
});
