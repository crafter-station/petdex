import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The repo root, derived from this module's own location rather than from
 * `process.cwd()`.
 *
 * Every path below is built from it, so the check and its test behave the same
 * whether they are run from the repo root or a subdirectory. Resolving against
 * the cwd made `bun test src/i18n/messages-parse.test.ts` run from inside
 * `src/` find no sources at all.
 *
 * Reads the filesystem, so nothing that ships to the browser may import it.
 * Only `scripts/i18n-check.ts` and `src/i18n/messages-parse.test.ts` do.
 */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Message paths that a call site reads with `t.raw(...)`.
 *
 * ICU reads an angle-bracketed name as a rich-text tag, so a message meaning
 * `<slug>` as a literal placeholder throws `UNCLOSED_TAG` the moment a plain
 * `t("key")` formats it — and use-intl answers a thrown message by rendering
 * the key itself. `t.raw` returns the message without parsing it, which is
 * what these four need.
 *
 * The list is explicit rather than collected by scanning the sources. A scan
 * has to guess which namespace a key belongs to — a `t.raw("faq.items.install.a")`
 * in a file whose translator is bound to `about` means
 * `about.faq.items.install.a`, and the call text does not say so — and the
 * only available guess, matching on a dotted suffix, exempts every unrelated
 * key that happens to end the same way. Four entries a reviewer can read beat
 * a heuristic that silently widens. Adding a `t.raw` call site makes the check
 * fail naming the key it needs, which is the intended nudge.
 */
export const RAW_MESSAGE_PATHS: readonly string[] = [
  "about.faq.items.install.a",
  "docsPage.placeholders.path",
  "docsPage.placeholders.petName",
  "docsPage.placeholders.yourPetName",
];

/**
 * Every `.ts`/`.tsx` file under the directories that hold translator call
 * sites, as paths relative to the repo root.
 */
export function sourceFiles(): string[] {
  const out: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, relative), {
      withFileTypes: true,
    })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(next);
      else if (/\.tsx?$/.test(entry.name)) out.push(next);
    }
  };
  for (const dir of ["src/app", "src/components", "src/lib"]) visit(dir);
  return out;
}

/** Read a file by its repo-relative path, independent of the cwd. */
export function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** The opening of a `t.raw(` call: the callee, any spacing, the quote. */
const RAW_CALL_OPENER = /\bt\.raw\(\s*(["'`])/g;

/**
 * The key of every `t.raw(...)` call site in one file's source.
 *
 * Positions are found on the blanked text so a mention in prose cannot match,
 * but the literal itself is read from the original source — blanking preserves
 * offsets and leaves the opening quote in place, so the key is recoverable from
 * where the masked match points.
 */
export function rawCallKeysIn(source: string): string[] {
  const masked = codeOnly(source);
  const keys: string[] = [];
  for (const match of masked.matchAll(RAW_CALL_OPENER)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    const quote = match[1];
    let end = start + 1;
    while (end < source.length) {
      const ch = source[end];
      if (ch === "\\") {
        end += 2;
        continue;
      }
      if (ch === quote) break;
      if (quote !== "`" && ch === "\n") break;
      end++;
    }
    keys.push(source.slice(start + 1, end));
  }
  return keys;
}

/**
 * The index just past the string literal that opens at `start` with `quote`.
 *
 * Stops at the end of the line for `'` and `"` so an apostrophe in prose — a
 * JSX text node saying "don't" — cannot blank the rest of the file, and at the
 * end of the source for an unterminated literal.
 */
function endOfString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== "`" && ch === "\n") return i;
    i++;
  }
  return source.length;
}

/**
 * The source with comments and string bodies blanked to spaces, offsets
 * preserved.
 *
 * The call-site scan runs over this rather than over raw text, because a
 * `t.raw("key")` in prose is indistinguishable from one in code. The doc
 * comment on `RAW_MESSAGE_PATHS` names a call site for exactly that reason:
 * matched against raw text it satisfies the cross-check below, which hides a
 * deleted call site and lets the exemption go stale in silence.
 *
 * Blanking rather than deleting keeps every offset where it was, so a match
 * found here still resolves against the original text — which is what lets the
 * key be read back out. Quotes and backticks are left in place and only the
 * bodies between them are blanked, so a masked `t.raw("…")` still shows its
 * opening quote at the offset the real literal starts at.
 *
 * Template literals are blanked whole, `${}` substitutions included: keeping
 * the substitution live would need brace-depth tracking to know where the
 * literal resumes, and a `t.raw` call written inside one is not a call site
 * this check has any reason to see.
 */
export function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) out[j] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const stop = endOfString(source, i, ch);
      blank(i + 1, stop - 1);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}
