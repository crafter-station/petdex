// Multi-pet squad preview for collection cards. Replaces the single
// cover sprite with 4-6 pets distributed across the card so it reads
// as a curated set at a glance — not a tidy line-up but not chaos
// either. Sizes and positions are derived deterministically from the
// pet's slug so the layout is stable across renders (no React key
// flicker, SSR/client agree) but feels hand-arranged.
//
// Why deterministic over Math.random(): hydration mismatches if the
// server picks one offset and the client picks another; a slug-derived
// pseudo-hash gives both sides the same answer without coordination.

import { petPreviewUrlForSource } from "@/lib/pet-preview";

import { PetSprite } from "@/components/pet-sprite";

export type CollectionCoverPet = {
  slug: string;
  displayName: string;
  spritesheetPath: string;
};

type CollectionCoverProps = {
  pets: CollectionCoverPet[];
  /** Slug to render largest and most prominent. Falls back to first pet. */
  coverSlug: string | null;
  /** Max sprites rendered. Defaults to 5 (works on mobile). */
  max?: number;
  /** Base sprite scale; lead is rendered larger via the layout below. */
  scale?: number;
  className?: string;
};

// Cheap deterministic hash so a given slug always lands at the same
// horizontal/vertical jitter and size. Same hash on server + client.
function hashSlug(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Map a hash to a value in [0, 1) without bias the way `% 1000 / 1000`
// would. Good enough for visual variety.
function frac(h: number, salt: number): number {
  const x = Math.sin(h * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function CollectionCover({
  pets,
  coverSlug,
  max = 5,
  scale = 0.55,
  className = "",
}: CollectionCoverProps) {
  if (pets.length === 0) {
    return (
      <div
        className={`pet-sprite-stage relative grid aspect-[16/9] place-items-center overflow-hidden ${className}`}
      >
        <span className="font-mono text-xs tracking-[0.18em] text-muted-3 uppercase">
          Collection
        </span>
      </div>
    );
  }

  // Lead pet up front; everyone else dedup'd and trimmed.
  const coverPet = coverSlug
    ? (pets.find((p) => p.slug === coverSlug) ?? null)
    : null;
  const otherPets = pets.filter((p) => p.slug !== coverPet?.slug);
  const lineup = (coverPet ? [coverPet, ...otherPets] : otherPets).slice(
    0,
    max,
  );

  if (lineup.length === 1) {
    const pet = lineup[0];
    const previewSrc = petPreviewUrlForSource(pet.slug, pet.spritesheetPath);
    return (
      <div
        className={`pet-sprite-stage relative grid aspect-[16/9] place-items-center overflow-hidden ${className}`}
      >
        <PetSprite
          src={previewSrc ?? pet.spritesheetPath}
          layout={previewSrc ? "row" : "atlas"}
          state="idle"
          cycleStates={!previewSrc}
          scale={scale * 1.5}
          label={`${pet.displayName} animated`}
        />
      </div>
    );
  }

  // Layout: distribute pets across X axis in even slots, then nudge each
  // pet's Y position based on its slug hash so they don't all sit on
  // one baseline. Lead pet gets the center slot and the largest scale;
  // the rest fan out around it with slightly smaller scales picked
  // deterministically.
  const n = lineup.length;
  const ordered = (() => {
    if (n <= 1) return lineup;
    // Center the lead and alternate the rest left/right around it so the
    // composition feels balanced regardless of count.
    const [lead, ...rest] = lineup;
    const middle = Math.floor((n - 1) / 2);
    const arranged: typeof lineup = [];
    for (let i = 0; i < n; i++) arranged.push(lead);
    arranged[middle] = lead;
    let leftCursor = middle - 1;
    let rightCursor = middle + 1;
    let toggle = true;
    for (const pet of rest) {
      if (toggle && leftCursor >= 0) {
        arranged[leftCursor--] = pet;
      } else if (rightCursor < n) {
        arranged[rightCursor++] = pet;
      } else if (leftCursor >= 0) {
        arranged[leftCursor--] = pet;
      }
      toggle = !toggle;
    }
    return arranged;
  })();

  // Distribute pets across the inner X band so the leftmost and
  // rightmost don't kiss the rounded card edge. We map slot indices
  // [0..n-1] into [innerLeft, innerRight] of the card width.
  const innerLeft = 8; // %
  const innerRight = 92; // %
  const innerSpan = innerRight - innerLeft;

  return (
    // overflow-visible so a sprite that's slightly bigger than its
    // computed slot can still fully render — neighbors lap each other
    // a little instead of being clipped at the slot edge. The card's
    // own rounded-3xl border in the parent still keeps the bleed
    // from leaving the card visually (it's a tight fit, not a flood).
    <div
      className={`pet-sprite-stage relative aspect-[16/9] overflow-hidden ${className}`}
    >
      {ordered.map((pet, i) => {
        const isLead =
          pet.slug === lineup[0].slug && i === Math.floor((n - 1) / 2);
        const h = hashSlug(pet.slug);
        const previewSrc = petPreviewUrlForSource(
          pet.slug,
          pet.spritesheetPath,
        );

        // Compute slot center inside the inner band. The first/last pets
        // sit at innerLeft / innerRight respectively; the middle ones
        // are evenly distributed between.
        const t = n === 1 ? 0.5 : i / (n - 1);
        const xCenter = innerLeft + innerSpan * t;

        // Vertical jitter: ±10% from the visual middle. Lead sits a
        // touch lower (0.55) so it anchors the eye.
        const yJitter = (frac(h, 1) - 0.5) * 0.2; // -0.1 .. +0.1
        const yCenter = isLead ? 0.55 : 0.5 + yJitter;

        // Size jitter: lead is largest but capped so it can't outgrow
        // the card's vertical room; others are gently varied.
        const sizeJitter = isLead ? 1.3 : 0.9 + frac(h, 2) * 0.25;
        const petScale = scale * sizeJitter;

        // Z order: lead always in front. Others alternate front/back
        // by hash, so neighbors never both end up at the exact same
        // depth and the overlap reads as intentional.
        const zIndex = isLead ? n + 10 : 5 + Math.floor(frac(h, 3) * n);

        return (
          <div
            key={pet.slug}
            className="pointer-events-none absolute flex items-center justify-center"
            style={{
              left: `${xCenter}%`,
              top: `${yCenter * 100}%`,
              transform: "translate(-50%, -50%)",
              zIndex,
              // Wider than the strict slot so big sprites never hit a
              // hard clip — adjacent slots can lap each other and the
              // composition reads as a layered group, not a row.
              width: `${(innerSpan / Math.max(n - 1, 1)) * 1.4}%`,
              height: "100%",
            }}
          >
            <PetSprite
              src={previewSrc ?? pet.spritesheetPath}
              layout={previewSrc ? "row" : "atlas"}
              state="idle"
              cycleStates={!previewSrc}
              scale={petScale}
              label={`${pet.displayName} animated`}
            />
          </div>
        );
      })}
    </div>
  );
}
