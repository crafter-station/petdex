import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `generateMetadata` runs outside the render tree, so a page can be fully
// translated in its body while its `<title>`, description, and social card
// stay English — which is what `/download` did: the visible page was localized
// and the metadata under it was not, so a /es or /zh visitor got an English
// tab title and an English unfurl.
//
// This is a source scan rather than a render: the pages are server components
// that need the Next request context, and what matters is the shape — a
// metadata field assigned an English literal instead of `t(...)`.

const LOCALE_DIR = join(import.meta.dir, "..", "app", "[locale]");

const FIELDS = [
  "title",
  "description",
  "ogTitle",
  "ogDescription",
  "twitterTitle",
];

/** Every `page.tsx` and `not-found.tsx` under `[locale]`, at any depth. */
async function pageFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "page.tsx" || entry.name === "not-found.tsx")
        found.push(path);
    }
  }
  await walk(LOCALE_DIR);
  return found;
}

/** The body of `generateMetadata`, or null when the page has none. */
function metadataBody(source: string): string | null {
  const start = source.indexOf("export async function generateMetadata");
  if (start === -1) return null;
  const rest = source.slice(start);
  // Close on a `}` that is alone on its line. The previous `indexOf("\n}")`
  // matched the `}) {` that ends a multi-line parameter destructure, so every
  // page written that way was scanned only down to its own signature — 19 of
  // the 25 pages, leaving their metadata unchecked.
  const close = rest.match(/^}$/m);
  return close?.index === undefined ? rest : rest.slice(0, close.index + 1);
}

/**
 * The value expression beginning at `from`, up to the `,`/`;`/`}` that closes
 * it at bracket depth zero. Multi-line aware, and string-aware so a comma
 * inside a quoted string does not end it early.
 *
 * This replaces a line-by-line regex, which missed a value written on the next
 * line (`title:\n  "English"`) — a real bypass, since the field and its value
 * are only a single expression, not a single line.
 */
function valueExpression(text: string, from: number): string {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  let depth = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) break;
  }
  return text.slice(start, i);
}

/** True when the expression is a call to a translator (`t(...)`, `tMeta(...)`). */
function isTranslatorCall(expr: string): boolean {
  return /^\s*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*\(/.test(expr);
}

/**
 * A string literal in `expr` carrying English prose — the thing that should
 * have come from the messages. Interpolations (`${…}`) are values, not prose,
 * so they are removed before the check; a value that is only interpolations is
 * legitimate.
 */
function proseLiteral(expr: string): string | null {
  for (const match of expr.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
    const raw = match[2].replace(/\$\{[^}]*\}/g, "");
    if (raw.length >= 4 && /[A-Za-z]{2,}/.test(raw)) return raw;
  }
  return null;
}

/** `const NAME = <expr>` / `NAME = <expr>` definitions, by identifier. */
function constExpressions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g,
  )) {
    const name = match[1];
    const at = (match.index ?? 0) + match[0].length;
    out.set(name, valueExpression(source, at));
  }
  return out;
}

/**
 * The prose literal a metadata field's value resolves to, following one level
 * of identifier indirection (`title: TITLE` where `const TITLE = "English"`).
 * Returns null when the value is translated or carries no prose.
 */
function offendingLiteral(
  expr: string,
  consts: Map<string, string>,
  seen = 0,
): string | null {
  if (isTranslatorCall(expr)) return null;
  const direct = proseLiteral(expr);
  if (direct) return direct;
  // A bare identifier may name a const defined outside the function.
  const ident = expr.trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (ident && seen < 2) {
    const referenced = consts.get(ident[1]);
    if (referenced !== undefined) {
      return offendingLiteral(referenced, consts, seen + 1);
    }
  }
  return null;
}

