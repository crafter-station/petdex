"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import { PetCard } from "@/components/pet-gallery";

const PAGE_SIZE = 24;

type Props = {
  pets: PetWithMetrics[];
  dexMap: Record<string, number>;
  caughtSlugs?: string[];
};

export function CollectionPetGrid({ pets, dexMap, caughtSlugs = [] }: Props) {
  const isZh = useLocale() === "zh";
  const t = useTranslations("collectionDetail");
  const [query, setQuery] = useState("");
  const [pageCount, setPageCount] = useState(1);
  const caughtSet = useMemo(() => new Set(caughtSlugs), [caughtSlugs]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return pets;
    return pets.filter((pet) =>
      pet.displayName.toLowerCase().includes(normalizedQuery),
    );
  }, [pets, normalizedQuery]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setPageCount(1);
  };

  const slice = useMemo(
    () => filtered.slice(0, pageCount * PAGE_SIZE),
    [filtered, pageCount],
  );
  const hasMore = slice.length < filtered.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setPageCount((p) => p + 1);
      },
      { rootMargin: "150px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore]);

  if (pets.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
        {t("empty")}
      </div>
    );
  }

  const showSearch = pets.length > PAGE_SIZE;

  return (
    <>
      {showSearch ? (
        <div className="relative mb-5">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            className="h-11 w-full rounded-2xl border border-border-base bg-surface/60 pr-10 pl-11 text-sm text-foreground outline-none placeholder:text-muted-3 focus:border-foreground/30"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label={t("clearSearchAria")}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 text-muted-3 hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
          {t("noResults", { query })}
        </div>
      ) : (
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
      )}

      {hasMore ? (
        <div
          ref={sentinelRef}
          aria-hidden="true"
          className="flex h-24 items-center justify-center text-xs text-muted-3"
        >
          {t("loadingMore")}
        </div>
      ) : filtered.length > PAGE_SIZE ? (
        <p className="pt-4 text-center text-xs text-muted-3">
          {t("endOfCollection", { count: filtered.length })}
        </p>
      ) : null}
    </>
  );
}
