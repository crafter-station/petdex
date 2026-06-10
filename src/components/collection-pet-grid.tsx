"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "next-intl";

import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import { useHeaderState } from "@/components/header-state-provider";
import { PetCard } from "@/components/pet-gallery";

const PAGE_SIZE = 24;

type Props = {
  pets: PetWithMetrics[];
  dexMap: Record<string, number>;
  caughtSlugs?: string[];
};

export function CollectionPetGrid({ pets, dexMap, caughtSlugs = [] }: Props) {
  const isZh = useLocale() === "zh";
  const { state } = useHeaderState();
  const [pageCount, setPageCount] = useState(1);
  const activeCaughtSlugs = state.signedIn ? state.caught : caughtSlugs;
  const caughtSet = useMemo(
    () => new Set(activeCaughtSlugs),
    [activeCaughtSlugs],
  );

  const slice = useMemo(
    () => pets.slice(0, pageCount * PAGE_SIZE),
    [pets, pageCount],
  );
  const hasMore = slice.length < pets.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setPageCount((p) => p + 1);
      },
      { rootMargin: "800px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore]);

  if (pets.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
        This collection has no approved pets yet.
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
          isZh ? "md:gap-3" : "md:gap-5",
        )}
      >
        {slice.map((pet, index) => (
          <PetCard
            key={pet.slug}
            pet={pet}
            index={index}
            dexNumber={dexMap[pet.slug] ?? null}
            caught={caughtSet.has(pet.slug)}
          />
        ))}
      </div>

      {hasMore ? (
        <div
          ref={sentinelRef}
          aria-hidden="true"
          className="flex h-24 items-center justify-center text-xs text-muted-3"
        >
          Loading more pets…
        </div>
      ) : pets.length > PAGE_SIZE ? (
        <p className="pt-4 text-center text-xs text-muted-3">
          End of collection · {pets.length} pets
        </p>
      ) : null}
    </>
  );
}
