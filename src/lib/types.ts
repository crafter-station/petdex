export type ApprovalState = "approved" | "needs-review" | "needs-repair";

import type { ColorFamily } from "@/lib/color-families";

export type PetKind = "creature" | "object" | "character";

export type PetVibe =
  | "cozy"
  | "calm"
  | "playful"
  | "cheerful"
  | "focused"
  | "mischievous"
  | "heroic"
  | "edgy"
  | "mystical"
  | "wholesome"
  | "chaotic"
  | "melancholic";

export type PetCredit = {
  name: string;
  url?: string;
  imageUrl?: string;
};

export type PetSource = "submit" | "discover" | "claimed";
export type SpriteVersionNumber = 1 | 2;

export type PetdexPet = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  petJsonPath: string;
  /** R2 URL to the pet's zip pack (always set after the curated backfill). */
  zipUrl?: string;
  spriteVersionNumber: SpriteVersionNumber;
  soundUrl: string | null;
  approvalState: ApprovalState;
  featured?: boolean;
  kind: PetKind;
  vibes: PetVibe[];
  tags: string[];
  dominantColor: string | null;
  colorFamily: ColorFamily | null;
  submittedBy?: PetCredit;
  /**
   * How the pet entered the catalog. 'submit' = uploaded through the
   * regular flow. 'discover' = added by an admin on behalf of the
   * original author. 'claimed' = was 'discover' and the author has
   * since claimed it. UI shows a small chip when 'discover'.
   */
  source: PetSource;
  approvedAt: string | null;
  importedAt: string;
  qa: {
    contactSheetPath?: string;
  };
};

export const PET_KINDS: PetKind[] = ["creature", "object", "character"];

export const PET_VIBES: PetVibe[] = [
  "cozy",
  "calm",
  "playful",
  "cheerful",
  "focused",
  "mischievous",
  "heroic",
  "edgy",
  "mystical",
  "wholesome",
  "chaotic",
  "melancholic",
];
