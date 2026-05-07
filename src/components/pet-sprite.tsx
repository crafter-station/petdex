"use client";

import { type CSSProperties, memo, useEffect, useMemo, useState } from "react";

import { type PetStateId, petStates } from "@/lib/pet-states";

type PetSpriteProps = {
  src: string;
  state?: PetStateId;
  scale?: number;
  label?: string;
  className?: string;
  cycleStates?: boolean;
  cycleIntervalMs?: number;
};

function PetSpriteImpl({
  src,
  state = "idle",
  scale = 1,
  label,
  className = "",
  cycleStates = false,
  cycleIntervalMs = 1800,
}: PetSpriteProps) {
  const initialCycleIndex = useMemo(
    () => hashString(src) % petStates.length,
    [src],
  );
  const [cycleIndex, setCycleIndex] = useState(initialCycleIndex);
  const fixedAnimation =
    petStates.find((item) => item.id === state) ?? petStates[0];
  const animation = cycleStates ? petStates[cycleIndex] : fixedAnimation;

  useEffect(() => {
    if (!cycleStates) {
      return;
    }

    const interval = window.setInterval(() => {
      setCycleIndex((current) => (current + 1) % petStates.length);
    }, cycleIntervalMs);

    return () => window.clearInterval(interval);
  }, [cycleIntervalMs, cycleStates]);

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
