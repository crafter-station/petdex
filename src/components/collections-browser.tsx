"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ExternalLink, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  type CollectionKind,
  collectionKind,
  KIND_SLUG,
} from "@/lib/collection-kind";
import type { OwnerCredit } from "@/lib/owner-credit";

import { CollectionActionMenu } from "@/components/collection-action-menu";
import {
  CollectionCover,
  type CollectionCoverPet,
} from "@/components/collection-cover";
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
import { Toggle } from "@/components/ui/toggle";

type CollectionItem = {
  slug: string;
  title: string;
  description: string;
  ownerId: string | null;
  externalUrl: string | null;
  coverPetSlug: string | null;
  petCount: number;
  pets: CollectionCoverPet[];
};

type SortKey = "size" | "title";

type KindFilterValue = "all" | CollectionKind;

const KIND_FILTER_KEYS: KindFilterValue[] = [
  "all",
  "franchise",
  "category",
  "category-sub",
  "other",
];

const SORT_KEYS: SortKey[] = ["size", "title"];

// First-paint window covers the average screen above the fold. The
// previous PAGE_SIZE=12 forced the IntersectionObserver to wake up
// three times before the user even scrolled (each wake mounts a fresh
// batch of CollectionCard + CollectionCover + 6 PetSprite instances,
// which racked up ~500 mounts in idle and dropped FPS to 3-30 during
// scroll). 24 covers the common viewport without needing a tick.
const PAGE_SIZE = 24;

export function CollectionsBrowser({
  collections,
  credits,
}: {
  collections: CollectionItem[];
  credits: Record<string, OwnerCredit>;
}) {
  const t = useTranslations("collectionsBrowser");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilterValue>("all");
  const [sort, setSort] = useState<SortKey>("size");
  const [pageCount, setPageCount] = useState(1);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: collections.length };
    for (const c of collections) {
      const k = collectionKind(c.slug);
      map[k] = (map[k] ?? 0) + 1;
    }
    return map;
  }, [collections]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = collections.filter((c) => {
      if (kind !== "all" && collectionKind(c.slug) !== kind) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q)
      );
    });
    list = [...list];

    // Hand-picked slugs that should always lead the list, mirroring
    // the home page Featured Collections strip. Anything in this set
    // outranks the user-selected sort; collections outside this set
    // fall through to the requested sort.
    const PRIORITY_SLUGS = [
      "franchise-pokemon",
      "franchise-league-of-legends",
      "franchise-jojos-bizarre-adventure",
    ];
    const priorityIndex = new Map(PRIORITY_SLUGS.map((s, i) => [s, i]));

    list.sort((a, b) => {
      const ai = priorityIndex.get(a.slug);
      const bi = priorityIndex.get(b.slug);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      if (sort === "size") return b.petCount - a.petCount;
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [collections, query, kind, sort]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on filter/query/sort change
  useEffect(() => {
    setPageCount(1);
  }, [query, kind, sort]);

  const visibleSlice = useMemo(
    () => visible.slice(0, pageCount * PAGE_SIZE),
    [visible, pageCount],
  );
  const hasMore = visibleSlice.length < visible.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    // Throttle: ignore re-intersections within 400ms of the last tick.
    // Without this, the observer fires once when mounted (sentinel is
    // already inside the rootMargin window), pageCount goes 1 -> 2,
    // re-renders the grid, the sentinel moves down, still inside the
    // window, fires again, repeats until hasMore goes false. Result is
    // a cascade of mounts in idle. The throttle lets the scroll position
    // settle before we accept the next intersection.
    let lastTick = 0;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const now = Date.now();
        if (now - lastTick < 400) return;
        lastTick = now;
        setPageCount((p) => p + 1);
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore]);

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    [],
  );
  const handleSortChange = useCallback((v: SortKey | null) => {
    if (v) setSort(v);
  }, []);
  const handleKindClick = useCallback(
    (value: KindFilterValue) => setKind(value),
    [],
  );

  const kindFilterLabel = (value: KindFilterValue): string => {
    if (value === "all") return t("filters.all");
    if (value === "franchise") return t("filters.franchise");
    if (value === "category") return t("filters.category");
    if (value === "category-sub") return t("filters.categorySub");
    return t("filters.other");
  };

  const sortLabel = (value: SortKey): string => {
    if (value === "size") return t("sort.size");
    return t("sort.title");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <InputGroup className="h-11 flex-1 rounded-full bg-background/40">
            <InputGroupAddon align="inline-start">
              <Search className="size-4 text-muted-3" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              onChange={handleQueryChange}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="text-sm placeholder:text-muted-3"
            />
          </InputGroup>
          <Select value={sort} onValueChange={handleSortChange}>
            <SelectTrigger
              aria-label={t("sortAria")}
              className="w-full shrink-0 sm:w-auto sm:min-w-[180px]"
            >
              <span className="text-muted-3">{t("sortPrefix")}</span>
              <span className="text-foreground">
                {SORT_KEYS.find((k) => k === sort) ? sortLabel(sort) : null}
              </span>
            </SelectTrigger>
            <SelectContent align="end">
              {SORT_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {sortLabel(key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {KIND_FILTER_KEYS.map((value) => {
            const c =
              counts[value === "category-sub" ? "category-sub" : value] ?? 0;
            return (
              <KindChip
                key={value}
                value={value}
                label={kindFilterLabel(value)}
                count={c}
                active={kind === value}
                onClick={handleKindClick}
              />
            );
          })}
          <span className="ml-auto text-xs text-muted-3">
            {t("showingCount", {
              visible: visibleSlice.length,
              total: visible.length,
            })}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
          {t("empty")}
        </div>
      ) : (
        <div className="grid auto-rows-fr gap-5 md:grid-cols-2 lg:grid-cols-3">
          {visibleSlice.map((c) => {
            const owner = c.ownerId ? credits[c.ownerId] : null;
            return <CollectionCard key={c.slug} collection={c} owner={owner} />;
          })}
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
      ) : visible.length > PAGE_SIZE ? (
        <p className="pt-2 text-center text-xs text-muted-3">
          {t("endOfResults", { count: visible.length })}
        </p>
      ) : null}
    </div>
  );
}

