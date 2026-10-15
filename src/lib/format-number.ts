// Compact number formatting for user-facing counts (install totals, library
// sizes). The step is chosen from the ROUNDED value, not the raw one: the
// Chinese ladder is 千 (1e3) → 万 (1e4) → 亿 (1e8), so 9999 rounds to "10.0千"
// — a value the 万 unit should name — and 999_950 rounds to "1000.0K" where the
// M unit belongs. A number wearing the wrong magnitude word is wrong, not just
// oddly spelled, so round first and promote when the rounded value has reached
// the next step's threshold.

type Unit = { factor: number; suffix: string };

const LATIN_UNITS: ReadonlyArray<Unit> = [
  { factor: 1_000, suffix: "K" },
  { factor: 1_000_000, suffix: "M" },
  { factor: 1_000_000_000, suffix: "B" },
];

// Ascending so the promotion below can walk to the next unit by factor.
const CHINESE_UNITS: ReadonlyArray<Unit> = [
  { factor: 1_000, suffix: "千" },
  { factor: 10_000, suffix: "万" },
  { factor: 100_000_000, suffix: "亿" },
];

function formatScaled(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatWithUnits(n: number, units: ReadonlyArray<Unit>): string {
  if (n < 1000 || !Number.isFinite(n)) return n.toString();
  // Largest unit that does not exceed n.
  let index = 0;
  for (let i = 0; i < units.length; i++) {
    if (n >= units[i].factor) index = i;
    else break;
  }
  let scaled = Number((n / units[index].factor).toFixed(1));
  // Rounding can push the value to (or past) the next unit's threshold: 9999
  // / 1000 = 9.999 → 10.0, and 万 starts at 10000. Promote while it fits.
  while (
    index < units.length - 1 &&
    scaled * units[index].factor >= units[index + 1].factor
  ) {
    index += 1;
    scaled = Number((n / units[index].factor).toFixed(1));
  }
  return `${formatScaled(scaled)}${units[index].suffix}`;
}

export function formatChineseNumber(n: number): string {
  return formatWithUnits(n, CHINESE_UNITS);
}

export function formatLocalizedNumber(n: number, locale: string): string {
  if (locale === "zh") return formatChineseNumber(n);
  return formatWithUnits(n, LATIN_UNITS);
}
