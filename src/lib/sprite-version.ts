export type SpriteVersionNumber = 1 | 2;

export type SpriteVersionParseResult =
  | { ok: true; version: SpriteVersionNumber }
  | { ok: false; value: unknown };

export function parseSpriteVersionNumber(
  petJson: Record<string, unknown> | null | undefined,
): SpriteVersionParseResult {
  const value = petJson?.spriteVersionNumber;
  if (value === undefined || value === 1) return { ok: true, version: 1 };
  if (value === 2) return { ok: true, version: 2 };
  return { ok: false, value };
}

export function normalizeSpriteVersionNumber(
  value: unknown,
): SpriteVersionParseResult {
  if (value === undefined || value === 1) {
    return { ok: true, version: 1 };
  }
  if (value === 2) return { ok: true, version: 2 };
  return { ok: false, value };
}

export function labelForSpriteVersion(version: SpriteVersionNumber): string {
  return version === 2 ? "Hatch v2 · 8x11" : "Classic v1 · 8x9";
}