const KindChip = memo(function KindChip({
  value,
  label,
  count,
  active,
  onClick,
}: {
  value: KindFilterValue;
  label: string;
  count: number;
  active: boolean;
  onClick: (value: KindFilterValue) => void;
}) {
  const handleClick = useCallback(() => onClick(value), [onClick, value]);
  return (
    <Toggle variant="chip" size="chip" pressed={active} onClick={handleClick}>
      {label}
      <Badge
        variant="secondary"
        className="ml-0.5 rounded-full px-1.5 font-mono text-[10px] tracking-wider"
      >
        {count}
      </Badge>
    </Toggle>
  );
});

const CollectionCard = memo(function CollectionCard({
  collection: c,
  owner,
}: {
  collection: CollectionItem;
  owner: OwnerCredit | null;
}) {
  const t = useTranslations("collectionsBrowser");
  const k = collectionKind(c.slug);
  const kindKey = KIND_SLUG[k] as
    | "franchise"
    | "category"
    | "categorySub"
    | "other";
  return (
    // Same surface treatment as PetCard: neutral border, bg-surface/76,
    // backdrop-blur, small shadow, hover lifts + goes white/stone.
    // The has-[[aria-expanded=true]]:z-30 selector is preserved so the
    // CollectionActionMenu dropdown escapes stacking context siblings.
    <article
      data-slot="card"
      className="group relative flex h-full flex-col overflow-hidden rounded-3xl border border-black/10 bg-surface/76 shadow-sm shadow-blue-950/5 backdrop-blur transition has-[[aria-expanded=true]]:z-30 hover:-translate-y-0.5 hover:bg-white hover:shadow-xl hover:shadow-blue-950/10 dark:border-white/10 dark:hover:bg-stone-800"
    >
      <Link href={`/collections/${c.slug}`} prefetch={false} className="block">
        <CollectionCover
          pets={c.pets}
          coverSlug={c.coverPetSlug}
          max={5}
          scale={0.55}
        />
      </Link>
      <div className="absolute top-3 right-3 z-20">
        <CollectionActionMenu
          collection={{
            slug: c.slug,
            title: c.title,
            petCount: c.petCount,
            pets: c.pets.map((p) => ({ slug: p.slug })),
          }}
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 border-t border-black/[0.06] px-5 pt-4 pb-5 dark:border-white/[0.06]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-brand-tint px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-brand-deep uppercase dark:bg-brand-tint-dark dark:text-brand-light">
                {t(`kindLabel.${kindKey}`)}
              </span>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                {t("card.petCount", { count: c.petCount })}
              </span>
            </div>
            <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
              <Link href={`/collections/${c.slug}`} prefetch={false}>
                {c.title}
              </Link>
            </h3>
          </div>
          {c.externalUrl ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              render={
                <Link href={c.externalUrl} target="_blank" rel="noreferrer" />
              }
            >
              <ExternalLink className="size-3" />
              {t("card.siteLink")}
            </Button>
          ) : null}
        </div>
        <p className="line-clamp-2 text-sm leading-6 text-muted-2">
          {c.description}
        </p>
        {owner ? (
          <div className="mt-auto border-t border-black/[0.05] pt-2 dark:border-white/[0.05]">
            <Link
              href={`/u/${owner.handle}`}
              prefetch={false}
              className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase hover:text-foreground"
            >
              {t("card.byOwner", { name: owner.name })}
            </Link>
          </div>
        ) : null}
      </div>
    </article>
  );
});
