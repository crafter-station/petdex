import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gallery card's footer bar is the row of like / install / download /
// share buttons under every pet. Its accessible names were English template
// literals — `Like ${displayName}`, `Copy install for ${displayName}`,
// `Download ${displayName}`, `Share ${displayName}` — so a screen reader on
// /es or /zh announced them in English, and `title` showed the same English
// tooltip on hover.
//
// They are the same defect class the `pet-gallery.tsx` scan already covers,
// but in a different file, so that scan never saw them. The interpolation is
// also why the attribute-literal scan in `pet-gallery-labels.test.ts` cannot:
// the string is not quoted, it is a template.

const FOOTERS = [
  join(import.meta.dir, "pet-card-footer.tsx"),
  join(import.meta.dir, "pet-card-footer-auth.tsx"),
];

/** The English words these footers shipped in their labels. */
const ENGLISH_LABEL =
  /`(?:\$\{[^}]*\}\s*)?(Like|Unlike|Copy install|Download|Share)\b|`(?:Like|Unlike|Copy install|Download|Share)\s/;

describe("the card footer's accessible names are translated", () => {
  for (const file of FOOTERS) {
    const name = file.split("/").pop() as string;

    test(`${name} has no interpolated English label`, () => {
      const source = readFileSync(file, "utf8");
      const offenders: string[] = [];
      source.split("\n").forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/(aria-label|title)=/.test(line)) return;
        if (ENGLISH_LABEL.test(line)) {
          offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      });
      expect(
        offenders,
        "These render on /es and /zh, so they must come from the `gallery` " +
          "messages via `t()`. Offenders: " +
          offenders.join("; "),
      ).toEqual([]);
    });

    test(`${name} reads its labels from the gallery namespace`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('useTranslations("gallery")');
      for (const key of [
        "likePet",
        "copyInstallFor",
        "downloadPet",
        "sharePet",
      ]) {
        expect(source, key).toContain(`t("${key}"`);
      }
    });
  }

  test("the auth footer names the unlike state separately", () => {
    // The toggle reads "Unlike" once liked, so it needs its own key rather
    // than reusing `likePet` for both states.
    const source = readFileSync(FOOTERS[1], "utf8");
    expect(source).toContain('t("unlikePet"');
    expect(source).not.toMatch(/\$\{liked \? "Unlike" : "Like"\}/);
  });

  test("the sound button's default label is not an English literal", () => {
    const source = readFileSync(
      join(import.meta.dir, "pet-sound-button.tsx"),
      "utf8",
    );
    // The default was the parameter default `labelPrefix = "Play sound for"`,
    // so every caller that did not override it announced English.
    expect(source).not.toContain('labelPrefix = "Play sound for"');
    expect(source).toContain('t("playSoundFor"');
  });
});
