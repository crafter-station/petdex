"use client";

import { useState } from "react";

import { Play } from "lucide-react";
import { useTranslations } from "next-intl";

import { defaultPetState, type PetStateId, petStates } from "@/lib/pet-states";

import { PetSprite } from "@/components/pets/pet-sprite";
import { StaticPetSprite } from "@/components/pets/static-pet-sprite";

type PetStateViewerProps = {
  src: string;
  petName: string;
};

export function PetStateViewer({ src, petName }: PetStateViewerProps) {
  const t = useTranslations("petStateViewer");
  const [selectedState, setSelectedState] = useState<PetStateId>(
    defaultPetState.id,
  );
  const activeState =
    petStates.find((state) => state.id === selectedState) ?? defaultPetState;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(280px,420px)_1fr]">
      <section className="rounded-2xl border border-border-base bg-surface/60 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.18em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-foreground">
              {t(`states.${activeState.id}.label`)}
            </h2>
          </div>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-3 text-[12px] font-medium text-muted-2 backdrop-blur">
            <Play className="size-3.5" />
            {t("frames", { count: activeState.frames })}
          </span>
        </div>

        <div className="pet-checkerboard mt-4 flex min-h-64 items-center justify-center rounded-xl border border-border-base">
          <PetSprite
            src={src}
            state={activeState.id}
            scale={1.2}
            label={t("animationLabel", {
              petName,
              state: t(`states.${activeState.id}.label`),
            })}
          />
        </div>

        <p className="mt-3 text-sm leading-6 text-muted-2">
          {t(`states.${activeState.id}.purpose`)}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {petStates.map((state) => (
          <button
            key={state.id}
            type="button"
            onClick={() => setSelectedState(state.id)}
            aria-pressed={selectedState === state.id}
            className={`rounded-xl border p-4 text-left backdrop-blur transition ${
              selectedState === state.id
                ? "border-brand/40 bg-brand/10"
                : "border-border-base bg-surface/60 hover:bg-surface-muted"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t(`states.${state.id}.label`)}
                </p>
                <p className="mt-1 text-xs text-muted-3">
                  {t("rowFrames", { row: state.row, count: state.frames })}
                </p>
              </div>
              <div className="rounded-lg border border-border-base bg-surface-muted p-2">
                <StaticPetSprite
                  src={src}
                  state={state.id}
                  scale={0.32}
                  label={t("spriteLabel", {
                    petName,
                    state: t(`states.${state.id}.label`),
                  })}
                />
              </div>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}
