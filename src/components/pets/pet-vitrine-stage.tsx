"use client";

import Image from "next/image";
import type * as React from "react";
import { useState } from "react";

import { Hand, Monitor, Moon } from "lucide-react";

import { type PetStateId, petStates } from "@/lib/pet-states";
import { cn } from "@/lib/utils";

import { PetFloater } from "@/components/pets/pet-floater";
import { PetSprite } from "@/components/pets/pet-sprite";
import { Button } from "@/components/ui/button";

type StageSurface = "desktop" | "pearl" | "navy";

const AGENT_SCENARIOS: {
  id: string;
  agent: string;
  logo?: string;
  state: PetStateId;
  bubble: string;
  badge?: string;
}[] = [
  {
    id: "claude-input",
    agent: "Claude Code",
    logo: "/brand/agents/claude-code.svg",
    state: "waiting",
    bubble: "Ready to run tests on your branch?",
    badge: "INPUT",
  },
  {
    id: "codex-work",
    agent: "Codex",
    logo: "/brand/agents/codex.svg",
    state: "running",
    bubble: "Shipping changes and verifying build...",
  },
  {
    id: "gemini-happy",
    agent: "Gemini CLI",
    logo: "/brand/agents/gemini.svg",
    state: "jumping",
    bubble: "All checks green. Ready to deploy!",
  },
  {
    id: "idle-chill",
    agent: "Idle",
    state: "idle",
    bubble: "Hanging out on your desktop while you think.",
  },
];

type PetVitrineStageProps = {
  src: string;
  petName: string;
  dexNumber: string | null;
  kind?: string;
  utilitySlot?: React.ReactNode;
};

