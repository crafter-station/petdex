"use client";

import { type CSSProperties, memo, useState } from "react";

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
  /**
   * Atlas spritesheet to fall back to when `src` fails to load. Derived
   * previews (preview.webp) are published out-of-band and can be missing
   * for a pet (#579); a CSS background 404s silently, so a hidden <img>
   * on the same URL detects the failure and swaps to the atlas instead
   * of leaving the card blank. The probe shares the browser cache with
   * the background fetch, so the happy path costs no extra request.
   */
  fallbackSrc?: string;
};

const ATLAS_SHEET_WIDTH = 1536;

/**
 * Which sprite to draw, and how, once the preview's success or failure is
 * known. Pure so it can be tested without a DOM: the component owns the
 * probe and the state, this owns the decision.
 */
export function resolveSprite({
  preferredSrc,
  fallbackSrc,
  failedSrc,
  preferredLayout,
  cycleStates,
}: {
  preferredSrc: string;
  fallbackSrc?: string;
  failedSrc: string | null;
  preferredLayout: PetSpriteLayout;
  cycleStates: boolean;
}) {
  const useFallback = fallbackSrc != null && failedSrc === preferredSrc;
  return {
    useFallback,
    src: useFallback ? fallbackSrc : preferredSrc,
    layout: useFallback ? ("atlas" as const) : preferredLayout,
    // Callers decide `cycleStates` from whether a preview URL exists, before
    // anyone knows the preview will 404 (pet-gallery.tsx passes
    // `cycleStates={!previewSrc}`). A card that falls back is in the same
    // position as one that never had a preview, so it cycles too — otherwise
    // recovered cards all freeze on `idle` while their neighbours vary.
    cycleStates: cycleStates || useFallback,
  };
}

function PetSpriteImpl({
  src: preferredSrc,
  state = "idle",
  scale = 1,
  label,
  className = "",
  layout: preferredLayout = "atlas",
  cycleStates: preferredCycleStates = false,
  fallbackSrc,
}: PetSpriteProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const { useFallback, src, layout, cycleStates } = resolveSprite({
    preferredSrc,
    fallbackSrc,
    failedSrc,
    preferredLayout,
    cycleStates: preferredCycleStates,
  });

  const fixedAnimation =
    petStates.find((item) => item.id === state) ?? petStates[0];
  const animation = cycleStates
    ? petStates[hashString(src) % petStates.length]
    : fixedAnimation;

  // A row strip only carries a single animation row, so it always plays
  // row 0 and the sheet is exactly one frame strip wide/tall. Height is
  // never forced — the CSS sizes the background by width only so both
  // classic 8x9 and v2 8x11 atlases keep their row offsets intact.
  const isRow = layout === "row";
  const spriteRow = isRow ? 0 : animation.row;
  const sheetWidth = isRow ? animation.frames * 192 : ATLAS_SHEET_WIDTH;

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
          } as CSSProperties
        }
      />
      {fallbackSrc != null && !useFallback ? (
        // biome-ignore lint/performance/noImgElement: invisible 404 probe on the raw preview URL; next/image would rewrite the URL and hide the failure
        <img
          src={preferredSrc}
          alt=""
          aria-hidden
          className="pointer-events-none absolute h-px w-px opacity-0"
          onError={() => setFailedSrc(preferredSrc)}
        />
      ) : null}
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
