"use client";

import Link from "next/link";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { COLOR_FAMILIES, type ColorFamily } from "@/lib/color-families";
import { formatLocalizedNumber } from "@/lib/format-number";
import { petPreviewUrlForSource } from "@/lib/pet-preview";
import type { SearchPet } from "@/lib/pet-search";
import { petStates } from "@/lib/pet-states";
import { PET_KINDS, PET_VIBES, type PetKind, type PetVibe } from "@/lib/types";
import { isAllowedAvatarUrl } from "@/lib/url-allowlist";
import { cn } from "@/lib/utils";

import { PetActionMenu } from "@/components/pets/pet-action-menu";
import { PetCardFooter } from "@/components/pets/pet-card-footer";
import { PetSprite } from "@/components/pets/pet-sprite";
import { ProfilePinButton } from "@/components/profile/profile-pin-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Toggle } from "@/components/ui/toggle";
import { PetBadge } from "@/components/zh/pet-badge";
import { getDeterministicBadges } from "@/components/zh/use-pet-badges";

type Facets = {
  kinds: Record<string, number>;
  vibes: Record<string, number>;
  colors: Record<ColorFamily, number>;
  batches: Array<{ key: string; label: string; count: number }>;
  spriteVersions?: Record<string, number>;
};

type SearchMode = "vibe" | "keyword" | "all";

type SearchPayload = {
  pets: SearchPet[];
  total?: number;
  nextCursor: number | null;
  searchMode?: SearchMode;
  facets?: Facets;
  shuffleSeed?: string;
};

type InitialSearchPayload = SearchPayload & {
  total: number;
  facets: Facets;
};

