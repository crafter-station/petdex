// DEAD CODE (verified 2026-10): no file in src/ or scripts/ imports this module — its VIBE_COPY/KIND_COPY appear nowhere else. The facets render their copy from the i18n messages instead. Delete it (or wire it) in an upstream decision; do not extend it.

// Per-vibe and per-kind copy. Each landing gets unique intro + title so it
// doesn't look like one templated page repeated 15 times — that's what
// Google flags as doorway / thin pages.

import type { PetKind, PetVibe } from "@/lib/types";

export type FacetCopy = {
  title: string;
  intro: string;
  metaDescription: string;
};

export const VIBE_COPY: Record<PetVibe, FacetCopy> = {
  cozy: {
    title: "Cozy Codex pets",
    intro:
      "Companions that radiate warm-blanket energy: soft poses, gentle blinks, and quiet idle states. Pick one to keep your terminal feeling like a Sunday afternoon.",
    metaDescription:
      "Cozy animated pixel pets for Codex. Soft, calming companions you can install with one command.",
  },
  calm: {
    title: "Calm Codex pets",
    intro:
      "Steady, low-key companions for focused sessions. Their idle animations breathe instead of bounce. Easy on the eyes during long debugging stretches.",
    metaDescription:
      "Calm pixel pets for Codex. Low-motion animated companions for deep work.",
  },
  playful: {
    title: "Playful Codex pets",
    intro:
      "Bouncy, mischievous companions that refuse to sit still. Expect tail wags, spins, and unexpected cameos in the middle of your prompt.",
    metaDescription:
      "Playful animated companions for Codex. Bouncy, animated pixel art you can install with one command.",
  },
  cheerful: {
    title: "Cheerful Codex pets",
    intro:
      "The optimists of the index. Bright color palettes, smiling sprites, and idle states that look genuinely happy you opened the terminal.",
    metaDescription:
      "Cheerful Codex pets. Bright, smiling animated companions installable with one command.",
  },
  focused: {
    title: "Focused Codex pets",
    intro:
      "Companions in deep work mode. Headphones, monitors, and concentrated stares. They want to ship the feature with you.",
    metaDescription:
      "Focused Codex pets. Concentrated, deep-work companions for Codex.",
  },
  mischievous: {
    title: "Mischievous Codex pets",
    intro:
      "The chaos faction. Sneaky idle poses, side-eye, and the suspicion that your linter errors are their fault.",
    metaDescription:
      "Mischievous Codex pets. Sneaky animated pixel companions for your terminal.",
  },
  heroic: {
    title: "Heroic Codex pets",
    intro:
      "Capes, stances, and saving-the-day energy. These pets believe in you and your unmerged PR.",
    metaDescription:
      "Heroic Codex pets. Brave, animated pixel companions installable with one command.",
  },
  edgy: {
    title: "Edgy Codex pets",
    intro:
      "Darker palettes, sharper silhouettes, attitude turned up. For when your terminal needs a little more bite.",
    metaDescription:
      "Edgy Codex pets. Bold, animated pixel companions for Codex.",
  },
  mystical: {
    title: "Mystical Codex pets",
    intro:
      "Moons, sparkles, robes. Companions that feel like they know the answer before the model does.",
    metaDescription:
      "Mystical Codex pets. Magical animated pixel companions for Codex.",
  },
  wholesome: {
    title: "Wholesome Codex pets",
    intro:
      "Pure-hearted companions. Big eyes, small gestures, the kind of pet you'd write home about. Hard to dislike.",
    metaDescription:
      "Wholesome Codex pets. Sweet animated pixel companions installable with one command.",
  },
  chaotic: {
    title: "Chaotic Codex pets",
    intro:
      "Maximum energy, minimum predictability. Their states cycle in ways that feel slightly off, in a good way.",
    metaDescription:
      "Chaotic Codex pets. High-energy animated pixel companions for Codex.",
  },
  melancholic: {
    title: "Melancholic Codex pets",
    intro:
      "Pensive, soft, a little wistful. Companions for the part of the night when the build keeps failing.",
    metaDescription:
      "Melancholic Codex pets. Pensive animated pixel companions for Codex.",
  },
};

export const KIND_COPY: Record<PetKind, FacetCopy> = {
  creature: {
    title: "Codex creature pets",
    intro:
      "Animals, critters, and made-up beasts. The biggest collection in the index. Most contributors start here: otters, capybaras, foxes, things with too many legs.",
    metaDescription:
      "Animated creature pets for Codex. Otters, capybaras, foxes and more, installable with one command.",
  },
  object: {
    title: "Codex object pets",
    intro:
      "Pets that aren't alive but absolutely have personality. Paperclips, mugs, ice cream scoops: the inanimate companions that earned a soul.",
    metaDescription:
      "Codex object pets. Animated pixel companions made from everyday objects.",
  },
  character: {
    title: "Codex character pets",
    intro:
      "Humanoids, mascots, fictional figures. Original characters and homages, all in 9-state pixel form.",
    metaDescription:
      "Animated character pets for Codex. Humanoid pixel companions installable with one command.",
  },
};
