"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import { PetCard } from "@/components/pets/pet-gallery";
import { Button } from "@/components/ui/button";

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
      <div className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-10 text-center text-sm text-muted-2 dark:border-white/12">
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
            className="h-11 w-full rounded-xl border border-[#D4DCF4] bg-surface/80 pr-10 pl-11 text-sm text-foreground outline-none placeholder:text-muted-3 focus:border-[#3B59F2] focus:ring-2 focus:ring-[#3B59F2]/20 dark:border-white/12"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onQueryChange("")}
              aria-label={t("clearSearchAria")}
              className="absolute top-1/2 right-2.5 -translate-y-1/2"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-10 text-center text-sm text-muted-2 dark:border-white/12">
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
