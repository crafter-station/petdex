// Server-render-friendly, animation-free variant of PetSprite. Used in
// list contexts where rendering many sprites at once (leaderboard rows,
// owner mini-grids) would tank scroll perf if every sprite ran a CSS
// step animation + paint.
//
// Renders the first frame of a selected state row by clamping
// background-position. No setInterval, no infinite keyframe — just a
// static crop that the browser paints once and is done with.

import type { CSSProperties } from "react";

import { defaultPetState, type PetStateId, petStates } from "@/lib/pet-states";

type StaticPetSpriteProps = {
  src: string;
  state?: PetStateId;
  scale?: number;
  /** Required: the fallback used to be the English literal "Pet", which
   *  every locale's screen reader heard. Call sites pass a translated
   *  name. */
  label: string;
  className?: string;
};

export function StaticPetSprite({
  src,
  state = defaultPetState.id,
  scale = 1,
  label,
  className = "",
}: StaticPetSpriteProps) {
  const spriteState =
    petStates.find((item) => item.id === state) ?? defaultPetState;

  return (
    <div
      className={`pet-sprite-frame ${className}`}
      role="img"
      aria-label={label}
      style={{ "--pet-scale": scale } as CSSProperties}
    >
      <div
        className="pet-sprite-static"
        style={
          {
            "--sprite-url": `url(${src})`,
            "--sprite-row": spriteState.row,
          } as CSSProperties
        }
      />
    </div>
  );
}
