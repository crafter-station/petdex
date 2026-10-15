import en from "../src/i18n/messages/en.json";
import es from "../src/i18n/messages/es.json";
import zh from "../src/i18n/messages/zh.json";
import {
  findMissingKeys,
  findPlaceholderMismatches,
  findUnformattableMessages,
  type JsonObject,
} from "../src/lib/i18n-message-compare";
import {
  RAW_MESSAGE_PATHS,
  rawCallKeysIn,
  readSource,
  sourceFiles,
} from "../src/lib/i18n-raw-keys";

const checks = [
  { locale: "es", messages: es as JsonObject },
  { locale: "zh", messages: zh as JsonObject },
];

const failures = checks.flatMap(({ locale, messages }) =>
  findMissingKeys(en as JsonObject, messages).map((key) => `${locale}: ${key}`),
);

/**
 * The two directions that keep `RAW_MESSAGE_PATHS` honest, since it is a
 * hand-maintained list rather than a scan.
 *
 * `sourceFiles` walks the real tree instead of shelling out to `grep`, so it
 * cannot be silently emptied by running from the wrong directory, and
 * `rawCallKeysIn` reads each file through `codeOnly` so that a comment merely
 * mentioning `t.raw("x")` is not mistaken for a call site.
 */
const rawCallKeys = new Set<string>();
for (const file of sourceFiles()) {
  for (const key of rawCallKeysIn(readSource(file))) rawCallKeys.add(key);
}

/**
 * True when `fullPath` ends at `key` on a `.` boundary — `faq.items.install.a`
 * names `about.faq.items.install.a` when the translator is bound to `about`.
 * Used only to cross-check the explicit list, never to widen the exemption.
 */
function pathEndsWithKey(fullPath: string, key: string): boolean {
  return fullPath === key || fullPath.endsWith(`.${key}`);
}

const declared = new Set(RAW_MESSAGE_PATHS);

/** A `t.raw` call site the list does not cover — its message is unchecked. */
const undeclaredRawKeys = [...rawCallKeys].filter(
  (key) => ![...declared].some((path) => pathEndsWithKey(path, key)),
);

/** A listed path no `t.raw` call site reads — the exemption is stale. */
const unusedDeclaredPaths = [...declared].filter(
  (path) => ![...rawCallKeys].some((key) => pathEndsWithKey(path, key)),
);

const parseFailures = (
  [{ locale: "en", messages: en as JsonObject }, ...checks] as const
).flatMap(({ locale, messages }) =>
  findUnformattableMessages(messages, locale, declared),
);

const placeholderFailures = checks.flatMap(({ locale, messages }) =>
  findPlaceholderMismatches(en as JsonObject, messages, locale),
);

if (failures.length > 0) {
  console.error("Missing translation keys:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
}

if (parseFailures.length > 0) {
  console.error("Messages that a plain t() call cannot format:");
  for (const failure of parseFailures) {
    console.error(`- ${failure}`);
  }
  console.error(
    "\nA literal placeholder such as <slug> reads as a rich-text tag. Read it " +
      'with t.raw("key") at the call site, or wrap it in single quotes to ' +
      "escape it for ICU.",
  );
}

if (undeclaredRawKeys.length > 0) {
  console.error("t.raw call sites missing from RAW_MESSAGE_PATHS:");
  for (const key of undeclaredRawKeys) {
    console.error(`- ${key}`);
  }
  console.error(
    "\nAdd the message's full dotted path to RAW_MESSAGE_PATHS in " +
      "src/lib/i18n-raw-keys.ts, so the check knows this message is read " +
      "without parsing.",
  );
}

if (placeholderFailures.length > 0) {
  console.error("Placeholders that differ between locales:");
  for (const failure of placeholderFailures) {
    console.error(`- ${failure}`);
  }
  console.error(
    "\nA renamed placeholder throws MissingValueError at render time and " +
      "use-intl answers by printing the message key. Keep the names en uses; " +
      "a `plural`/`select` selector may be dropped only when the language " +
      "does not need it to choose a branch.",
  );
}

if (unusedDeclaredPaths.length > 0) {
  console.error("RAW_MESSAGE_PATHS entries no t.raw call site reads:");
  for (const path of unusedDeclaredPaths) {
    console.error(`- ${path}`);
  }
  console.error(
    "\nThe call site was probably removed. Drop the entry, or the message " +
      "stays unchecked for no reason.",
  );
}

if (
  failures.length > 0 ||
  parseFailures.length > 0 ||
  placeholderFailures.length > 0 ||
  undeclaredRawKeys.length > 0 ||
  unusedDeclaredPaths.length > 0
) {
  process.exit(1);
}

console.log("i18n keys are in sync.");
