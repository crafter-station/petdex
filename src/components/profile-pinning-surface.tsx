"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Heart, TerminalSquare } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";
import { MAX_PINNED_PETS } from "@/lib/profiles";

import type { EditableCollection } from "@/components/collection-editor";
import type { Submission } from "@/components/my-pets-view";
import type { OwnerCollection } from "@/components/owner-collections-manager";
import { PetCard } from "@/components/pet-gallery";
import { PetSprite } from "@/components/pet-sprite";
import {
  applyPinChangeToPinnedSlugs,
  applyPinnedOrderChange,
} from "@/components/profile-pinning-state";
import { ProfileTabs } from "@/components/profile-tabs";

type OwnerPinnedReorderGridProps = {
  pets: PetWithMetrics[];
  petStateCount: number;
  hideAuthor?: boolean;
  onPinChange?: (slug: string, isPinned: boolean) => void;
  onOrderChange?: (slugs: string[]) => void;
  pinActionsDisabled?: boolean;
  onOrderSavePendingChange?: (isPending: boolean) => void;
};

const OwnerPinnedReorderGrid = dynamic<OwnerPinnedReorderGridProps>(
  () =>
    import("@/components/pinned-reorder-grid").then(
      (mod) => mod.PinnedReorderGrid,
    ),
  { ssr: false },
);

type ProfilePinningSurfaceProps = {
  isOwner: boolean;
  publicHandle: string;
  pets: PetWithMetrics[];
  initialPinnedSlugs: string[];
  ownerSubmissions: Submission[];
  likedPets: PetWithMetrics[];
  collection: EditableCollection;
  canManageCollections: boolean;
  collectionApprovedPets: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
  }[];
  ownerCollections: OwnerCollection[];
  maxOwnerCollections: number;
};

export function ProfilePinningSurface({
  isOwner,
  publicHandle,
  pets,
  initialPinnedSlugs,
  ownerSubmissions,
  likedPets,
  collection,
  canManageCollections,
  collectionApprovedPets,
  ownerCollections,
  maxOwnerCollections,
}: ProfilePinningSurfaceProps) {
  const locale = useLocale();
  const t = useTranslations("profile");
  const [optimisticPinnedSlugs, setOptimisticPinnedSlugs] =
    useState(initialPinnedSlugs);
  const [pinActionsLocked, setPinActionsLocked] = useState(false);

  useEffect(() => {
    setOptimisticPinnedSlugs(initialPinnedSlugs);
  }, [initialPinnedSlugs]);

  const petBySlug = useMemo(
    () => new Map(pets.map((pet) => [pet.slug, pet])),
    [pets],
  );
  const pinnedSlugs = isOwner ? optimisticPinnedSlugs : initialPinnedSlugs;
  const validPinnedSlugs = pinnedSlugs.filter((slug) => petBySlug.has(slug));
  const pinnedSet = new Set(validPinnedSlugs);
  const featuredPets = validPinnedSlugs
    .map((slug) => petBySlug.get(slug))
    .filter((pet): pet is PetWithMetrics => Boolean(pet));
  const restPets = pets.filter((pet) => !pinnedSet.has(pet.slug));

  const handlePinChange = useCallback(
    (slug: string, nextPinned: boolean) => {
      if (!isOwner) return;
      setOptimisticPinnedSlugs((current) =>
        applyPinChangeToPinnedSlugs(current, slug, nextPinned, MAX_PINNED_PETS),
      );
    },
    [isOwner],
  );

  const handlePinOrderChange = useCallback(
    (slugs: string[]) => {
      if (!isOwner) return;
      setOptimisticPinnedSlugs((current) =>
        applyPinnedOrderChange(current, slugs),
      );
    },
    [isOwner],
  );

  const handleOrderSavePendingChange = useCallback(
    (isPending: boolean) => {
      if (!isOwner) return;
      setPinActionsLocked(isPending);
    },
    [isOwner],
  );

  return (
    <>
      {featuredPets.length > 0 ? (
        isOwner ? (
          <OwnerPinnedReorderGrid
            pets={featuredPets}
            petStateCount={petStates.length}
            hideAuthor
            onPinChange={handlePinChange}
            onOrderChange={handlePinOrderChange}
            pinActionsDisabled={pinActionsLocked}
            onOrderSavePendingChange={handleOrderSavePendingChange}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
                ★ Pinned
              </p>
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
                {featuredPets.length} of {MAX_PINNED_PETS}
              </p>
            </div>
            {featuredPets.length === 1 ? (
              <div className="relative">
                <FeaturedPin
                  pet={featuredPets[0]}
                  locale={locale}
                  installsLabel={(count: string) => t("installs", { count })}
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-6">
                {featuredPets.map((pet, index) => (
                  <div key={pet.slug} className="relative h-full">
                    <PetCard
                      pet={pet}
                      index={index}
                      stateCount={petStates.length}
                      hideAuthor
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      ) : null}

      <ProfileTabs
        isOwner={isOwner}
        publicHandle={publicHandle}
        approvedPets={restPets}
        ownerSubmissions={ownerSubmissions}
        likedPets={likedPets}
        collection={collection}
        canManageCollections={canManageCollections}
        collectionApprovedPets={collectionApprovedPets}
        pinning={
          isOwner
            ? {
                pinnedSlugs: validPinnedSlugs,
                maxPins: MAX_PINNED_PETS,
                onPinChange: handlePinChange,
                pinActionsDisabled: pinActionsLocked,
              }
            : null
        }
        ownerCollections={ownerCollections}
        maxOwnerCollections={maxOwnerCollections}
      />
    </>
  );
}

function FeaturedPin({
  pet,
  locale,
  installsLabel,
}: {
  pet: PetWithMetrics;
  locale: string;
  installsLabel: (count: string) => string;
}) {
  return (
    <Link
      href={`/pets/${pet.slug}`}
      prefetch={false}
      aria-label={`Open ${pet.displayName}`}
      className="featured-pin-card group relative flex flex-col overflow-hidden rounded-3xl border border-brand-light/45 bg-surface/80 backdrop-blur transition hover:bg-white md:flex-row md:items-stretch dark:hover:bg-stone-800"
    >
      <div className="pet-sprite-stage featured-pin-stage flex shrink-0 items-center justify-center px-8 py-10 md:w-[420px] md:py-14">
        <PetSprite
          src={pet.spritesheetPath}
          cycleStates
          scale={1.1}
          label={`${pet.displayName} animated`}
        />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-3 border-t border-black/[0.06] p-6 md:border-t-0 md:border-l dark:border-white/[0.06]">
        <span className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
          ★ Pinned
        </span>
        <h2 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {pet.displayName}
        </h2>
        <p className="max-w-2xl text-base leading-7 text-muted-2">
          {pet.description}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {pet.metrics.likeCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <Heart className="size-3" />
              {formatLocalizedNumber(pet.metrics.likeCount, locale)}
            </span>
          ) : null}
          {pet.metrics.installCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <TerminalSquare className="size-3" />
              {installsLabel(
                formatLocalizedNumber(pet.metrics.installCount, locale),
              )}
            </span>
          ) : null}
          <span>{pet.kind}</span>
        </div>
      </div>
    </Link>
  );
}
