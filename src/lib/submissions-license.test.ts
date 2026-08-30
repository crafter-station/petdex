import { describe, expect, it } from "bun:test";

import { DEFAULT_R2_PUBLIC_BASE } from "@/lib/r2-public-url";
import {
  COMMERCIAL_PET_LICENSES,
  isPetLicenseChoice,
  PET_LICENSE_CHOICES,
  validateSubmission,
} from "@/lib/submissions-validation";

// Asset URLs are derived from the R2 base the validator trusts, so this
// fixture keeps working if the bucket ever moves.
const asset = (name: string) => `${DEFAULT_R2_PUBLIC_BASE}/${name}`;

const validBody = {
  zipUrl: asset("pet.zip"),
  spritesheetUrl: asset("pet.webp"),
  petJsonUrl: asset("pet.json"),
  displayName: "Boba",
  description: "A test pet.",
  petId: "boba",
  spritesheetWidth: 1536,
  spritesheetHeight: 1872,
};

describe("license gate", () => {
  it("accepts a submission with no license (pre-license CLI)", () => {
    expect(validateSubmission({ ...validBody })).toBeNull();
  });

  it("accepts every declared license choice", () => {
    for (const license of PET_LICENSE_CHOICES) {
      expect(validateSubmission({ ...validBody, license })).toBeNull();
    }
  });

  it("rejects a license that was sent but is not a real choice", () => {
    const result = validateSubmission({
      ...validBody,
      license: "mit" as never,
    });
    expect(result?.ok).toBe(false);
    expect(result && "error" in result && result.error).toBe("invalid_license");
  });

  it("rejects 'unspecified' as something a creator can declare", () => {
    // It describes pets that predate the field, not a grant anyone makes.
    expect(isPetLicenseChoice("unspecified")).toBe(false);
    const result = validateSubmission({
      ...validBody,
      license: "unspecified" as never,
    });
    expect(result?.ok).toBe(false);
  });
});

describe("commercial licenses", () => {
  it("only lists licenses that permit commercial use", () => {
    expect([...COMMERCIAL_PET_LICENSES]).toEqual(["cc0", "cc-by", "cc-by-sa"]);
  });

  it("excludes non-commercial and reserved licenses", () => {
    const commercial = new Set<string>(COMMERCIAL_PET_LICENSES);
    expect(commercial.has("cc-by-nc")).toBe(false);
    expect(commercial.has("all-rights-reserved")).toBe(false);
    expect(commercial.has("unspecified")).toBe(false);
  });

  it("keeps every commercial license a declarable choice", () => {
    for (const license of COMMERCIAL_PET_LICENSES) {
      expect(isPetLicenseChoice(license)).toBe(true);
    }
  });
});