type PetGalleryProps = {
  initial: InitialSearchPayload;
  totalPets: number;
  caughtSlugs?: string[];
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
  caughtSlugs,
}: PetGalleryProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const t = useTranslations("gallery");
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const [activeKinds, setActiveKinds] = useState<Set<PetKind>>(new Set());
  const [activeVibes, setActiveVibes] = useState<Set<PetVibe>>(new Set());
  const [activeColors, setActiveColors] = useState<Set<ColorFamily>>(new Set());
  const [activeBatches, setActiveBatches] = useState<Set<string>>(new Set());
  const [activeSpriteVersions, setActiveSpriteVersions] = useState<Set<string>>(
    new Set(),
  );
  const [sort, setSort] = useState<SortKey>("installed");
  const [sortTouched, setSortTouched] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const caughtSet = new Set(caughtSlugs ?? []);

  const [pets, setPets] = useState<SearchPet[]>(initial.pets);
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
  const hasMountedSearchEffect = useRef(false);
  const shuffleSeedRef = useRef<string | null>(initial.shuffleSeed ?? null);
  const stateCount = petStates.length;

  const buildParams = useCallback(
    (cursor: number, includeMeta = true) => {
      const p = new URLSearchParams();
      if (trimmedQuery) p.set("q", trimmedQuery);
      if (activeKinds.size > 0) p.set("kinds", [...activeKinds].join(","));
      if (activeVibes.size > 0) p.set("vibes", [...activeVibes].join(","));
      if (activeColors.size > 0) p.set("colors", [...activeColors].join(","));
      if (activeBatches.size > 0) {
        p.set("batches", [...activeBatches].join(","));
      }
      if (activeSpriteVersions.size > 0) {
        p.set("spriteVersions", [...activeSpriteVersions].join(","));
      }
      if (sort === "curated") {
        p.set("sort", sort);
        if (shuffleSeedRef.current) {
          p.set("shuffleSeed", shuffleSeedRef.current);
        }
      } else {
        p.set("sort", sort);
      }
      if (cursor > 0) p.set("cursor", String(cursor));
      p.set("limit", String(PAGE_SIZE));
      if (!includeMeta) p.set("includeMeta", "0");
      return p;
    },
    [
      trimmedQuery,
      activeKinds,
      activeVibes,
      activeColors,
      activeBatches,
      activeSpriteVersions,
      sort,
    ],
  );

  useEffect(() => {
    if (sortTouched) return;
    setSort(trimmedQuery ? "curated" : "installed");
  }, [sortTouched, trimmedQuery]);

  // Re-fetch on filter / sort / query changes (debounced for the query).
  useEffect(() => {
    if (!hasMountedSearchEffect.current) {
      hasMountedSearchEffect.current = true;
      return;
    }
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    let cancelled = false;
    setLoadingMore(false);
    setLoadingPage(true);
    const handle = window.setTimeout(async () => {
      try {
        const params = buildParams(0);
        const res = await fetch(`/api/pets/search?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("search_failed");
        const data = (await res.json()) as SearchPayload;
        if (cancelled || seq !== requestSeq.current) return;
        if (data.shuffleSeed) shuffleSeedRef.current = data.shuffleSeed;
        const nextTotal = data.total ?? data.pets.length;
        setPets(data.pets);
        setTotal(nextTotal);
        setNextCursor(data.nextCursor);
        if (data.facets) setFacets(data.facets);
        const mode = data.searchMode ?? "all";
        setSearchMode(mode);
      } catch (error) {
        if (isAbortError(error)) return;
        // soft-fail: keep whatever's already on screen
      } finally {
        if (!cancelled && seq === requestSeq.current) setLoadingPage(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [buildParams]);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || loadingMore || loadingPage) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const params = buildParams(nextCursor, false);
      const res = await fetch(`/api/pets/search?${params}`);
      if (!res.ok) throw new Error("search_failed");
      const data = (await res.json()) as SearchPayload;
      if (seq !== requestSeq.current) return;
      if (data.shuffleSeed) shuffleSeedRef.current = data.shuffleSeed;
      setPets((prev) => [...prev, ...data.pets]);
      setNextCursor(data.nextCursor);
    } catch {
      // ignore, sentinel will retry on next intersect
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
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
      { rootMargin: "100px" },
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
  const toggleSpriteVersion = (version: string) =>
    setActiveSpriteVersions((c) => toggleSet(c, version));

  const clearFilters = () => {
    setActiveKinds(new Set());
    setActiveVibes(new Set());
    setActiveColors(new Set());
    setActiveBatches(new Set());
    setActiveSpriteVersions(new Set());
    setQuery("");
  };

  const filtersActive =
    activeKinds.size > 0 ||
    activeVibes.size > 0 ||
    activeColors.size > 0 ||
    activeBatches.size > 0 ||
    activeSpriteVersions.size > 0 ||
    query.length > 0;
  const activeFilterCount =
    activeKinds.size +
    activeVibes.size +
    activeColors.size +
    activeBatches.size +
    activeSpriteVersions.size;
  const spriteVersionCounts = facets.spriteVersions ?? { "1": 0, "2": 0 };
  const spriteVersionLabels = { "1": "v1", "2": "v2" };

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.18em] text-brand-light uppercase">
            {t("eyebrow", { totalPets })}
          </p>
          <h2 className="mt-1.5 text-3xl font-medium tracking-tight text-black md:text-4xl dark:text-stone-100">
            {t("title")}
          </h2>
        </div>
        {filtersActive ? (
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-stone-500 uppercase">
            <span>{t("matches", { count: total })}</span>
            <button
              type="button"
              onClick={() => {
                clearFilters();
              }}
              className="rounded-full border border-border-base bg-surface px-2.5 py-1 text-muted-2 transition hover:border-border-strong hover:text-black dark:hover:text-stone-100"
            >
              {t("clearAll")}
            </button>
          </div>
        ) : null}
      </div>

      {/* Unified control bar: search input takes full width, sort sits
 to the right, filter chips wrap below. The whole surface gets the
 same subtle elevation as the announcement modal so it reads as a
 single primary action region. */}
      <div className="sticky top-16 z-30 rounded-2xl border border-border-base bg-background/85 p-3 backdrop-blur-md md:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <InputGroup className="h-10 flex-1 rounded-full border-border-base bg-background/40">
            <InputGroupAddon align="inline-start">
              <Search className="size-4 text-muted-3" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="text-[13px] placeholder:text-muted-3"
            />
            {query.length > 0 ? (
              <InputGroupAddon align="inline-end">
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("clearSearchAria")}
                  className="grid size-6 place-items-center rounded-full text-muted-4 transition hover:bg-surface-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="hidden h-10 shrink-0 items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-4 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground aria-expanded:border-brand/40 aria-expanded:bg-brand/15 aria-expanded:text-brand md:inline-flex"
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {activeFilterCount > 0 ? (
              <span className="grid size-4.5 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-white">
                {activeFilterCount}
              </span>
            ) : null}
            <ChevronDown
              className={`size-3.5 transition-transform duration-200 ${filtersOpen ? "rotate-180" : ""}`}
            />
          </button>
          <Select
            value={sort}
            onValueChange={(next) => {
              setSortTouched(true);
              setSort(next as SortKey);
            }}
          >
            <SelectTrigger
              aria-label={t("sortAria")}
              className="h-10 w-full shrink-0 rounded-full border-border-base bg-surface/70 text-[13px] backdrop-blur hover:bg-surface-muted sm:w-auto sm:min-w-[180px]"
            >
              <span className="text-muted-3">Sort:</span>
              <span className="text-foreground">{SORT_LABELS[sort]}</span>
            </SelectTrigger>
            <SelectContent
              alignItemWithTrigger={false}
              sideOffset={6}
              align="end"
            >
              {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(
                ([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Mobile: collapse all filter chips into a Sheet so the bar stays
 short on phones. The chips themselves are reused inside the sheet
 below to avoid divergent UIs across breakpoints. */}
        <div className="mt-3 flex items-center gap-2 md:hidden">
          <Sheet>
            <SheetTrigger
              render={
                <Button
                  type="button"
                  variant="petdex-pill"
                  className="h-10 flex-1 px-4 text-sm font-medium text-foreground"
                >
                  {t("filtersTitle")}
                  {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                </Button>
              }
            />
            <SheetContent
              side="bottom"
              className="max-h-[75dvh] overflow-y-auto"
            >
              <SheetHeader>
                <SheetTitle>{t("filtersTitle")}</SheetTitle>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                <FilterGroup label="Type">
                  <FilterChips
                    options={PET_KINDS}
                    counts={facets.kinds}
                    active={activeKinds}
                    onToggle={(v) => toggleKind(v as PetKind)}
                    tone="kind"
                  />
                </FilterGroup>
                <Separator className="bg-border-base" />
                <FilterGroup label="Version">
                  <FilterChips
                    options={["1", "2"]}
                    counts={spriteVersionCounts}
                    labels={spriteVersionLabels}
                    active={activeSpriteVersions}
                    onToggle={toggleSpriteVersion}
                    tone="version"
                  />
                </FilterGroup>
                <Separator className="bg-border-base" />
                <FilterGroup label="Vibe">
                  <FilterChips
                    options={PET_VIBES}
                    counts={facets.vibes}
                    active={activeVibes}
                    onToggle={(v) => toggleVibe(v as PetVibe)}
                    tone="vibe"
                  />
                </FilterGroup>
                <Separator className="bg-border-base" />
                <FilterGroup label="Color">
                  <FilterChips
                    options={COLOR_FAMILIES}
                    counts={facets.colors}
                    active={activeColors}
                    onToggle={(v) => toggleColor(v as ColorFamily)}
                    tone="color"
                    dotColors={FAMILY_DOT}
                  />
                </FilterGroup>
                {facets.batches.length > 0 ? (
                  <>
                    <Separator className="bg-border-base" />
                    <FilterGroup label="Era">
                      <FilterChips
                        options={facets.batches.map((batch) => batch.key)}
                        counts={Object.fromEntries(
                          facets.batches.map((batch) => [
                            batch.key,
                            batch.count,
                          ]),
                        )}
                        labels={Object.fromEntries(
                          facets.batches.map((batch) => [
                            batch.key,
                            batch.label,
                          ]),
                        )}
                        active={activeBatches}
                        onToggle={toggleBatch}
                        tone="batch"
                      />
                    </FilterGroup>
                  </>
                ) : null}
              </div>
            </SheetContent>
          </Sheet>
          {filtersActive ? (
            <Button
              type="button"
              variant="petdex-pill"
              onClick={() => {
                clearFilters();
              }}
              className="h-10 px-4 text-sm font-medium text-muted-2"
            >
              Clear
            </Button>
          ) : null}
        </div>

        {/* Desktop: filters grouped by category with Type · Vibe · Color
 · Era separators. Eyebrow labels mark each cluster for scan-
 ability without losing the wrap-row density. */}
        {!filtersOpen && activeFilterCount > 0 ? (
          <div className="mt-3 hidden flex-wrap items-center gap-1.5 md:flex">
            <FilterChips
              options={[...activeKinds]}
              counts={facets.kinds}
              active={activeKinds}
              onToggle={(v) => toggleKind(v as PetKind)}
              tone="kind"
            />
            <FilterChips
              options={[...activeVibes]}
              counts={facets.vibes}
              active={activeVibes}
              onToggle={(v) => toggleVibe(v as PetVibe)}
              tone="vibe"
            />
            <FilterChips
              options={[...activeColors]}
              counts={facets.colors}
              active={activeColors}
              onToggle={(v) => toggleColor(v as ColorFamily)}
              tone="color"
              dotColors={FAMILY_DOT}
            />
            <FilterChips
              options={[...activeBatches]}
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
            <FilterChips
              options={[...activeSpriteVersions]}
              counts={spriteVersionCounts}
              labels={spriteVersionLabels}
              active={activeSpriteVersions}
              onToggle={toggleSpriteVersion}
              tone="version"
            />
          </div>
        ) : null}
        <div
          key={filtersOpen ? "open" : "closed"}
          className={`mt-3 flex-col gap-3 border-t border-black/[0.05] pt-3 duration-200 animate-in fade-in-0 slide-in-from-top-1 dark:border-white/[0.05] ${filtersOpen ? "hidden md:flex" : "hidden"}`}
        >
          <FilterRow label="Type">
            <FilterChips
              options={PET_KINDS}
              counts={facets.kinds}
              active={activeKinds}
              onToggle={(v) => toggleKind(v as PetKind)}
              tone="kind"
              max={8}
            />
            <span aria-hidden className="px-1 text-muted-4">
              ·
            </span>
            <FilterChips
              options={PET_VIBES}
              counts={facets.vibes}
              active={activeVibes}
              onToggle={(v) => toggleVibe(v as PetVibe)}
              tone="vibe"
              max={8}
            />
          </FilterRow>
          <FilterRow label="Version">
            <FilterChips
              options={["1", "2"]}
              counts={spriteVersionCounts}
              labels={spriteVersionLabels}
              active={activeSpriteVersions}
              onToggle={toggleSpriteVersion}
              tone="version"
            />
          </FilterRow>
          <FilterRow label="Color">
            <FilterChips
              options={COLOR_FAMILIES}
              counts={facets.colors}
              active={activeColors}
              onToggle={(v) => toggleColor(v as ColorFamily)}
              tone="color"
              dotColors={FAMILY_DOT}
              max={8}
            />
          </FilterRow>
          {facets.batches.length > 0 ? (
            <FilterRow label="Era">
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
            </FilterRow>
          ) : null}
        </div>
      </div>

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
        className={cn(
          "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
          isZh ? "md:gap-3" : "md:gap-5",
          loadingPage && "opacity-60 transition",
        )}
      >
        {pets.map((pet, index) => (
          <PetCard
            key={pet.slug}
            pet={pet}
            index={index}
            stateCount={stateCount}
            dexNumber={pet.dexNumber ?? null}
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
          End of gallery · {total} shown
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
  tone: "kind" | "vibe" | "color" | "batch" | "version";
  max?: number;
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
  max,
}: FilterChipsProps) {
  const [expanded, setExpanded] = useState(false);
  const withCounts = options.filter((value) => (counts[value] ?? 0) > 0);
  // Count-descending: the facets people actually use come first, but
  // an ACTIVE chip is never hidden behind the fold.
  const sorted = [...withCounts].sort(
    (a, b) =>
      Number(active.has(b)) - Number(active.has(a)) ||
      (counts[b] ?? 0) - (counts[a] ?? 0),
  );
  const limit = max && !expanded ? max : sorted.length;
  const visible = sorted.slice(0, limit);
  const hidden = sorted.length - visible.length;
  return (
    <>
      {visible.map((value) => {
        const count = counts[value] ?? 0;
        if (count === 0) return null;
        const isActive = active.has(value);
        const dotClass =
          tone === "kind"
            ? "bg-foreground/60"
            : tone === "vibe"
              ? "bg-brand"
              : tone === "color"
                ? ""
                : tone === "batch"
                  ? "bg-sky-500"
                  : "bg-foreground";
        const dotColor = dotColors?.[value];
        const label = labels?.[value] ?? value;
        return (
          <Toggle
            key={value}
            variant="chip"
            size="chip"
            pressed={isActive}
            onPressedChange={() => {
              onToggle(value);
            }}
            className={tone === "batch" ? "" : "capitalize"}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
              style={dotColor ? { backgroundColor: dotColor } : undefined}
            />
            <span>{label}</span>
            <span className="font-mono text-[9px] text-muted-3 group-aria-pressed/toggle:text-brand/70">
              {count}
            </span>
          </Toggle>
        );
      })}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex h-7 items-center rounded-full px-2 font-mono text-[10px] text-muted-3 transition hover:text-foreground"
        >
          +{hidden} more
        </button>
      ) : null}
    </>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
      <span className="shrink-0 pt-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase sm:w-12">
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
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

export type PetCardPinState = {
  /** Whether this pet is currently in the owner's featured_pet_slugs. */
  isPinned: boolean;
  /** Total number of pinned pets — used to enforce the cap. */
  pinnedCount: number;
  /** Hard cap for the owner. Same constant the editor uses. */
  maxPins: number;
  /** Mirrors the button's optimistic state into parent-owned layouts. */
  onPinChange?: (isPinned: boolean) => void;
  /** Temporarily prevents pin writes while another full-list pin save is in flight. */
  disabled?: boolean;
  disabledTitle?: string;
};

type PetCardProps = {
  pet: SearchPet;
  index: number;
  /** User has already favorited/caught this pet; shown by the heart button. */
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
  /**
   * Pin/unpin overlay shown on the owner's own profile so they can
   * promote pets to (or remove from) the pinned strip without going
   * through the inline editor. Only renders when supplied — visitors
   * never see this prop populated.
   */
  pinState?: PetCardPinState;
  /**
   * Profile pages already establish the creator context, so repeating
   * "by ..." on every pet card wastes vertical space.
   */
  hideAuthor?: boolean;
  /**
   * Owner profile pin surfaces use a cleaner preview state: actions reveal
   * on hover/focus over a light scrim, leaving the card quiet by default.
   */
  actionMode?: "default" | "profilePinHover";
};

function PetCardImpl({
  pet,
  index,
  dexNumber,
  caught,
  ownerActions,
  statusOverlay,
  pinState,
  hideAuthor,
  actionMode = "default",
}: PetCardProps) {
  const t = useTranslations("gallery");
  const locale = useLocale();
  const isZh = locale === "zh";
  const dexLabel =
    dexNumber != null
      ? dexNumber < 1000
        ? dexNumber.toString().padStart(3, "0")
        : dexNumber.toString()
      : String(index + 1).padStart(3, "0");
  const { likeCount, installCount } = pet.metrics;
  const isDiscovered = pet.source === "discover";
  const href = `/pets/${pet.slug}`;
  const formattedInstallCount = formatLocalizedNumber(installCount, locale);
  const previewSrc = petPreviewUrlForSource(pet.slug, pet.spritesheetPath);
  const usesProfilePinHover = actionMode === "profilePinHover";
  // Every card with a dominantColor gets the same accent treatment.
  // Featured cards keep the same look + add a brand badge in the corner
  // (similar to HOT/NEW). Drop the special-case styling — featured no
  // longer hijacks the stripe/tint with brand color.
  const accentStyle = pet.dominantColor
    ? ({ "--pet-accent": pet.dominantColor } as CSSProperties)
    : undefined;

  // Catalog-card / ID-badge aesthetic: neutral border on all sides, a single
  // 3px accent stripe along the top tinted with --pet-accent (or brand-light
  // for featured pets). Replaces the previous full-perimeter colored ring,
  // which competed visually with the sprite + the colored chip badges.
  // The has-[] selector still lifts this card above siblings while a
  // dropdown is open — each card has its own stacking context (backdrop
  // filter + hover translate), so an internal z-index can't escape it.
  return (
    <article
      data-slot="card"
      style={accentStyle}
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border-base bg-surface/70 backdrop-blur transition has-[[aria-expanded=true]]:z-30 has-[[aria-expanded=true]]:border-brand/30 has-[[aria-expanded=true]]:bg-surface hover:-translate-y-0.5 hover:border-brand/30 hover:bg-surface"
    >
      <Link
        href={href}
        prefetch={false}
        aria-label={`Open ${pet.displayName}`}
        className="flex flex-1 flex-col rounded-3xl"
      >
        <div
          className="pet-sprite-stage relative flex items-center justify-center overflow-hidden px-5 py-7"
          style={
            pet.dominantColor
              ? {
                  // Soft radial tint of the pet's accent behind the sprite —
                  // catalog-card vibe, like a colored insert behind a photo.
                  // Kept low-opacity so light/dark modes both stay legible.
                  backgroundImage:
                    "radial-gradient(ellipse at center, color-mix(in oklab, var(--pet-accent) 22%, transparent) 0%, transparent 75%)",
                }
              : undefined
          }
        >
          <span className="pointer-events-none absolute top-2.5 left-3.5 font-mono text-[9px] tracking-[0.2em] text-muted-4 uppercase">
            No. {dexLabel}
          </span>
          <PetSprite
            src={previewSrc ?? pet.spritesheetPath}
            layout={previewSrc ? "row" : "atlas"}
            fallbackSrc={previewSrc ? pet.spritesheetPath : undefined}
            state="idle"
            cycleStates={!previewSrc}
            scale={0.7}
            label={`${pet.displayName} animated`}
          />
          {usesProfilePinHover ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-black/10 opacity-0 transition group-has-[[aria-expanded=true]]:opacity-100 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100 dark:bg-black/25"
            />
          ) : null}
          {/* Featured badge — universal across locales since 'featured' is
              product status, not localization. Sits top-right. The zh-only
              HOT/NEW/etc badges below take top-left to avoid collision. */}
          {pet.featured ? (
            <PetBadge variant="featured" position="top-right" />
          ) : null}
          {locale === "zh"
            ? getDeterministicBadges(pet.slug, installCount).map((badge) => (
                <PetBadge
                  key={`${badge.variant}-${badge.position}`}
                  variant={badge.variant}
                  position={
                    pet.featured && badge.position === "top-right"
                      ? "top-left"
                      : badge.position
                  }
                />
              ))
            : null}
        </div>

        <div className="flex flex-1 flex-col gap-1.5 border-t border-black/[0.05] px-4 pt-3 pb-2.5 dark:border-white/[0.05]">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground">
              {pet.dominantColor ? (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: "var(--pet-accent)" }}
                />
              ) : null}
              <span className="truncate">{pet.displayName}</span>
              {pet.featured ? (
                <span
                  title={t("featuredTitle")}
                  className="font-mono text-[10px] text-brand"
                >
                  ★
                </span>
              ) : null}
            </h3>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="rounded-full bg-black px-2 py-1 font-mono text-[10px] leading-none font-semibold tracking-[0.06em] text-white shadow-sm">
                v{pet.spriteVersionNumber}
              </span>
              {installCount > 0 ? (
                <span className="font-mono text-[10px] tracking-[0.12em] text-muted-4">
                  ↓ {formattedInstallCount}
                </span>
              ) : null}
            </div>
          </div>
          <p
            className={cn(
              "line-clamp-1 text-[13px] text-muted-2",
              isZh ? "leading-tight" : "leading-5",
            )}
          >
            {pet.description}
          </p>
          {isDiscovered ? (
            <Badge
              variant="outline"
              className="w-fit gap-1 rounded-full border-transparent bg-chip-warning-bg font-mono text-[10px] tracking-[0.12em] text-chip-warning-fg uppercase ring-1 ring-chip-warning-fg/20"
              title="Added on behalf of the original author. Not yet claimed."
            >
              <Sparkles className="size-3" />
              Discovered
            </Badge>
          ) : null}

          {pet.submittedBy && !hideAuthor ? (
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase">
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
      <div className="mt-auto rounded-b-2xl transition-opacity duration-200 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:group-has-[[aria-expanded=true]]:opacity-100">
        <PetCardFooter
          slug={pet.slug}
          displayName={pet.displayName}
          zipUrl={pet.zipUrl}
          soundUrl={pet.soundUrl}
          installCount={installCount}
          likeCount={likeCount}
          initialLiked={caught}
        />
      </div>

      {/* Status overlay (owner profile only). Positioned over the dex
          row so it reads alongside the No. label without competing
          with the action menu in the top-right. */}
      {statusOverlay ? (
        <Badge
          className={`pointer-events-none absolute top-3 left-3 z-20 gap-1 rounded-full border-transparent font-mono text-[10px] tracking-[0.15em] uppercase ring-1 ${
            statusOverlay.tone === "danger"
              ? "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20"
              : "bg-chip-warning-bg text-chip-warning-fg ring-chip-warning-fg/20"
          }`}
        >
          {statusOverlay.label}
        </Badge>
      ) : null}

      {usesProfilePinHover ? (
        <div className="pointer-events-none absolute top-16 right-4 z-20 flex flex-col items-center gap-2 opacity-0 transition [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 group-has-[[aria-expanded=true]]:pointer-events-auto group-has-[[aria-expanded=true]]:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          {pinState ? (
            <ProfilePinButton
              slug={pet.slug}
              isPinned={pinState.isPinned}
              pinnedCount={pinState.pinnedCount}
              maxPins={pinState.maxPins}
              appearance="subtle"
              onOptimisticChange={pinState.onPinChange}
              disabled={pinState.disabled}
              disabledTitle={pinState.disabledTitle}
            />
          ) : null}
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
      ) : (
        <>
          {/* Pin overlay — owner-only on their own /u/[handle]. Sits to the
 left of the action menu so both stay clickable above the card-wide
 Link. The button itself toggles isPinned via /api/profile and
 router.refresh()es. */}
          {pinState ? (
            <div className="absolute top-3 right-14 z-20">
              <ProfilePinButton
                slug={pet.slug}
                isPinned={pinState.isPinned}
                pinnedCount={pinState.pinnedCount}
                maxPins={pinState.maxPins}
                onOptimisticChange={pinState.onPinChange}
                disabled={pinState.disabled}
                disabledTitle={pinState.disabledTitle}
              />
            </div>
          ) : null}

          {/* Action menu lives outside the Link so its clicks don't navigate.
 Absolute-positioned to overlap the featured badge corner. */}
          <div className="absolute top-2.5 right-3 z-20 transition-opacity duration-200 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:group-has-[[aria-expanded=true]]:opacity-100">
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
        </>
      )}
    </article>
  );
}

export const PetCard = memo(PetCardImpl);

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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
    setState({ tag: "submitting" });
    try {
      const res = await fetch("/api/pet-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        if (res.status === 401) {
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
      setState({
        tag: "ok",
        mode: data.mode,
        count: data.upvoteCount,
      });
    } catch {
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
