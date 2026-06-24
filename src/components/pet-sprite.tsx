"use client";

import { type CSSProperties, memo, useEffect, useState } from "react";

import { type PetStateId, petStates } from "@/lib/pet-states";

type PetSpriteLayout = "atlas" | "row";

type PetSpriteProps = {
  src: string;
  fallbackSrc?: string;
  state?: PetStateId;
  scale?: number;
  label?: string;
  className?: string;
  layout?: PetSpriteLayout;
  fallbackLayout?: PetSpriteLayout;
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
  fallbackSrc,
  state = "idle",
  scale = 1,
  label,
  className = "",
  layout = "atlas",
  fallbackLayout = "atlas",
  cycleStates = false,
}: PetSpriteProps) {
  const [resolved, setResolved] = useState({ src, layout });

  useEffect(() => {
    setResolved({ src, layout });
    if (!fallbackSrc) return;

    let cancelled = false;
    const image = new window.Image();
    image.onload = () => {
      if (!cancelled) setResolved({ src, layout });
    };
    image.onerror = () => {
      if (!cancelled) {
        setResolved({ src: fallbackSrc, layout: fallbackLayout });
      }
    };
    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, fallbackSrc, layout, fallbackLayout]);

  const fixedAnimation =
    petStates.find((item) => item.id === state) ?? petStates[0];
  const animation = cycleStates
    ? petStates[hashString(src) % petStates.length]
    : fixedAnimation;
  const spriteRow = resolved.layout === "row" ? 0 : animation.row;
  const sheetWidth = resolved.layout === "row" ? animation.frames * 192 : 1536;
  const sheetHeight = resolved.layout === "row" ? 208 : 1872;

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
            "--sprite-url": `url("${resolved.src.replace(/"/g, '\\"')}")`,
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