describe("page metadata is localized", () => {
  test("no generateMetadata assigns an English literal to a metadata field", async () => {
    // Scans the metadata fields of `generateMetadata` and reports any whose
    // value expression carries English prose. A value read from the messages
    // (`t("…")`, `tMeta("…", {…})`) is clean, and so is a template made only of
    // interpolations (`\`${pet.displayName}\``) — that is a translated or
    // content value being placed, not an English sentence.
    //
    // This walks value expressions rather than lines. The previous version
    // matched one line at a time, which missed a value written on the next line
    // (`title:\n  "English"`) — verified as a bypass before this was fixed —
    // and would have needed one regex per line-shape to catch up.
    const offenders: string[] = [];
    for (const file of await pageFiles()) {
      const source = readFileSync(file, "utf8");
      const body = metadataBody(source);
      if (!body) continue;
      const consts = constExpressions(source);
      // Both `title: <expr>` and `const title = <expr>`.
      const pattern = new RegExp(
        `\\b(?:const\\s+)?(${FIELDS.join("|")})\\s*(?::|=)(?!=)`,
        "g",
      );
      for (const match of body.matchAll(pattern)) {
        const field = match[1];
        const expr = valueExpression(
          body,
          (match.index ?? 0) + match[0].length,
        );
        const prose = offendingLiteral(expr, consts);
        if (!prose) continue;
        const rel = file.slice(LOCALE_DIR.length + 1);
        offenders.push(`${rel} ${field} → ${JSON.stringify(prose)}`);
      }
    }
    expect(
      offenders,
      "Metadata is rendered per locale, so a hardcoded English string here " +
        "shows on /es and /zh too. Move it into the messages and read it " +
        "with `getTranslations`. Offenders: " +
        offenders.join("; "),
    ).toEqual([]);
  });

  test("the scanner catches the shapes a line-based regex missed", () => {
    // These are the forms the earlier line-scanning version did not match, plus
    // the ones it did. Kept as fixtures so the scan cannot silently narrow
    // back to the easy shapes.
    //
    // Each entry is source text for the scanner to read, so the ones carrying
    // an interpolation are built with a substituted placeholder rather than
    // written as `"${name}"`: a plain string containing `${` is a lint error
    // (`noTemplateCurlyInString`) because it is almost always a mistake, and
    // here it is the opposite — the `${` is the thing under test.
    const N = "{name}";
    const consts = constExpressions('const OUTSIDE = "Petdex creator page";');
    const cases: Array<[string, string]> = [
      ['title: "English sentence",', "inline double-quoted"],
      ["title: 'English sentence',", "inline single-quoted"],
      ["title: `English sentence`,", "inline template"],
      ['title:\n      "English sentence",', "value on the next line"],
      ['title: "Petdex " + name,', "string concatenation"],
      [`const title = \`English $${N} sentence\`;`, "hoisted const"],
      ["title: OUTSIDE,", "identifier defined outside"],
      ['title: t("some.key"),', "translated — must not flag"],
      [`title: \`$${N}\`,`, "interpolation only — must not flag"],
      ['title: t("key", { name }),', "translated with value — must not flag"],
      ["description: someVar,", "a variable — must not flag"],
      // The exact shape `/pets/[slug]` shipped: a value glued to hardcoded
      // English. This is the defect, so it must be flagged.
      [`title: \`$${N}: Animated Codex pet\`,`, "value plus English suffix"],
    ];
    for (const [code, label] of cases) {
      const expr = valueExpression(code, code.search(/[:=](?!=)/) + 1);
      const prose = offendingLiteral(expr, consts);
      const shouldFlag = !label.includes("must not flag");
      expect(prose !== null, `${label}: ${JSON.stringify(code)}`).toBe(
        shouldFlag,
      );
    }
  });

  test("the pages whose metadata was hardcoded read it from messages", () => {
    // The three regressions this guard was widened for. `/pets/[slug]` built
    // `title` from a template literal, and `/u/[handle]` and
    // `/collections/[slug]` did the same inline — all English on /es and /zh.
    const expectations: Array<[string, string]> = [
      [join(LOCALE_DIR, "pets", "[slug]", "page.tsx"), "pet.metadata"],
      [join(LOCALE_DIR, "u", "[handle]", "page.tsx"), "profile.metadata"],
      [
        join(LOCALE_DIR, "collections", "[slug]", "page.tsx"),
        "collectionDetail.metadata",
      ],
    ];
    for (const [file, namespace] of expectations) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain(`namespace: "${namespace}"`);
    }
  });

  test("the download page reads its metadata from messages", () => {
    // The specific regression this file was written for.
    const source = readFileSync(
      join(LOCALE_DIR, "download", "page.tsx"),
      "utf8",
    );
    expect(source).toContain(
      'getTranslations({ locale, namespace: "download.metadata" })',
    );
    expect(source).not.toContain('title: "Download Petdex Desktop"');
  });
});
