"use client";

import { type CSSProperties, memo } from "react";

import { type PetStateId, petStates } from "@/lib/pet-states";

type PetSpriteLayout = "atlas" | "row";

type PetSpriteProps = {
  src: string;
  state?: PetStateId;
  scale?: number;
  label?: string;
  className?: string;
  /**
   * "atlas" reads a row out of the full spritesheet (the canonical asset).
   * "row" treats `src` as a single pre-cropped frame strip (preview.webp),
   * so the strip is the whole image and the animation walks its only row.
   * Both render with pure CSS — no React state, no extra network probes.
   */
  layout?: PetSpriteLayout;
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

const ATLAS_SHEET_WIDTH = 1536;
const ATLAS_SHEET_HEIGHT = 1872;

function PetSpriteImpl({
  src,
  state = "idle",
  scale = 1,
  label,
  className = "",
  layout = "atlas",
  cycleStates = false,
}: PetSpriteProps) {
  const fixedAnimation =
    petStates.find((item) => item.id === state) ?? petStates[0];
  const animation = cycleStates
    ? petStates[hashString(src) % petStates.length]
    : fixedAnimation;

  // A row strip only carries a single animation row, so it always plays
  // row 0 and the sheet is exactly one frame strip wide/tall.
  const isRow = layout === "row";
  const spriteRow = isRow ? 0 : animation.row;
  const sheetWidth = isRow ? animation.frames * 192 : ATLAS_SHEET_WIDTH;
  const sheetHeight = isRow ? 208 : ATLAS_SHEET_HEIGHT;

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
            "--sprite-url": `url("${src.replace(/"/g, '\\"')}")`,
            "--sprite-row": spriteRow,
            "--sprite-frames": animation.frames,
            "--sprite-duration": `${animation.durationMs}ms`,
            "--sprite-sheet-width": `${sheetWidth}px`,
            "--sprite-sheet-height": `${sheetHeight}px`,
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
