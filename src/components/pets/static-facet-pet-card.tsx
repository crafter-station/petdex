import Link from "next/link";
import type { CSSProperties } from "react";

import { formatBatchLabel, getBatchKey } from "@/lib/dex-batch";
import { formatLocalizedNumber } from "@/lib/format-number";
import type { SearchPet } from "@/lib/pet-search";
import { petStates } from "@/lib/pet-states";
import { cn } from "@/lib/utils";

import { StaticPetSprite } from "@/components/pets/static-pet-sprite";

type StaticFacetPetCardProps = {
  pet: SearchPet;
  index: number;
  locale: string;
};

export function StaticFacetPetCard({
  pet,
  index,
  locale,
}: StaticFacetPetCardProps) {
  const isZh = locale === "zh";
  const dexNumber = pet.dexNumber ?? index + 1;
  const dexLabel =
    dexNumber < 1000
      ? dexNumber.toString().padStart(3, "0")
      : dexNumber.toString();
  const { installCount } = pet.metrics;
  const href = `/pets/${pet.slug}`;
  const formattedInstallCount = formatLocalizedNumber(installCount, locale);
  const batchLabel = pet.approvedAt
    ? formatBatchLabel(getBatchKey(new Date(pet.approvedAt)))
    : null;
  const accentStyle = pet.dominantColor
    ? ({ "--pet-accent": pet.dominantColor } as CSSProperties)
    : undefined;
  const spriteState =
    petStates[hashString(pet.spritesheetPath) % petStates.length];

  return (
    <article
      data-slot="card"
      style={accentStyle}
      className="toy-shell group relative flex h-full flex-col overflow-hidden rounded-2xl! border border-[#D4DCF4] transition duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-1 hover:border-[#3B59F2]/45 dark:border-white/12 dark:hover:border-[#8CA3FF]/45"
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute top-3 left-1/2 h-[3px] w-24 -translate-x-1/2 rounded-full transition-opacity ${
          pet.dominantColor ? "opacity-80 group-hover:opacity-100" : "opacity-0"
        }`}
        style={
          pet.dominantColor
            ? { backgroundColor: "var(--pet-accent)" }
            : undefined
        }
      />
      <Link
        href={href}
        prefetch={false}
        aria-label={`Open ${pet.displayName}`}
        className="flex flex-1 flex-col rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#D4DCF4]/70 px-4 pt-3.5 pb-2.5 dark:border-white/10">
          <span className="rounded-lg border border-[#D4DCF4] bg-white/85 px-2 py-0.5 font-hardware text-[10px] tracking-[0.14em] text-[#101944]/80 uppercase shadow-xs dark:border-white/12 dark:bg-[#101944]/80 dark:text-[#CBD4EE]">
            No. {dexLabel}
          </span>
          {pet.featured ? (
            <span
              title="Featured"
              className="toy-tag rounded-md bg-toy-volt px-1.5 py-0.5 font-bold text-[#101944] text-[10px] leading-none shadow-[0_2px_0_#C9A91F]"
            >
              ★ FEATURED
            </span>
          ) : null}
        </div>

        <div
          className="pet-sprite-stage relative flex items-center justify-center overflow-hidden px-5 py-6"
          style={
            pet.dominantColor
              ? {
                  backgroundImage:
                    "radial-gradient(ellipse at center, color-mix(in oklab, var(--pet-accent) 22%, transparent) 0%, transparent 75%)",
                }
              : undefined
          }
        >
          <StaticPetSprite
            src={pet.spritesheetPath}
            state={spriteState.id}
            scale={0.7}
            label={`${pet.displayName} sprite`}
          />
          {installCount > 0 ? (
            <span className="pointer-events-none absolute right-4 bottom-2 font-hardware text-[9px] tracking-[0.16em] text-muted-3 uppercase">
              {formattedInstallCount} install
              {installCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-2 border-t border-[#D4DCF4]/70 px-4 pt-3.5 pb-4 dark:border-white/10">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-1.5 font-heading text-lg font-bold tracking-tight text-foreground">
              <span className="truncate">{pet.displayName}</span>
              {pet.featured ? (
                <span
                  title="Featured"
                  className="font-hardware text-[10px] text-toy-cobalt dark:text-[#8CA3FF]"
                >
                  ★
                </span>
              ) : null}
            </h3>
            <span className="font-hardware text-[10px] tracking-[0.14em] text-muted-3 uppercase">
              {pet.kind}
            </span>
          </div>
          <p
            className={cn(
              "line-clamp-2 text-sm text-muted-2",
              isZh ? "leading-tight" : "leading-6",
            )}
          >
            {pet.description}
          </p>
          {batchLabel ? (
            <span className="inline-flex h-5 w-fit items-center justify-center rounded-full border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 font-mono text-[10px] text-muted-2 tracking-[0.12em] uppercase dark:border-white/[0.1] dark:bg-white/[0.04]">
              {batchLabel}
            </span>
          ) : null}
          {pet.vibes.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {pet.vibes.map((vibe) => (
                <span
                  key={vibe}
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  #{vibe}
                </span>
              ))}
            </div>
          ) : null}
          {pet.source === "discover" ? (
            <span className="inline-flex h-5 w-fit items-center justify-center rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] text-chip-warning-fg tracking-[0.12em] uppercase ring-1 ring-chip-warning-fg/20">
              Discovered
            </span>
          ) : null}
          {pet.submittedBy ? (
            <div className="mt-2 flex items-center gap-1.5 border-t border-black/[0.05] pt-2 font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase dark:border-white/[0.05]">
              by {pet.submittedBy.name}
            </div>
          ) : null}
        </div>
      </Link>
    </article>
  );
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}
