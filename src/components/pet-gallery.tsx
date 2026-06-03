"use client";

import Link from "next/link";
import {
  type CSSProperties,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { track } from "@vercel/analytics";
import {
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type { PublicFeedAd } from "@/lib/ads/queries";
import { COLOR_FAMILIES, type ColorFamily } from "@/lib/color-families";
import { formatBatchLabel, getBatchKey } from "@/lib/dex-batch";
import { formatLocalizedNumber } from "@/lib/format-number";
import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";
import { PET_KINDS, PET_VIBES, type PetKind, type PetVibe } from "@/lib/types";
import { isAllowedAvatarUrl } from "@/lib/url-allowlist";
import { cn } from "@/lib/utils";

import { FeedAdSlot } from "@/components/ads/feed-ad-slot";
import { useHeaderState } from "@/components/header-state-provider";
import { PetActionMenu } from "@/components/pet-action-menu";
import { PetCardFooter } from "@/components/pet-card-footer";
import { PetSprite } from "@/components/pet-sprite";
import { ProfilePinButton } from "@/components/profile-pin-button";
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
};

type SearchMode = "vibe" | "keyword" | "all";

type SearchPayload = {
  pets: PetWithMetrics[];
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
  /**
   * slug -> canonical dex number (ROW_NUMBER over approved_at). Built
   * once on the server for the whole approved catalog and shipped to
   * the client so every PetCard — including pets that arrive via the
   * /api/pets/search infinite-scroll — can show the right number
   * without a per-row lookup.
   */
  dexMap?: Record<string, number>;
  ads?: PublicFeedAd[];
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
  ads = [],
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
  const [sort, setSort] = useState<SortKey>("alpha");
  const [sortTouched, setSortTouched] = useState(false);
  // The home page no longer ships caughtSlugs server-side — that would
  // make every SSR render per-visitor and kill ISR. We pull the caught
  // slug set from the shared HeaderStateProvider (one polled aggregate
  // instead of per-component fetch) so the "caught" highlight still
  // works for signed-in users without an extra Edge Request per page.
  const headerCaught = useHeaderState().state.caught;
  const caughtSet = new Set(caughtSlugs ?? headerCaught);

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
    [trimmedQuery, activeKinds, activeVibes, activeColors, activeBatches, sort],
  );

  useEffect(() => {
    if (sortTouched) return;
    setSort(trimmedQuery ? "curated" : "alpha");
  }, [sortTouched, trimmedQuery]);

  // Re-fetch on filter / sort / query changes (debounced for the query).
  useEffect(() => {
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
        // Track only meaningful searches (skip the empty initial load
        // and very short typing). 'no_results' fires its own event
        // because it gates the request CTA — we want to know which
        // queries miss most often.
        if (trimmedQuery.length >= 4 && mode !== "all") {
          track("gallery_searched", {
            mode,
            length: trimmedQuery.length,
            results: nextTotal,
          });
          if (nextTotal === 0) {
            track("gallery_no_results", {
              query_length: trimmedQuery.length,
              mode,
            });
          }
        }
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
  }, [buildParams, trimmedQuery]);

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
                track("filters_cleared");
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
      <div className="rounded-3xl border border-black/[0.06] bg-surface p-3 shadow-[0_8px_24px_-12px_rgba(56,71,245,0.18)] md:p-4 dark:border-white/[0.06]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <InputGroup className="h-11 flex-1 rounded-full bg-background/40">
            <InputGroupAddon align="inline-start">
              <Search className="size-4 text-muted-3" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="text-sm placeholder:text-muted-3"
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

          <Select
            value={sort}
            onValueChange={(next) => {
              track("sort_changed", { sort: next });
              setSortTouched(true);
              setSort(next as SortKey);
            }}
          >
            <SelectTrigger
              aria-label={t("sortAria")}
              className="w-full shrink-0 sm:w-auto sm:min-w-[180px]"
            >
              <span className="text-muted-3">Sort:</span>
              <span className="text-foreground">{SORT_LABELS[sort]}</span>
            </SelectTrigger>
            <SelectContent align="end">
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
                track("filters_cleared");
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
        <div className="mt-3 hidden flex-col gap-3 border-t border-black/[0.05] pt-3 md:flex dark:border-white/[0.05]">
          <FilterRow label="Type">
            <FilterChips
              options={PET_KINDS}
              counts={facets.kinds}
              active={activeKinds}
              onToggle={(v) => toggleKind(v as PetKind)}
              tone="kind"
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
        {pets.map((pet, index) => {
          const ad = adForPetIndex(ads, index);
          return (
            <Fragment key={pet.slug}>
              <PetCard
                pet={pet}
                index={index}
                stateCount={stateCount}
                dexNumber={dexMap?.[pet.slug] ?? null}
                caught={caughtSet.has(pet.slug)}
              />
              {ad ? <FeedAdSlot ad={ad} /> : null}
            </Fragment>
          );
        })}
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
            ? "bg-[#0a0a0a]/70 group-aria-pressed/toggle:bg-on-inverse/70"
            : tone === "vibe"
              ? "bg-brand group-aria-pressed/toggle:bg-on-inverse"
              : tone === "color"
                ? ""
                : "bg-sky-500 group-aria-pressed/toggle:bg-on-inverse";
        const dotColor = dotColors?.[value];
        const label = labels?.[value] ?? value;
        return (
          <Toggle
            key={value}
            variant="chip"
            size="chip"
            pressed={isActive}
            onPressedChange={() => {
              track("filter_toggled", {
                tone,
                value,
                next: isActive ? "off" : "on",
              });
              onToggle(value);
            }}
            className={tone === "batch" ? "" : "capitalize"}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
              style={dotColor ? { backgroundColor: dotColor } : undefined}
            />
            <span>{label}</span>
            <span className="font-mono text-[9px] text-muted-3 group-aria-pressed/toggle:text-on-inverse/60">
              {count}
            </span>
          </Toggle>
        );
      })}
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

