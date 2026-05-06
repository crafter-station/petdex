"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { track } from "@vercel/analytics";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import { COLOR_FAMILIES, type ColorFamily } from "@/lib/color-families";
import { formatBatchLabel, getBatchKey } from "@/lib/dex-batch";
import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";
import { PET_KINDS, PET_VIBES, type PetKind, type PetVibe } from "@/lib/types";
import { isAllowedAvatarUrl } from "@/lib/url-allowlist";

import { PetActionMenu } from "@/components/pet-action-menu";
import { PetCardFooter } from "@/components/pet-card-footer";
import { PetSprite } from "@/components/pet-sprite";

type Facets = {
  kinds: Record<string, number>;
  vibes: Record<string, number>;
  colors: Record<ColorFamily, number>;
  batches: Array<{ key: string; label: string; count: number }>;
};

type SearchMode = "vibe" | "keyword" | "all";

type SearchPayload = {
  pets: PetWithMetrics[];
  total: number;
  nextCursor: number | null;
  searchMode?: SearchMode;
  facets: Facets;
};

type PetGalleryProps = {
  initial: SearchPayload;
  totalPets: number;
  caughtSlugs?: string[];
  /**
   * slug -> canonical dex number (ROW_NUMBER over approved_at). Built
   * once on the server for the whole approved catalog and shipped to
   * the client so every PetCard — including pets that arrive via the
   * /api/pets/search infinite-scroll — can show the right number
   * without a per-row lookup.
   */
  dexMap?: Record<string, number>;
};

type SortKey = "curated" | "popular" | "installed" | "alpha" | "recent";

const SORT_LABELS: Record<SortKey, string> = {
  curated: "Curated",
  recent: "Newest",
  popular: "Most liked",
  installed: "Most installed",
  alpha: "Alphabetical",
};

const PAGE_SIZE = 24;

const FAMILY_DOT: Record<ColorFamily, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  indigo: "#6366f1",
  purple: "#a855f7",
  pink: "#ec4899",
  brown: "#a16207",
  neutral: "#737373",
};

