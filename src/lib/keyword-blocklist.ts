// Hard-blocked keywords for moderation. Anything that contains a hit
// after normalization is auto-rejected at the submission, edit, request,
// and collection-request boundaries, and is also the input to the
// scripts/takedown-by-keyword.ts ops script.
//
// Two cohorts so we can match them differently:
//   - latinTokens   matched on word boundaries against the lowercased,
//                   diacritic-stripped haystack. Keeps "ikun" from firing
//                   on benign substrings like "skunk" or "akin".
//   - chinesePhrases matched as raw substrings — Chinese has no spaces,
//                   so word boundaries do not apply.
//
// Add to either list as new evasions show up. Keep the lists deduped
// and lowercased.

// Grouped by subject so it's obvious why a token is on the list and
// who can be removed in one edit if scope changes. Keep the latin and
// chinese halves in sync — if a person/brand is added to one, check
// whether the other writing system also needs an entry.
const latinTokens: ReadonlyArray<string> = [
  // Cai Xukun (cluster that triggered the policy on 2026-05-09)
  "ikun",
  "i-kun",
  "i kun",
  "kunpet",
  "kun pet",
  "cai xukun",
  "caixukun",
  "xukun",
  "jige",
  "ji ge",
  // Lei Jun (Xiaomi president) + Xiaomi brand
  "lei jun",
  "leijun",
  "leijunpet",
  "xiaomi",
];

const chinesePhrases: ReadonlyArray<string> = [
  // Cai Xukun
  "蔡徐坤",
  "鸡哥",
  "鸡你太美",
  "坤坤",
  "小黑子",
  "ji哥",
  // Lei Jun + Xiaomi
  "雷军",
  "小米",
];

export type BlockedKeywordHit = {
  keyword: string;
  source: "latin" | "chinese";
};

// Invisible characters split a keyword so neither pass below sees it; the
// shared scrubber (and the measured evasions) live in invisible-characters.ts.
import { stripInvisible } from "@/lib/invisible-characters";

function normalizeLatin(value: string): string {
  return stripInvisible(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Word-boundary matcher that treats latin letters and digits as one word.
// Built lazily so the cost is paid once per process.
let latinRegexCache: RegExp | null = null;
function getLatinRegex(): RegExp {
  if (latinRegexCache) return latinRegexCache;
  const escaped = latinTokens.map((token) =>
    token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
  );
  // (?:^|\W) … (?:\W|$) — \b does not work cleanly with multi-word
  // tokens that contain spaces, so we anchor on non-word characters
  // ourselves.
  latinRegexCache = new RegExp(
    `(?:^|[^a-z0-9])(${escaped.join("|")})(?:[^a-z0-9]|$)`,
    "i",
  );
  return latinRegexCache;
}

export function findBlockedKeyword(
  ...inputs: Array<string | null | undefined>
): BlockedKeywordHit | null {
  const joined = inputs
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" \n ");
  if (!joined) return null;

  // Chinese pass — substring match against the raw NFKC-normalized text.
  // Invisibles go first for the same reason as the latin pass: a `\p{Cf}`
  // between two characters of a phrase defeats a plain `includes`.
  const nfkc = stripInvisible(joined).normalize("NFKC");
  for (const phrase of chinesePhrases) {
    if (nfkc.includes(phrase)) {
      return { keyword: phrase, source: "chinese" };
    }
  }

  // Latin pass — word-boundary against the diacritic-stripped lowercase.
  const latin = normalizeLatin(joined);
  const m = latin.match(getLatinRegex());
  if (m?.[1]) {
    return { keyword: m[1], source: "latin" };
  }

  return null;
}

export function containsBlockedKeyword(
  ...inputs: Array<string | null | undefined>
): boolean {
  return findBlockedKeyword(...inputs) !== null;
}

export const BLOCKED_KEYWORD_REASON =
  "Content references a public figure flagged by moderation policy.";

// Exported for scripts/takedown-by-keyword.ts and tests so the ops
// surface uses the same source of truth as the runtime blocklist.
export const BLOCKED_LATIN_TOKENS: ReadonlyArray<string> = latinTokens;
export const BLOCKED_CHINESE_PHRASES: ReadonlyArray<string> = chinesePhrases;
