"use client";

import { type CSSProperties, memo } from "react";

import { type PetStateId, petStates } from "@/lib/pet-states";

type PetSpriteProps = {
  src: string;
  state?: PetStateId;
  scale?: number;
  label?: string;
  className?: string;
  /**
   * When true, the rendered animation state is picked deterministically
   * from `src` so cards across the gallery look visually diverse without
   * any React state. Each pet always shows the same hashed state on
   * every render — no setInterval, no re-renders, no cascade.
   */
  cycleStates?: boolean;
  /**
   * Kept on the prop type for source compatibility with older call
   * sites. Has no effect since the cycling interval no longer exists.
   */
  cycleIntervalMs?: number;
};

function PetSpriteImpl({
  src,
  state = "idle",
  scale = 1,
  label,
  className = "",
  cycleStates = false,
}: PetSpriteProps) {
  const fixedAnimation =
    petStates.find((item) => item.id === state) ?? petStates[0];
  const animation = cycleStates
    ? petStates[hashString(src) % petStates.length]
    : fixedAnimation;

  return (
    <div
      className={`pet-sprite-frame ${className}`}
      role="img"
      aria-label={label ?? "Pet animation"}
      style={
        {
          "--pet-scale": scale,
        } as CSSProperties
      }
    >
      <div
        className="pet-sprite"
        style={
          {
            "--sprite-url": `url(${src})`,
            "--sprite-row": animation.row,
            "--sprite-frames": animation.frames,
            "--sprite-duration": `${animation.durationMs}ms`,
          } as CSSProperties
        }
      />
    </div>
  );
}

export const PetSprite = memo(PetSpriteImpl);

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}
