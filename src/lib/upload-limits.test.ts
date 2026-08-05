import { describe, expect, it } from "bun:test";

import { PET_ASSET_MAX_BYTES, PET_ASSET_MAX_LABEL } from "@/lib/upload-limits";

import en from "@/i18n/messages/en.json";
import es from "@/i18n/messages/es.json";
import zh from "@/i18n/messages/zh.json";

describe("pet asset upload limits", () => {
  it("keeps owner edit upload copy aligned with the shared pet asset limit", () => {
    expect(PET_ASSET_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(PET_ASSET_MAX_LABEL).toBe("8 MB");

    expect(en.myPets.edit.fileTooBig).toContain(PET_ASSET_MAX_LABEL);
    expect(es.myPets.edit.fileTooBig).toContain(PET_ASSET_MAX_LABEL);
    expect(zh.myPets.edit.fileTooBig).toContain(PET_ASSET_MAX_LABEL);
  });
});
