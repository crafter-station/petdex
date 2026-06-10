// URL detector for free-text fields (description, displayName, tags).
//
// Purpose: prevent submitters from embedding promotional URLs or links
// inside fields that are rendered as plain text in the gallery. This is
// distinct from the asset-url allowlist, which covers internal storage URLs.
//
// Do NOT apply to creditUrl — that field is explicitly intended to hold
// a URL.
//
// Detection runs on diacritic-normalized, lowercased text. The match
// result returns which pattern fired and which field it came from so
// callers can produce precise error messages.

export type UrlHit = {
  hit: true;
  pattern: string;
  field: string;
};

// Common TLDs likely to appear in promotional spam. Kept intentionally
// broad so that new TLDs are caught automatically. False-positive risk:
// `.dev` may appear in legitimate context (e.g., "v0.dev" as a tool
// reference). See report note below for Hunter's decision.
const COMMON_TLDS =
  "com|net|org|io|co|me|ai|app|dev|xyz|info|biz|club|link|page|site|store|tech|online|live|cn|cc|tv|to|gg|ly";

const URL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Explicit protocol — most obvious case.
  {
    name: "protocol_prefix",
    re: /https?:\/\//i,
  },
  // www. prefix — universal shorthand for a web address.
  {
    name: "www_prefix",
    re: /\bwww\.[a-z0-9-]/i,
  },
  // Well-known short-link services — often used for obfuscation.
  {
    name: "shortlink",
    re: /\bt\.me\/|\bbit\.ly\/|\btinyurl\.com\b/i,
  },
  // Obfuscated http: with interior whitespace: h t t p s :
  {
    name: "obfuscated_protocol",
    re: /\bh\s*t\s*t\s*p\s*s?\s*[:;]/i,
  },
  // "example dot com" style obfuscation — common in manual spam.
  {
    name: "dot_obfuscation",
    re: new RegExp(
      `[a-z0-9-]+\\s*(\\(dot\\)|\\[dot\\]|\\(\\.\\)|\\.\\.|,\\s*dot\\s*,)\\s*(${COMMON_TLDS})\\b`,
      "i",
    ),
  },
  // Bare domain with common TLD: "mypet.com", "sponsor.io".
  // The lookahead prevents matching version strings like "1.0io" (digit
  // immediately before the dot) or known safe patterns.
  {
    name: "bare_domain",
    re: new RegExp(`\\b[a-z0-9][a-z0-9-]{1,63}\\.(${COMMON_TLDS})\\b`, "i"),
  },
];

// Domains that are legitimate references in user text (tools, platforms,
// brands). These bypass the bare_domain check. They still trip the
// protocol pattern (https://v0.dev) which is intentional: if someone wants
// to plug their v0 project, they should not embed a clickable link.
const LEGIT_DOMAINS: ReadonlySet<string> = new Set([
  "v0.dev",
  "v0.app",
  "crafter.run",
  "petdex.dev",
  "codex.com",
  "openai.com",
  "anthropic.com",
  "github.com",
]);

// Normalize text for matching: NFKD decompose + strip diacritics + lowercase.
function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// Strip occurrences of allowlisted bare domains so the bare_domain regex
// does not flag them. Protocol-prefixed forms (https://v0.dev) still match.
function stripLegitDomains(value: string): string {
  let stripped = value;
  for (const domain of LEGIT_DOMAINS) {
    const re = new RegExp(`\\b${domain.replace(/\./g, "\\.")}\\b`, "gi");
    stripped = stripped.replace(re, "");
  }
  return stripped;
}

/**
 * Check one or more labeled fields for URL patterns.
 *
 * @param fields - Array of [fieldName, fieldValue] tuples. Pass null/undefined
 *                 values and they are silently skipped.
 * @returns UrlHit describing the first match, or null if clean.
 *
 * @example
 *   const hit = containsUrl(["description", desc], ["displayName", name]);
 *   if (hit) return NextResponse.json({ error: "url_in_field", ...hit }, { status: 422 });
 */
export function containsUrl(
  ...fields: Array<[fieldName: string, value: string | null | undefined]>
): UrlHit | null {
  for (const [fieldName, raw] of fields) {
    if (!raw || raw.length === 0) continue;
    const normalized = normalizeText(raw);
    for (const { name, re } of URL_PATTERNS) {
      const haystack =
        name === "bare_domain" ? stripLegitDomains(normalized) : normalized;
      if (re.test(haystack)) {
        return { hit: true, pattern: name, field: fieldName };
      }
    }
  }
  return null;
}

export const URL_BLOCKED_REASON =
  "URLs are not allowed in this field. Use the credit URL field for links.";