function adForPetIndex(
  ads: PublicFeedAd[],
  index: number,
): PublicFeedAd | null {
  if (ads.length === 0) return null;
  // Density scales inversely with inventory: with a single advertiser
  // any stride feels spammy, so we space generously and cap to 3 slots
  // total. With a healthier roster the slots tighten back up.
  const stride = ads.length === 1 ? 40 : ads.length <= 3 ? 24 : 16;
  const maxSlots = ads.length === 1 ? 3 : 8;
  const petPosition = index + 1;
  if (petPosition < 8) return null;
  if (petPosition !== 8 && (petPosition - 8) % stride !== 0) return null;
  const slotNumber = Math.floor((petPosition - 8) / stride);
  if (slotNumber >= maxSlots) return null;
  const adIndex = slotNumber % ads.length;
  return ads[adIndex] ?? null;
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
  const batchLabel = pet.approvedAt
    ? formatBatchLabel(getBatchKey(new Date(pet.approvedAt)))
    : null;
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
      className="group relative flex h-full flex-col overflow-hidden rounded-3xl border border-black/10 bg-surface/76 shadow-sm shadow-blue-950/5 backdrop-blur transition has-[[aria-expanded=true]]:z-30 has-[[aria-expanded=true]]:-translate-y-0.5 has-[[aria-expanded=true]]:bg-white has-[[aria-expanded=true]]:shadow-xl has-[[aria-expanded=true]]:shadow-blue-950/10 hover:-translate-y-0.5 hover:bg-white hover:shadow-xl hover:shadow-blue-950/10 dark:border-white/10 dark:has-[[aria-expanded=true]]:bg-stone-800 dark:hover:bg-stone-800"
    >
      {/* Inset accent tab — short bar floating inside the card near the top,
          centered horizontally, like the colored tab on a tab folder or a
          file divider. Same treatment for featured & non-featured; the
          featured badge in the top-right does the special-case signaling. */}
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
        aria-label={`Open ${pet.displayName}`}
        className="flex flex-1 flex-col rounded-3xl"
      >
        <div className="flex items-center justify-between rounded-t-3xl border-b border-black/[0.06] px-5 pt-4 pr-5 pb-3 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tracking-[0.22em] text-muted-3 uppercase">
              No. {dexLabel}
            </span>
            {caught ? (
              <span title={t("caughtTitle")} className="text-emerald-600">
                <CheckCircle2 className="size-4 fill-current" />
              </span>
            ) : null}
          </div>
        </div>

        <div
          className="pet-sprite-stage relative flex items-center justify-center overflow-hidden px-5 py-6"
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
          <PetSprite
            src={pet.spritesheetPath}
            cycleStates
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
          {installCount > 0 ? (
            <span className="pointer-events-none absolute right-5 bottom-2 font-mono text-[10px] tracking-[0.22em] text-muted-4 uppercase">
              {formattedInstallCount} install
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
                  title={t("featuredTitle")}
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
          <p
            className={cn(
              "line-clamp-2 text-sm text-muted-2",
              isZh ? "leading-tight" : "leading-6",
            )}
          >
            {pet.description}
          </p>
          {batchLabel ? (
            <Badge
              variant="outline"
              className="w-fit rounded-full border-black/[0.08] bg-black/[0.03] font-mono text-[10px] tracking-[0.12em] text-muted-2 uppercase dark:border-white/[0.1] dark:bg-white/[0.04]"
            >
              {batchLabel}
            </Badge>
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
              />
            </div>
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