export function PetGallery({
  initial,
  totalPets,
  dexMap,
  caughtSlugs,
}: PetGalleryProps) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const [activeKinds, setActiveKinds] = useState<Set<PetKind>>(new Set());
  const [activeVibes, setActiveVibes] = useState<Set<PetVibe>>(new Set());
  const [activeColors, setActiveColors] = useState<Set<ColorFamily>>(new Set());
  const [activeBatches, setActiveBatches] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("curated");
  // The home page no longer ships caughtSlugs server-side — that would
  // make every SSR render per-visitor and kill ISR. When the prop is
  // missing we fetch /api/me/caught-slugs after hydration so the
  // "caught" highlight on PetCard still works for signed-in users
  // without holding up the static shell.
  const [hydratedCaught, setHydratedCaught] = useState<string[] | null>(null);
  useEffect(() => {
    if (caughtSlugs !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/caught-slugs");
        if (!res.ok) return;
        const data = (await res.json()) as { caught: string[] };
        if (!cancelled) setHydratedCaught(data.caught);
      } catch {
        /* anonymous viewers + offline fall through */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caughtSlugs]);
  const caughtSet = new Set(caughtSlugs ?? hydratedCaught ?? []);

  const [pets, setPets] = useState<PetWithMetrics[]>(initial.pets);
  const [total, setTotal] = useState<number>(initial.total);
  const [nextCursor, setNextCursor] = useState<number | null>(
    initial.nextCursor,
  );
  const [facets, setFacets] = useState<Facets>(initial.facets);
  const [searchMode, setSearchMode] = useState<SearchMode>(
    initial.searchMode ?? "all",
  );
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const requestSeq = useRef(0);
  const stateCount = petStates.length;

  const buildParams = useCallback(
    (cursor: number) => {
      const p = new URLSearchParams();
      if (trimmedQuery) p.set("q", trimmedQuery);
      if (activeKinds.size > 0) p.set("kinds", [...activeKinds].join(","));
      if (activeVibes.size > 0) p.set("vibes", [...activeVibes].join(","));
      if (activeColors.size > 0) p.set("colors", [...activeColors].join(","));
      if (activeBatches.size > 0) {
        p.set("batches", [...activeBatches].join(","));
      }
      if (sort !== "curated") p.set("sort", sort);
      if (cursor > 0) p.set("cursor", String(cursor));
      p.set("limit", String(PAGE_SIZE));
      return p;
    },
    [trimmedQuery, activeKinds, activeVibes, activeColors, activeBatches, sort],
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
        const mode = data.searchMode ?? "all";
        setSearchMode(mode);
        // Track only meaningful searches (skip the empty initial load
        // and very short typing). 'no_results' fires its own event
        // because it gates the request CTA — we want to know which
        // queries miss most often.
        if (trimmedQuery.length >= 4 && mode !== "all") {
          track("gallery_searched", {
            mode,
            length: trimmedQuery.length,
            results: data.total,
          });
          if (data.total === 0) {
            track("gallery_no_results", {
              query_length: trimmedQuery.length,
              mode,
            });
          }
        }
      } catch {
        // soft-fail: keep whatever's already on screen
      } finally {
        if (seq === requestSeq.current) setLoadingPage(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [buildParams, trimmedQuery]);

  useEffect(() => {
    if (!mobileFiltersOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileFiltersOpen]);

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
  const toggleColor = (color: ColorFamily) =>
    setActiveColors((c) => toggleSet(c, color));
  const toggleBatch = (batch: string) =>
    setActiveBatches((c) => toggleSet(c, batch));

  const clearFilters = () => {
    setActiveKinds(new Set());
    setActiveVibes(new Set());
    setActiveColors(new Set());
    setActiveBatches(new Set());
    setQuery("");
  };

  const filtersActive =
    activeKinds.size > 0 ||
    activeVibes.size > 0 ||
    activeColors.size > 0 ||
    activeBatches.size > 0 ||
    query.length > 0;
  const activeFilterCount =
    activeKinds.size +
    activeVibes.size +
    activeColors.size +
    activeBatches.size;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-brand-light uppercase">
            Gallery — {totalPets} pets
          </p>
          <h2 className="mt-1.5 text-3xl font-medium tracking-tight text-black md:text-4xl dark:text-stone-100">
            Pick a companion
          </h2>
        </div>
        {filtersActive ? (
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-stone-500 uppercase">
            <span>
              {total} match{total === 1 ? "" : "es"}
            </span>
            <button
              type="button"
              onClick={() => {
                track("filters_cleared");
                clearFilters();
              }}
              className="rounded-full border border-border-base bg-surface px-2.5 py-1 text-muted-2 transition hover:border-border-strong hover:text-black dark:hover:text-stone-100"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      {/* Unified control bar: search input takes full width, sort sits to the
 right, filter chips wrap below. Whole thing gets the same subtle
 shadow as the announcement modal so it reads as one cohesive
 surface and the search bar feels like a primary action. */}
      <div className="space-y-3 rounded-3xl border border-black/[0.06] bg-surface px-3 py-3 shadow-[0_8px_24px_-12px_rgba(56,71,245,0.18)] md:px-4 md:py-4 dark:border-white/[0.06]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative block w-full flex-1">
            <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-4 text-muted-3" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try 'cozy night programmer' or 'fierce dragon'"
              className="h-11 w-full rounded-full border border-border-base bg-surface pr-10 pl-11 text-sm text-foreground outline-none transition placeholder:text-muted-3 focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="-translate-y-1/2 absolute top-1/2 right-3 grid size-6 place-items-center rounded-full text-muted-4 transition hover:bg-surface-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </label>
          <div className="relative shrink-0">
            <select
              value={sort}
              onChange={(e) => {
                const next = e.target.value as SortKey;
                track("sort_changed", { sort: next });
                setSort(next);
              }}
              aria-label="Sort pets"
              className="h-11 w-full cursor-pointer appearance-none rounded-full border border-border-base bg-surface pr-9 pl-4 text-sm text-foreground outline-none transition hover:border-border-strong focus:border-brand/60 focus:ring-2 focus:ring-brand/15 sm:w-auto sm:min-w-[160px]"
            >
              {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(
                ([key, label]) => (
                  <option key={key} value={key}>
                    Sort: {label}
                  </option>
                ),
              )}
            </select>
            <ChevronDown className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 size-4 text-muted-3" />
          </div>
        </div>

        {/* Filter chips: kind + vibe in one continuous wrap row. Saves a
 whole horizontal label column and roughly half the height vs
 the previous two-row layout. */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            type="button"
            onClick={() => setMobileFiltersOpen(true)}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-foreground transition hover:border-border-strong"
          >
            Filters
            {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          {filtersActive ? (
            <button
              type="button"
              onClick={() => {
                track("filters_cleared");
                clearFilters();
              }}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="hidden flex-wrap gap-1.5 border-t border-black/[0.05] pt-3 md:flex dark:border-white/[0.05]">
          <FilterChips
            options={PET_KINDS}
            counts={facets.kinds}
            active={activeKinds}
            onToggle={(v) => toggleKind(v as PetKind)}
            tone="kind"
          />
          <FilterChips
            options={PET_VIBES}
            counts={facets.vibes}
            active={activeVibes}
            onToggle={(v) => toggleVibe(v as PetVibe)}
            tone="vibe"
          />
        </div>
        <div className="hidden flex-wrap gap-1.5 border-t border-black/[0.05] pt-3 md:flex dark:border-white/[0.05]">
          <FilterChips
            options={COLOR_FAMILIES}
            counts={facets.colors}
            active={activeColors}
            onToggle={(v) => toggleColor(v as ColorFamily)}
            tone="color"
            dotColors={FAMILY_DOT}
          />
        </div>
        <div className="hidden flex-wrap gap-1.5 border-t border-black/[0.05] pt-3 md:flex dark:border-white/[0.05]">
          <FilterChips
            options={facets.batches.map((batch) => batch.key)}
            counts={Object.fromEntries(
              facets.batches.map((batch) => [batch.key, batch.count]),
            )}
            labels={Object.fromEntries(
              facets.batches.map((batch) => [batch.key, batch.label]),
            )}
            active={activeBatches}
            onToggle={toggleBatch}
            tone="batch"
          />
        </div>
      </div>

      {mobileFiltersOpen ? (
        <div
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Pet filters"
        >
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setMobileFiltersOpen(false)}
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[75dvh] overflow-y-auto rounded-t-[28px] border border-border-base bg-background px-4 pt-4 pb-6 shadow-2xl">
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-black/10 dark:bg-white/10" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-foreground">Filters</p>
              <button
                type="button"
                onClick={() => setMobileFiltersOpen(false)}
                className="inline-flex h-9 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2"
              >
                Done
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <p className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                  Kind + vibe
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <FilterChips
                    options={PET_KINDS}
                    counts={facets.kinds}
                    active={activeKinds}
                    onToggle={(v) => toggleKind(v as PetKind)}
                    tone="kind"
                  />
                  <FilterChips
                    options={PET_VIBES}
                    counts={facets.vibes}
                    active={activeVibes}
                    onToggle={(v) => toggleVibe(v as PetVibe)}
                    tone="vibe"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                  Color
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <FilterChips
                    options={COLOR_FAMILIES}
                    counts={facets.colors}
                    active={activeColors}
                    onToggle={(v) => toggleColor(v as ColorFamily)}
                    tone="color"
                    dotColors={FAMILY_DOT}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                  Batch
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <FilterChips
                    options={facets.batches.map((batch) => batch.key)}
                    counts={Object.fromEntries(
                      facets.batches.map((batch) => [batch.key, batch.count]),
                    )}
                    labels={Object.fromEntries(
                      facets.batches.map((batch) => [batch.key, batch.label]),
                    )}
                    active={activeBatches}
                    onToggle={toggleBatch}
                    tone="batch"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-2">
                {filtersActive ? (
                  <button
                    type="button"
                    onClick={() => {
                      track("filters_cleared");
                      clearFilters();
                    }}
                    className="inline-flex h-10 flex-1 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2"
                  >
                    Clear all
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setMobileFiltersOpen(false)}
                  className="inline-flex h-10 flex-1 items-center justify-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse"
                >
                  Show pets
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {searchMode === "vibe" && pets.length > 0 ? (
        <div className="flex items-center gap-2 rounded-2xl border border-brand-light/35 bg-brand-tint/70 px-4 py-2.5 text-sm text-muted-1">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-white">
            <Sparkles className="size-3" />
          </span>
          <span>
            Showing pets that vibe with{" "}
            <span className="font-medium">"{trimmedQuery}"</span>. Closer to the
            top means stronger match.
          </span>
        </div>
      ) : null}

      <div
        className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 md:gap-5 ${
          loadingPage ? "opacity-60 transition" : ""
        }`}
      >
        {pets.map((pet, index) => (
          <PetCard
            key={pet.slug}
            pet={pet}
            index={index}
            stateCount={stateCount}
            dexNumber={dexMap?.[pet.slug] ?? null}
            caught={caughtSet.has(pet.slug)}
          />
        ))}
      </div>

      {pets.length === 0 && !loadingPage ? (
        <NoResults
          query={trimmedQuery}
          mode={searchMode}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
        />
      ) : null}

      {nextCursor != null ? (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-8"
          aria-hidden="true"
        >
          {loadingMore ? (
            <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
              <Loader2 className="size-3.5 animate-spin" />
              Loading more
            </span>
          ) : (
            <button
              type="button"
              onClick={loadMore}
              className="rounded-full border border-border-base bg-surface px-4 py-2 font-mono text-[11px] tracking-[0.12em] text-muted-2 uppercase transition hover:border-black/30 dark:hover:border-white/30"
            >
              Load more
            </button>
          )}
        </div>
      ) : pets.length > 0 ? (
        <p className="py-6 text-center font-mono text-[10px] tracking-[0.22em] text-muted-4 uppercase">
          End of gallery — {total} shown
        </p>
      ) : null}
    </section>
  );
}

type FilterChipsProps = {
  options: readonly string[];
  counts: Record<string, number>;
  labels?: Record<string, string>;
  active: Set<string>;
  onToggle: (value: string) => void;
  tone: "kind" | "vibe" | "color" | "batch";
  dotColors?: Partial<Record<string, string>>;
};

function FilterChips({
  options,
  counts,
  labels,
  active,
  onToggle,
  tone,
  dotColors,
}: FilterChipsProps) {
  return (
    <>
      {options.map((value) => {
        const count = counts[value] ?? 0;
        if (count === 0) return null;
        const isActive = active.has(value);
        const dotClass =
          tone === "kind"
            ? "bg-[#0a0a0a]/70"
            : tone === "vibe"
              ? "bg-brand"
              : tone === "color"
                ? ""
                : "bg-sky-500";
        const dotColor = dotColors?.[value];
        const label = labels?.[value] ?? value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => {
              track("filter_toggled", {
                tone,
                value,
                next: isActive ? "off" : "on",
              });
              onToggle(value);
            }}
            aria-pressed={isActive}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] capitalize transition ${
              isActive
                ? "border-inverse bg-inverse text-on-inverse"
                : "border-border-base bg-surface text-muted-2 hover:border-border-strong"
            }`}
          >
            {!isActive || dotColor ? (
              <span
                className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
                style={dotColor ? { backgroundColor: dotColor } : undefined}
              />
            ) : null}
            <span className={tone === "batch" ? "" : "capitalize"}>
              {label}
            </span>
            <span
              className={`font-mono text-[9px] ${
                isActive ? "text-on-inverse/60" : "text-muted-3"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </>
  );
}

export type PetCardOwnerActions = {
  /**
   * Submission id (pet_xxx). Required to call the owner-action APIs
   * for edit / withdraw. When omitted the action menu only shows
   * the public actions (copy, share, download, owner self-delete).
   */
  submissionId: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
};

export type PetCardStatusOverlay = {
  label: string;
  tone: "warning" | "danger";
};

type PetCardProps = {
  pet: PetWithMetrics;
  index: number;
  caught?: boolean;
  /**
   * Optional. Kept on the type so older call sites that still pass
   * stateCount don't break. The card no longer renders a 'states'
   * label — install count is shown instead.
   */
  stateCount?: number;
  /**
   * Canonical pokédex number derived from `approved_at` order. When
   * provided, the card shows "No. 042" — the real album slot, not the
   * positional index in the current view (which would change with
   * sort/shuffle/filter and confuse users into thinking pets had
   * moved). Falls back to the positional index when missing so the
   * card never renders a blank slot.
   */
  dexNumber?: number | null;
  /**
   * Owner-only actions surfaced in the action menu. Pass on the
   * profile page when the viewer is the pet's owner so the menu
   * gets Withdraw (pending), Edit (approved), Submit new version
   * (rejected) entries.
   */
  ownerActions?: PetCardOwnerActions;
  /**
   * Visual badge overlaying the card. Used on the owner profile to
   * tag pending and rejected pets with the same shape as the rest
   * of the gallery cards. Approved pets render no overlay.
   */
  statusOverlay?: PetCardStatusOverlay;
};

export function PetCard({
  pet,
  index,
  dexNumber,
  caught,
  ownerActions,
  statusOverlay,
}: PetCardProps) {
  const dexLabel =
    dexNumber != null
      ? dexNumber < 1000
        ? dexNumber.toString().padStart(3, "0")
        : dexNumber.toString()
      : String(index + 1).padStart(3, "0");
  const { likeCount, installCount } = pet.metrics;
  const isDiscovered = pet.source === "discover";
  const href = `/pets/${pet.slug}`;
  const batchLabel = pet.approvedAt
    ? formatBatchLabel(getBatchKey(new Date(pet.approvedAt)))
    : null;
  const accentStyle =
    !pet.featured && pet.dominantColor
      ? ({ "--pet-accent": pet.dominantColor } as CSSProperties)
      : undefined;

  return (
    // The has-[] selector lifts this card above its row siblings while
    // the action menu is open. Without it the dropdown gets clipped by
    // the next card down: each card has its own stacking context (from
    // backdrop-blur + the hover translate), so a z-index inside the
    // dropdown can never climb above a later sibling's context. The
    // PetActionMenu trigger button toggles aria-expanded, which is the
    // signal we hook here.
    <article
      style={accentStyle}
      className={`group relative flex h-full flex-col rounded-3xl border bg-surface/76 backdrop-blur transition has-[[aria-expanded=true]]:z-30 hover:-translate-y-0.5 hover:bg-white hover:shadow-xl hover:shadow-blue-950/10 ${
        pet.featured
          ? "border-brand-light/45 shadow-[0_0_0_1px_rgba(100,120,246,0.18),0_18px_45px_-22px_rgba(82,102,234,0.5)]"
          : pet.dominantColor
            ? "border-black/10 shadow-sm shadow-blue-950/5 ring-1 ring-[color:var(--pet-accent)]/30 hover:ring-[color:var(--pet-accent)]/60"
            : "border-black/10 shadow-sm shadow-blue-950/5"
      } dark:hover:bg-stone-800`}
    >
      <Link
        href={href}
        aria-label={`Open ${pet.displayName}`}
        className="flex flex-1 flex-col rounded-3xl"
      >
        <div className="flex items-center justify-between rounded-t-3xl border-b border-black/[0.06] px-5 pt-4 pr-5 pb-3 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tracking-[0.22em] text-muted-3 uppercase">
              No. {dexLabel}
            </span>
            {caught ? (
              <span title="Caught" className="text-emerald-600">
                <CheckCircle2 className="size-4 fill-current" />
              </span>
            ) : null}
          </div>
        </div>

        <div className="pet-sprite-stage relative flex items-center justify-center overflow-hidden px-5 py-6">
          <PetSprite
            src={pet.spritesheetPath}
            cycleStates
            scale={0.7}
            label={`${pet.displayName} animated`}
          />
          {installCount > 0 ? (
            <span className="pointer-events-none absolute right-5 bottom-2 font-mono text-[10px] tracking-[0.22em] text-muted-4 uppercase">
              {compactNumber(installCount)} install
              {installCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-2 border-t border-black/[0.06] px-5 pt-4 pb-3 dark:border-white/[0.06]">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
              <span className="truncate">{pet.displayName}</span>
              {pet.featured ? (
                <span
                  title="Featured"
                  className="font-mono text-[10px] text-brand"
                >
                  ★
                </span>
              ) : null}
            </h3>
            <span className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
              {pet.kind}
            </span>
          </div>
          <p className="line-clamp-2 text-sm leading-6 text-muted-2">
            {pet.description}
          </p>
          {batchLabel ? (
            <span className="inline-flex w-fit items-center rounded-full border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-2 uppercase dark:border-white/[0.1] dark:bg-white/[0.04]">
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
          {isDiscovered ? (
            <span
              className="inline-flex w-fit items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-chip-warning-fg uppercase ring-1 ring-chip-warning-fg/20"
              title="Added on behalf of the original author. Not yet claimed."
            >
              <Sparkles className="size-3" />
              Discovered
            </span>
          ) : null}

          {pet.submittedBy ? (
            <div className="mt-2 flex items-center gap-1.5 border-t border-black/[0.05] pt-2 font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase dark:border-white/[0.05]">
              {pet.submittedBy.imageUrl &&
              isAllowedAvatarUrl(pet.submittedBy.imageUrl) ? (
                // biome-ignore lint/performance/noImgElement: avatar allowlisted above
                <img
                  src={pet.submittedBy.imageUrl}
                  alt=""
                  className="size-4 rounded-full ring-1 ring-black/10"
                />
              ) : null}
              by {pet.submittedBy.name}
            </div>
          ) : null}
        </div>
      </Link>

      {/* Footer bar — outside the card-wide Link so each button can
          fire its own action without bubbling up to navigation. */}
      <div className="mt-auto rounded-b-3xl">
        <PetCardFooter
          slug={pet.slug}
          displayName={pet.displayName}
          zipUrl={pet.zipUrl}
          soundUrl={pet.soundUrl}
          installCount={installCount}
          likeCount={likeCount}
        />
      </div>

      {/* Status overlay (owner profile only). Positioned over the dex
          row so it reads alongside the No. label without competing
          with the action menu in the top-right. */}
      {statusOverlay ? (
        <span
          className={`pointer-events-none absolute top-3 left-3 z-20 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] uppercase ring-1 ${
            statusOverlay.tone === "danger"
              ? "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20"
              : "bg-chip-warning-bg text-chip-warning-fg ring-chip-warning-fg/20"
          }`}
        >
          {statusOverlay.label}
        </span>
      ) : null}

      {/* Action menu lives outside the Link so its clicks don't navigate.
 Absolute-positioned to overlap the featured badge corner. */}
      <div className="absolute top-3 right-4 z-20">
        <PetActionMenu
          pet={{
            slug: pet.slug,
            displayName: pet.displayName,
            zipUrl: pet.zipUrl,
            description: pet.description,
          }}
          ownerActions={ownerActions}
        />
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

// NoResults — empty state. When the user hit a vibe search with no
// matches we offer them to "request this pet": POSTs the query to
// /api/pet-requests which dedup-upvotes if the same idea was already
// asked for, otherwise creates a new request. Captures demand for the
// admin queue at /admin/requests.
function NoResults({
  query,
  mode,
  filtersActive,
  onClearFilters,
}: {
  query: string;
  mode: SearchMode;
  filtersActive: boolean;
  onClearFilters: () => void;
}) {
  const [state, setState] = useState<
    | { tag: "idle" }
    | { tag: "submitting" }
    | { tag: "ok"; mode: "created" | "upvoted"; count: number }
    | { tag: "error"; reason: string }
  >({ tag: "idle" });

  const canRequest = mode === "vibe" && query.length >= 4;

  async function submitRequest() {
    if (!canRequest || state.tag === "submitting") return;
    track("pet_request_clicked", { from: "gallery_empty_state" });
    setState({ tag: "submitting" });
    try {
      const res = await fetch("/api/pet-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          track("pet_request_blocked", { reason: "unauthorized" });
          setState({
            tag: "error",
            reason: "Sign in to request a pet.",
          });
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        track("pet_request_failed", { status: res.status });
        setState({
          tag: "error",
          reason:
            data.message ?? data.error ?? `Request failed (${res.status}).`,
        });
        return;
      }
      const data = (await res.json()) as {
        mode: "created" | "upvoted";
        upvoteCount: number;
      };
      track("pet_request_succeeded", {
        mode: data.mode,
        upvotes: data.upvoteCount,
      });
      setState({
        tag: "ok",
        mode: data.mode,
        count: data.upvoteCount,
      });
    } catch {
      track("pet_request_failed", { reason: "network" });
      setState({ tag: "error", reason: "Network error, try again." });
    }
  }

  return (
    <div className="rounded-3xl border border-dashed border-border-base bg-white/70 p-8 text-center md:p-10 dark:bg-stone-900/70">
      <p className="text-sm font-medium text-foreground">
        No pets match {query ? `"${query}"` : "this view"}.
      </p>

      {canRequest ? (
        state.tag === "ok" ? (
          <div className="mt-4 inline-flex flex-col items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40">
              <Check className="size-3.5" />
              {state.mode === "created"
                ? "Requested. We'll prioritize popular requests."
                : `Upvoted. ${state.count} people want this pet.`}
            </span>
            <Link
              href="/requests"
              className="font-mono text-[10px] tracking-[0.18em] text-stone-500 uppercase underline-offset-4 hover:text-black hover:underline dark:text-stone-400 dark:hover:text-stone-100"
            >
              See all requests
            </Link>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-3">
            <p className="max-w-md text-sm text-muted-2">
              Want a pet that matches{" "}
              <span className="font-medium">"{query}"</span>? Request it and
              other people can upvote.
            </p>
            <button
              type="button"
              onClick={submitRequest}
              disabled={state.tag === "submitting"}
              className="inline-flex h-10 items-center gap-1.5 rounded-full bg-brand px-4 text-sm font-medium text-white transition hover:bg-brand-deep disabled:opacity-60"
            >
              <Plus className="size-4" />
              {state.tag === "submitting" ? "Sending…" : "Request this pet"}
            </button>
            {state.tag === "error" ? (
              <p className="font-mono text-[10px] tracking-[0.12em] text-rose-700 uppercase dark:text-rose-300">
                {state.reason}
              </p>
            ) : null}
          </div>
        )
      ) : filtersActive ? (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-3 inline-flex h-9 items-center justify-center rounded-full border border-black/10 bg-white px-4 text-xs font-medium text-stone-700 transition hover:border-black/30 dark:border-white/10 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-white/30"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
