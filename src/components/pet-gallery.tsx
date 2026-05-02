"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ChevronDown,
  Heart,
  Loader2,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";

import type { PetWithMetrics } from "@/lib/pets";
import { petStates } from "@/lib/pet-states";
import {
  PET_KINDS,
  PET_VIBES,
  type PetKind,
  type PetVibe,
} from "@/lib/types";

import { PetActionMenu } from "@/components/pet-action-menu";
import { PetSprite } from "@/components/pet-sprite";

type Facets = {
  kinds: Record<string, number>;
  vibes: Record<string, number>;
};

type SearchPayload = {
  pets: PetWithMetrics[];
  total: number;
  nextCursor: number | null;
  facets: Facets;
};

type PetGalleryProps = {
  initial: SearchPayload;
  totalPets: number;
};

type SortKey = "curated" | "popular" | "installed" | "alpha";

const SORT_LABELS: Record<SortKey, string> = {
  curated: "Curated",
  popular: "Most liked",
  installed: "Most installed",
  alpha: "Alphabetical",
};

const PAGE_SIZE = 24;

export function PetGallery({ initial, totalPets }: PetGalleryProps) {
  const [query, setQuery] = useState("");
  const [activeKinds, setActiveKinds] = useState<Set<PetKind>>(new Set());
  const [activeVibes, setActiveVibes] = useState<Set<PetVibe>>(new Set());
  const [sort, setSort] = useState<SortKey>("curated");

  const [pets, setPets] = useState<PetWithMetrics[]>(initial.pets);
  const [total, setTotal] = useState<number>(initial.total);
  const [nextCursor, setNextCursor] = useState<number | null>(
    initial.nextCursor,
  );
  const [facets, setFacets] = useState<Facets>(initial.facets);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const requestSeq = useRef(0);
  const stateCount = petStates.length;

  const buildParams = useCallback(
    (cursor: number) => {
      const p = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) p.set("q", trimmed);
      if (activeKinds.size > 0)
        p.set("kinds", [...activeKinds].join(","));
      if (activeVibes.size > 0)
        p.set("vibes", [...activeVibes].join(","));
      if (sort !== "curated") p.set("sort", sort);
      if (cursor > 0) p.set("cursor", String(cursor));
      p.set("limit", String(PAGE_SIZE));
      return p;
    },
    [query, activeKinds, activeVibes, sort],
  );

  // Re-fetch on filter / sort / query changes (debounced for the query).
  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoadingPage(true);
    const handle = window.setTimeout(async () => {
      try {
        const params = buildParams(0);
        const res = await fetch(`/api/pets/search?${params}`);
        const data = (await res.json()) as SearchPayload;
        if (seq !== requestSeq.current) return;
        setPets(data.pets);
        setTotal(data.total);
        setNextCursor(data.nextCursor);
        setFacets(data.facets);
      } catch {
        // soft-fail: keep whatever's already on screen
      } finally {
        if (seq === requestSeq.current) setLoadingPage(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [buildParams]);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || loadingMore || loadingPage) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const params = buildParams(nextCursor);
      const res = await fetch(`/api/pets/search?${params}`);
      const data = (await res.json()) as SearchPayload;
      if (seq !== requestSeq.current) return;
      setPets((prev) => [...prev, ...data.pets]);
      setNextCursor(data.nextCursor);
      setTotal(data.total);
    } catch {
      // ignore, sentinel will retry on next intersect
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, loadingPage, buildParams]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "400px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  const toggleKind = (kind: PetKind) =>
    setActiveKinds((c) => toggleSet(c, kind));
  const toggleVibe = (vibe: PetVibe) =>
    setActiveVibes((c) => toggleSet(c, vibe));

  const clearFilters = () => {
    setActiveKinds(new Set());
    setActiveVibes(new Set());
    setQuery("");
  };

  const filtersActive =
    activeKinds.size > 0 || activeVibes.size > 0 || query.length > 0;

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-[#6478f6] uppercase">
            Gallery — {totalPets} pets
          </p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-black md:text-5xl">
            Pick a companion
          </h2>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto lg:max-w-md">
          <label className="relative block w-full sm:flex-1">
            <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-4 text-stone-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pets, vibes"
              className="h-11 w-full rounded-full border border-black/10 bg-white pr-10 pl-11 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-black/40"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="-translate-y-1/2 absolute top-1/2 right-3 grid size-6 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
          <div className="relative shrink-0">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort pets"
              className="h-11 w-full cursor-pointer appearance-none rounded-full border border-black/10 bg-white pr-9 pl-4 text-sm text-stone-900 outline-none transition hover:border-black/30 focus:border-black/40 sm:w-auto sm:min-w-[170px]"
            >
              {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(
                ([key, label]) => (
                  <option key={key} value={key}>
                    Sort: {label}
                  </option>
                ),
              )}
            </select>
            <ChevronDown className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 size-4 text-stone-500" />
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-black/[0.08] bg-white/55 px-4 py-4 backdrop-blur md:px-5">
        <FilterGroup
          label="Kind"
          options={PET_KINDS}
          counts={facets.kinds}
          active={activeKinds}
          onToggle={(v) => toggleKind(v as PetKind)}
        />
        <FilterGroup
          label="Vibe"
          options={PET_VIBES}
          counts={facets.vibes}
          active={activeVibes}
          onToggle={(v) => toggleVibe(v as PetVibe)}
        />
        {filtersActive ? (
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] pt-3">
            <span className="font-mono text-[10px] tracking-[0.22em] text-stone-500 uppercase">
              {total} match
              {total === 1 ? "" : "es"}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="font-mono text-[10px] tracking-[0.18em] text-stone-500 uppercase transition hover:text-black"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div
        className={`grid gap-5 md:grid-cols-2 xl:grid-cols-3 ${
          loadingPage ? "opacity-60 transition" : ""
        }`}
      >
        {pets.map((pet, index) => (
          <PetCard
            key={pet.slug}
            pet={pet}
            index={index}
            stateCount={stateCount}
          />
        ))}
      </div>

      {pets.length === 0 && !loadingPage ? (
        <div className="rounded-2xl border border-dashed border-black/15 bg-white/70 p-10 text-center">
          <p className="text-sm font-medium text-stone-950">
            No pets match this view.
          </p>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-3 inline-flex h-9 items-center justify-center rounded-full border border-black/10 bg-white px-4 text-xs font-medium text-stone-700 transition hover:border-black/30"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {nextCursor != null ? (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-8"
          aria-hidden="true"
        >
          {loadingMore ? (
            <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
              <Loader2 className="size-3.5 animate-spin" />
              Loading more
            </span>
          ) : (
            <button
              type="button"
              onClick={loadMore}
              className="rounded-full border border-black/10 bg-white px-4 py-2 font-mono text-[11px] tracking-[0.12em] text-stone-700 uppercase transition hover:border-black/30"
            >
              Load more
            </button>
          )}
        </div>
      ) : pets.length > 0 ? (
        <p className="py-6 text-center font-mono text-[10px] tracking-[0.22em] text-stone-400 uppercase">
          End of gallery — {total} shown
        </p>
      ) : null}
    </section>
  );
}

type FilterGroupProps = {
  label: string;
  options: readonly string[];
  counts: Record<string, number>;
  active: Set<string>;
  onToggle: (value: string) => void;
};

function FilterGroup({
  label,
  options,
  counts,
  active,
  onToggle,
}: FilterGroupProps) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
      <p className="w-16 shrink-0 font-mono text-[10px] tracking-[0.22em] text-stone-500 uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((value) => {
          const count = counts[value] ?? 0;
          if (count === 0) return null;
          const isActive = active.has(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => onToggle(value)}
              aria-pressed={isActive}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-mono text-[11px] tracking-[0.08em] capitalize transition ${
                isActive
                  ? "border-black bg-black text-white"
                  : "border-black/10 bg-white text-stone-700 hover:border-black/30"
              }`}
            >
              <span>{value}</span>
              <span
                className={`text-[10px] ${
                  isActive ? "text-white/60" : "text-stone-400"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type PetCardProps = {
  pet: PetWithMetrics;
  index: number;
  stateCount: number;
};

function PetCard({ pet, index, stateCount }: PetCardProps) {
  const dexNumber = String(index + 1).padStart(3, "0");
  const { likeCount, installCount } = pet.metrics;
  const showMetrics = likeCount > 0 || installCount > 0;
  const href = `/pets/${pet.slug}`;

  return (
    <article
      className={`group relative flex cursor-pointer flex-col rounded-3xl border bg-white/76 backdrop-blur transition-all duration-300 ease-out hover:-translate-y-1 hover:bg-white hover:shadow-xl hover:shadow-blue-950/10 ${
        pet.featured
          ? "border-[#6478f6]/45 shadow-[0_0_0_1px_rgba(100,120,246,0.18),0_18px_45px_-22px_rgba(82,102,234,0.5)]"
          : "border-black/10 shadow-sm shadow-blue-950/5"
      }`}
    >
      <Link
        href={href}
        aria-label={`Open ${pet.displayName}`}
        className="absolute inset-0 z-10 rounded-3xl"
      />

      <div className="relative z-20 flex items-center justify-between rounded-t-3xl border-b border-black/[0.06] px-5 pt-4 pb-3">
        <span className="font-mono text-[11px] tracking-[0.22em] text-stone-500 uppercase">
          No. {dexNumber}
        </span>
        <div className="flex items-center gap-2">
          {pet.featured ? (
            <span className="font-mono text-[10px] tracking-[0.22em] text-[#5266ea] uppercase">
              ★ Featured
            </span>
          ) : null}
          <PetActionMenu
            pet={{
              slug: pet.slug,
              displayName: pet.displayName,
              zipUrl: pet.zipUrl,
              description: pet.description,
            }}
          />
        </div>
      </div>

      <div
        className="relative z-0 flex items-center justify-center overflow-hidden px-5 py-6"
        style={{
          background:
            "radial-gradient(circle at 50% 38%, rgba(255,255,255,0.95) 0%, rgba(238,241,255,0.55) 55%, transparent 80%)",
        }}
      >
        <PetSprite
          src={pet.spritesheetPath}
          cycleStates
          scale={0.7}
          label={`${pet.displayName} animated`}
        />
        <span className="pointer-events-none absolute right-5 bottom-2 font-mono text-[10px] tracking-[0.22em] text-stone-400 uppercase">
          {stateCount} states
        </span>
      </div>

      <div className="relative z-0 flex flex-col gap-2 rounded-b-3xl border-t border-black/[0.06] px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold tracking-tight text-stone-950">
            {pet.displayName}
          </h3>
          <span className="font-mono text-[10px] tracking-[0.18em] text-stone-400 uppercase">
            {pet.kind}
          </span>
        </div>
        <p className="line-clamp-2 text-sm leading-6 text-stone-600">
          {pet.description}
        </p>
        {pet.vibes.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {pet.vibes.map((vibe) => (
              <span
                key={vibe}
                className="font-mono text-[10px] tracking-[0.12em] text-stone-500 uppercase"
              >
                #{vibe}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-black/[0.05] pt-3">
          {pet.submittedBy ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-stone-500 uppercase">
              {pet.submittedBy.imageUrl ? (
                // biome-ignore lint/performance/noImgElement: external avatar URLs
                <img
                  src={pet.submittedBy.imageUrl}
                  alt=""
                  className="size-4 rounded-full ring-1 ring-black/10"
                />
              ) : null}
              by {pet.submittedBy.name}
            </span>
          ) : (
            <span />
          )}
          {showMetrics ? (
            <span className="flex items-center gap-3 font-mono text-[10px] tracking-[0.12em] text-stone-500 uppercase">
              {likeCount > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <Heart className="size-3" />
                  {compactNumber(likeCount)}
                </span>
              ) : null}
              {installCount > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <TerminalSquare className="size-3" />
                  {compactNumber(installCount)}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function compactNumber(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
