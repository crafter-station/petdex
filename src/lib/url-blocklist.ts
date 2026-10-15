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

import { stripInvisible } from "@/lib/invisible-characters";

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
  // "example dot com" style obfuscation — common in manual spam. The dot
  // placeholder may carry whitespace on either side ("evil (dot) com"), the
  // bracketed forms keep their exact delimiters ("evil[dot]com"), and the
  // word form ("evil dot com") is the same sentence-shaped dodge — gated on
  // the left token not being an everyday English word ("the dot com chapter"
  // is prose, not an obfuscated domain).
  {
    name: "dot_obfuscation",
    re: new RegExp(
      `[a-z0-9-]+\\s*(\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\.\\.|,\\s*dot\\s*,|dot)\\s*(${COMMON_TLDS})\\b`,
      "i",
    ),
  },
  // Whitespace-torn domain: "evil. com", "evil . com". The space defeats the
  // bare_domain regex, whose \b requires the dot to sit against the TLD, and
  // the dotted forms above only fire when the separator reads as the word
  // "dot". Matching "domain ␣·␣ TLD" directly keeps the version-string guard:
  // "1.0 io" does not match because the left token must end in [a-z0-9-]
  // without a digit-dot pair ("1.0" is <digit>.<digit>, its tail after the
  // dot is not [a-z0-9-]). The left token also has to look like a domain
  // label — at least 4 characters — because a sentence boundary ("yes. me
  // too", "no. app here") puts short words and sentence-final words before
  // any TLD, and a torn domain's left half is a hostname someone wanted to
  // keep whole enough to read: measured false positives at 1-3 characters
  // were every ordinary short sentence ending in a TLD word.
  {
    name: "spaced_tld",
    re: new RegExp(
      `\\b[a-z0-9][a-z0-9-]{3,63}\\s*\\.\\s+(${COMMON_TLDS})\\b`,
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

// Normalize text for matching: strip invisible characters, NFKD decompose +
// strip diacritics + lowercase. The invisible scrub comes first for the same
// reason as the keyword blocklist: a `\p{Cf}` inserted into a token — most of
// all into `http://` itself — defeats a literal pattern. Measured before the
// fix: "https\u200b://evil.example" and "sponsor\ufe0f.xyz" both returned null
// while the plain spellings matched.
function normalizeText(value: string): string {
  return stripInvisible(value)
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

// Words that legitimately sit next to "com" in prose ("read the dot com
// intro chapter", "dot com bubble"). When the token before the dot
// placeholder is one of these, the bare word-dot form is prose, not a
// scrambled domain. Bracketed/parenthesized forms never consult this list —
// "(dot)"/"[dot]" is already deliberate obfuscation.
const DOT_PROSE_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "bubble",
  "era",
  "for",
  "from",
  "in",
  "is",
  "it",
  "like",
  "my",
  "of",
  "on",
  "or",
  "read",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

// Sentence-final words that precede a TLD word across a sentence boundary:
// "wait. io games are fun" is prose, not a torn domain. A torn domain's left
// half is a hostname the writer wanted recognizable, so common short words
// before the dot are prose. Kept small and word-based rather than trying to
// model English: a real torn domain uses a label nobody would otherwise
// write before a period.
const SPACED_TLD_PROSE_WORDS: ReadonlySet<string> = new Set([
  "and",
  "as",
  "do",
  "fun",
  "had",
  "has",
  "have",
  "he",
  "here",
  "hi",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "not",
  "now",
  "of",
  "ok",
  "on",
  "one",
  "or",
  "said",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "too",
  "us",
  "wait",
  "was",
  "we",
  "well",
  "went",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

// The word-dot left token is prose, not part of a scrambled domain.
function isDotProseWord(value: string): boolean {
  return DOT_PROSE_WORDS.has(value);
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
      const match = re.exec(haystack);
      if (!match) continue;
      // A bare word "dot" between a prose word and a TLD reads as a phrase,
      // not a domain: "read the dot com intro". Delimited placeholders
      // ((dot)/[dot]) and punctuation forms (.., ", dot,") are always
      // obfuscation, so only the delimiter-free branch is prose-gated.
      // match[0] opens with the left token, and a delimiter-free match is
      // exactly "<token> dot <tld>", so its first word is that token.
      if (
        name === "dot_obfuscation" &&
        match[1].trim().toLowerCase() === "dot" &&
        isDotProseWord(match[0].split(/\s/)[0])
      ) {
        continue;
      }
      // A sentence boundary reads the same shape as a torn domain
      // ("wait. io games are fun"). The left token before the space-dot is
      // the sentence's last word; when that is an everyday word, this is
      // prose. Genuine tears use a hostname as the left half. match[0] is
      // "<left>. <tld>", so its first word — minus the trailing dot — is the
      // left token.
      if (
        name === "spaced_tld" &&
        SPACED_TLD_PROSE_WORDS.has(match[0].split(/\s/)[0].replace(/\.$/, ""))
      ) {
        continue;
      }
      return { hit: true, pattern: name, field: fieldName };
    }
  }
  return null;
}

// Email addresses trip the bare-domain rule, which is correct (the
// filter exists to stop contact-harvesting spam) but the old wording
// only said "URLs", so a submitter reading it did not know their own
// address was the problem. #631 sat for days on exactly that confusion.
export const URL_BLOCKED_REASON =
  "Links and email addresses are not allowed in this field. Use the credit URL field for links.";