export function PetVitrineStage({
  src,
  petName,
  dexNumber,
  kind,
  utilitySlot,
}: PetVitrineStageProps) {
  const [activeState, setActiveState] = useState<PetStateId>("idle");
  const [surface, setSurface] = useState<StageSurface>("desktop");
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [roaming, setRoaming] = useState(false);

  const currentScenario = AGENT_SCENARIOS[scenarioIdx] ?? AGENT_SCENARIOS[0];
  const activeStateInfo =
    petStates.find((s) => s.id === activeState) ?? petStates[0];

  function applyScenario(index: number) {
    setRoaming(false);
    setScenarioIdx(index);
    const next = AGENT_SCENARIOS[index];
    if (next) {
      setActiveState(next.state);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="toy-shell relative flex flex-col justify-between overflow-hidden rounded-3xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {dexNumber ? (
              <span className="toy-tag rounded-lg bg-[#EEF2FF] px-2.5 py-1 text-[#2943CC] dark:bg-[#3B59F2]/25 dark:text-[#9BB0FF]">
                #{dexNumber}
              </span>
            ) : null}
            {kind ? (
              <span className="toy-tag rounded-lg bg-[#FFE259]/40 px-2.5 py-1 text-[#101944] dark:bg-[#FFE259]/20 dark:text-[#FFE259]">
                {kind}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-xl border border-[#D4DCF4] bg-white/85 p-1 dark:border-white/12 dark:bg-white/5">
              {(
                [
                  ["desktop", "Desktop"],
                  ["pearl", "Pearl"],
                  ["navy", "Navy"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSurface(id)}
                  className={cn(
                    "cursor-pointer rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    surface === id
                      ? "bg-[#3B59F2] text-white shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {utilitySlot}

            <Button
              type="button"
              variant={roaming ? "volt" : "pearl"}
              size="icon-sm"
              onClick={() => setRoaming((prev) => !prev)}
              aria-pressed={roaming}
              title="Let pet roam on screen"
              className="hidden md:inline-flex"
            >
              <Hand className="size-3.5" />
            </Button>
          </div>
        </div>

        <div
          className={cn(
            "relative my-4 flex min-h-[290px] flex-col items-center justify-center overflow-hidden rounded-2xl border p-6 transition-colors duration-300",
            surface === "desktop" &&
              "border-[#C8D4F5] bg-[radial-gradient(circle_at_50%_0%,#E6EEFF_0%,#F6F8FF_55%,#ECEFFF_100%)] dark:border-white/12 dark:bg-[radial-gradient(circle_at_50%_0%,#22306E_0%,#111730_65%,#0B0F22_100%)]",
            surface === "pearl" &&
              "border-[#D8E0F6] bg-white dark:border-white/10 dark:bg-[#171C32]",
            surface === "navy" && "border-[#2B3D8F] bg-[#101944] text-white",
          )}
        >
          {surface === "desktop" ? (
            <div className="pointer-events-none absolute inset-x-4 top-3 flex items-center justify-between text-[10px] font-medium text-[#5A6794] dark:text-[#8F9DC9]">
              <span className="flex items-center gap-1.5">
                <Monitor className="size-3" />
                Live Desktop Preview
              </span>
              <span className="font-mono opacity-80">127.0.0.1:7777</span>
            </div>
          ) : null}

          <div className="mb-4 w-full max-w-[272px] rounded-2xl border border-[#D4DCF4] bg-gradient-to-b from-white to-[#F5F7FF] px-3.5 py-2.5 text-left text-[#101944] shadow-[0_2px_0_#D5DDF5,0_10px_24px_rgb(16_25_68/0.12)]">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-bold text-[#273573]">
                {currentScenario.logo ? (
                  <Image
                    src={currentScenario.logo}
                    alt=""
                    width={14}
                    height={14}
                    aria-hidden="true"
                    className="size-3.5 shrink-0 object-contain"
                  />
                ) : (
                  <Moon className="size-3.5 shrink-0 text-[#5A6794]" />
                )}
                {currentScenario.agent}
              </span>
              {currentScenario.badge ? (
                <span className="rounded-md bg-[#FFE259] px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-[#101944]">
                  {currentScenario.badge}
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-snug text-[#46517A]">
              {currentScenario.bubble}
            </p>
          </div>

          <div className="flex min-h-[140px] items-center justify-center py-1">
            {roaming ? (
              <p className="text-center font-mono text-xs text-muted-foreground">
                {petName} is roaming your screen — drag or click Roam to return.
              </p>
            ) : (
              <PetSprite
                src={src}
                state={activeState}
                scale={0.78}
                layout="atlas"
                label={`${petName} ${activeStateInfo.label}`}
              />
            )}
          </div>

          <div
            className={cn(
              "mt-3 flex items-center gap-2 rounded-full px-3 py-1 text-[11px]",
              surface === "navy"
                ? "bg-white/10 text-white/90"
                : "bg-[#101944]/6 text-[#384473] dark:bg-white/10 dark:text-white/80",
            )}
          >
            <span className="font-mono font-semibold uppercase">
              {activeStateInfo.label}
            </span>
            <span className="opacity-60">·</span>
            <span className="opacity-85">{activeStateInfo.purpose}</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>Simulate coding agent event</span>
            <span className="font-mono">{petStates.length} states</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_SCENARIOS.map((sc, idx) => (
              <Button
                key={sc.id}
                type="button"
                size="sm"
                variant={scenarioIdx === idx && !roaming ? "cobalt" : "pearl"}
                onClick={() => applyScenario(idx)}
              >
                {sc.logo ? (
                  <Image
                    src={sc.logo}
                    alt=""
                    width={14}
                    height={14}
                    aria-hidden="true"
                    className="size-3.5 shrink-0 object-contain"
                  />
                ) : (
                  <Moon className="size-3.5 shrink-0" />
                )}
                {sc.agent}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="toy-shell rounded-3xl p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-sm font-bold text-foreground">
            Animation States
          </h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            Click any state to inspect live
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
          {petStates.map((st) => {
            const isSelected = st.id === activeState && !roaming;
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => {
                  setRoaming(false);
                  setActiveState(st.id);
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border p-2 text-center transition-all",
                  isSelected
                    ? "border-[#3B59F2] bg-[#EEF2FF] text-[#2943CC] shadow-[0_2px_0_#3B59F2] dark:bg-[#3B59F2]/25 dark:text-white"
                    : "border-[#D4DCF4]/80 bg-white/75 text-muted-foreground hover:border-[#3B59F2]/40 hover:text-foreground dark:border-white/10 dark:bg-white/5",
                )}
              >
                <div className="flex h-11 items-center justify-center">
                  <PetSprite
                    src={src}
                    state={st.id}
                    scale={0.24}
                    layout="atlas"
                    label={st.label}
                  />
                </div>
                <span className="text-[10px] font-semibold leading-tight">
                  {st.label}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {roaming ? <PetFloater src={src} petName={petName} /> : null}
    </div>
  );
}
