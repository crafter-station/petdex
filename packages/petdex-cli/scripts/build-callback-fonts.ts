/**
 * Regenerates `src/cli-auth/lib/callback-fonts.ts`.
 *
 * Run from this package after the page's copy gains a character outside the
 * subset: the page would otherwise render that one character in the system
 * face, part-way through a sentence.
 *
 *   GEIST_PACKAGE_DIR=/path/to/unpacked/geist bun run scripts/build-callback-fonts.ts
 *
 * `GEIST_PACKAGE_DIR` is the `geist` npm package unpacked from its tarball
 * (`npm pack geist && tar xzf geist-*.tgz`), version 1.7.2 at the time of
 * writing. The subsetting itself needs Python with `fontTools` and `brotli`;
 * point `PYTHON` at that interpreter if it is not the default `python3`.
 * All of that is build-time only. The published CLI carries the finished
 * base64 strings and never runs this, and it is deliberately not a package
 * script so `bun run build` cannot depend on the tools being installed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The `geist` package's variable fonts, unpacked from its npm tarball. */
const GEIST_PACKAGE = process.env.GEIST_PACKAGE_DIR;
if (!GEIST_PACKAGE) {
  console.error("Set GEIST_PACKAGE_DIR to the unpacked `geist` npm package.");
  process.exit(1);
}

/** Interpreter holding `fontTools` and `brotli`. */
const PYTHON_BIN = process.env.PYTHON ?? "python3";

const SANS_SOURCE = join(
  GEIST_PACKAGE,
  "dist/fonts/geist-sans/Geist-Variable.woff2",
);
const MONO_SOURCE = join(
  GEIST_PACKAGE,
  "dist/fonts/geist-mono/GeistMono-Variable.woff2",
);

/**
 * Latin-1 plus the punctuation and combining marks the page can produce.
 *
 * Latin-1 in full rather than only the characters in today's copy: the detail
 * line renders text from the OAuth error response, so an accented character
 * outside this set would swap to the system face mid-sentence.
 */
const SANS_UNICODES = [
  "U+0020-007E", // printable ASCII
  "U+00A0-00FF", // Latin-1 supplement
  "U+0131", // dotless i
  "U+0152-0153", // OE, oe
  "U+02BC", // modifier apostrophe
  "U+02C6", // modifier circumflex
  "U+02DA", // ring above
  "U+02DC", // small tilde
  "U+0300-0301",
  "U+0303-0304",
  "U+0308-0309",
  "U+0323", // combining marks
  "U+2013-2014", // en dash, em dash
  "U+2018-201D", // curly quotes
  "U+2026", // ellipsis
  "U+2122", // trade mark
].join(",");

/** The mono face renders only the fixed `eyebrow` label, so ASCII is enough. */
const MONO_UNICODES = "U+0020-007E";

/** Weights the page uses: 400 body, 500 eyebrow, 600 headings. */
const WEIGHT_RANGE = "400:600";

/** Copyright, family, subfamily, unique, full, PostScript, OFL, licence URL. */
const NAME_IDS = "0,1,2,3,4,6,13,14";

/** The four features the page's Latin text needs; `*` would add about 20KB. */
const LAYOUT_FEATURES = "ccmp,liga,kern,locl";

/**
 * Subset and clamp the weight axis in one pass.
 *
 * Both steps are needed and pyftsubset cannot clamp the axis itself, so the
 * whole thing runs through fontTools' Python API rather than the CLI. The
 * order matters: instancing first would leave the subsetter resolving
 * variations for glyphs it is about to drop.
 */
const PYTHON = `
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

source, unicodes, features, name_ids, weight, out = sys.argv[1:7]
font = TTFont(source)
opts = subset.Options()
opts.flavor = None
opts.layout_features = features.split(",")
opts.hinting = False
opts.desubroutinize = True
opts.name_IDs = [int(n) for n in name_ids.split(",")]
opts.notdef_outline = True
subsetter = subset.Subsetter(options=opts)
subsetter.populate(unicodes=subset.parse_unicodes(unicodes))
subsetter.subset(font)
lo, hi = (int(v) for v in weight.split(":"))
instancer.instantiateVariableFont(
    font, {"wght": (lo, hi)}, inplace=True, updateFontNames=False
)
# fontTools stamps head.modified with the current time on save, which makes
# the output differ on every run. Pin it to the source font's own created
# value, which is fixed in the tarball.
font["head"].modified = font["head"].created
font.flavor = "woff2"
font.save(out)

# One difference survives that pin and cannot be removed: woff2's brotli
# compression is not byte-stable across fontTools or brotli versions, so
# head.checkSumAdjustment - a checksum over the compressed file - moves with
# it. Everything else, glyphs included, is byte-identical, and the two files
# render the same. Expect a non-empty diff on the head table when regenerating
# a toolchain change; compare the glyph set, not the bytes, before treating it
# as a real difference.
`;

const work = mkdtempSync(join(tmpdir(), "petdex-fonts-"));
try {
  const scriptPath = join(work, "subset.py");
  writeFileSync(scriptPath, PYTHON);

  const build = (source: string, unicodes: string, name: string): string => {
    const out = join(work, `${name}.woff2`);
    execFileSync(
      PYTHON_BIN,
      [
        scriptPath,
        source,
        unicodes,
        LAYOUT_FEATURES,
        NAME_IDS,
        WEIGHT_RANGE,
        out,
      ],
      {
        // fontTools walks glyph sets whose iteration order follows the hash
        // seed, so the same input otherwise produces a different (equivalent)
        // woff2 each run — and a diff that never settles. Pinning the seed makes
        // the output reproducible.
        env: { ...process.env, PYTHONHASHSEED: "0" },
      },
    );
    return readFileSync(out).toString("base64");
  };

  // Join with ` +`: adjacent string literals are not concatenated in
  // JavaScript the way they are in C, so a newline-separated list would bind
  // only the first line and silently discard the rest of the font.
  const wrap = (value: string) =>
    (value.match(/.{1,96}/g) ?? []).map((line) => `    "${line}"`).join(" +\n");

  const target = join(
    import.meta.dir,
    "..",
    "src",
    "cli-auth",
    "lib",
    "callback-fonts.ts",
  );
  // Keep the hand-written doc comment; replace only the two literals.
  const previous = readFileSync(target, "utf8");
  const header = previous.slice(0, previous.indexOf("export const"));

  writeFileSync(
    target,
    `${header}export const GEIST_SANS_WOFF2_BASE64 =\n` +
      `${wrap(build(SANS_SOURCE, SANS_UNICODES, "sans"))};\n\n` +
      `export const GEIST_MONO_WOFF2_BASE64 =\n` +
      `${wrap(build(MONO_SOURCE, MONO_UNICODES, "mono"))};\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
