"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Heart, Layers, PawPrint } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import type { EditableCollection } from "@/components/collection-editor";
import { GalleryReorderGrid } from "@/components/gallery-reorder-grid";
import { ClaimableBanner, type Submission } from "@/components/my-pets-view";
import {
  type OwnerCollection,
  OwnerCollectionsManager,
} from "@/components/owner-collections-manager";
import { PetCard } from "@/components/pet-gallery";

// Tabs surface for /u/<handle>. Owner sees Pets (all statuses with
// badges), Liked, Collections (with editor). Visitor sees Pets
// (approved-only), Liked (if any), Collections (read-only). The
// public-vs-owner gating is decided server-side in page.tsx; this
// component just renders whatever it gets.

export type ProfileTabsProps = {
  isOwner: boolean;
  publicHandle: string;
  // Approved pets shown to everyone. When isOwner=true these are
  // already deduplicated against pinnedSlugs in the parent.
  approvedPets: PetWithMetrics[];
  // Owner-only: in-flight submissions (pending + rejected) shown as
  // SubmissionCard. Empty array for visitors.
  ownerSubmissions: Submission[];
  // Pets the owner has liked. Surfaced to everyone (taste signal,
  // like GitHub starred repos). Empty array when there are none.
  likedPets: PetWithMetrics[];
  // Collection state. null when there's nothing yet.
  collection: EditableCollection;
  canManageCollections: boolean;
  // Approved pets the editor uses to build the cover/grid. Same data
  // as approvedPets but in the lighter shape the CollectionEditor
  // expects.
  collectionApprovedPets: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
  }[];
  // Owner-only pin state passed through to the Approved cards so each
  // can render its own pin/unpin overlay. Visitors get null.
  pinning?: {
    pinnedSlugs: string[];
    maxPins: number;
    onPinChange?: (slug: string, isPinned: boolean) => void;
    pinActionsDisabled?: boolean;
  } | null;
  // Owner-only: every collection this user owns (personal + featured).
  // When present and isOwner, the Collections tab swaps to the multi
  // collection manager. Visitors keep the old single-collection view.
  ownerCollections?: OwnerCollection[];
  maxOwnerCollections?: number;
};

type TabKey = "pets" | "liked" | "collections";

export function ProfileTabs(props: ProfileTabsProps) {
  const {
    isOwner,
    publicHandle,
    approvedPets,
    ownerSubmissions,
    likedPets,
    collection,
    canManageCollections,
    collectionApprovedPets,
    pinning,
    ownerCollections,
    maxOwnerCollections,
  } = props;

  // Pre-build the lookup once instead of per-card. The Set isn't worth
  // it for the typical 6-pin cap, but we guard against the rare 100+
  // owner with .includes().
  const pinnedSet = pinning ? new Set(pinning.pinnedSlugs) : null;
  const pinnedCount = pinning?.pinnedSlugs.length ?? 0;

  const stateCount = petStates.length;

  // Owner sees pending + rejected as a top section above approved.
  // Visitors do not see ownerSubmissions at all (they get [] from
  // the server).
  const pendingSubmissions = ownerSubmissions.filter(
    (s) => s.status === "pending",
  );
  const rejectedSubmissions = ownerSubmissions.filter(
    (s) => s.status === "rejected",
  );

  const showCollectionsTab = isOwner
    ? Boolean(collection) ||
      canManageCollections ||
      (ownerCollections && ownerCollections.length > 0)
    : Boolean(collection) || (ownerCollections && ownerCollections.length > 0);
  const showLikedTab = likedPets.length > 0;

  const t = useTranslations("profile");
  const [tab, setTab] = useState<TabKey>("pets");
  const isZh = useLocale() === "zh";

  // Honor #liked / #collections / #pets so deep-links from notifications
  // and emails land on the right tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const hash = window.location.hash.replace("#", "").toLowerCase();
      if (hash === "liked" && showLikedTab) setTab("liked");
      else if (hash === "collections" && showCollectionsTab)
        setTab("collections");
      else if (hash === "pets") setTab("pets");
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [showCollectionsTab, showLikedTab]);

  const totalPets = approvedPets.length + ownerSubmissions.length;

  return (
    <div className="space-y-6">
      {isOwner ? <ClaimableBanner /> : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.08] pb-3 dark:border-white/[0.08]">
        <TabButton
          active={tab === "pets"}
          onClick={() => setTab("pets")}
          icon={<PawPrint className="size-3.5" />}
          label={t("petsTab")}
          count={totalPets}
        />
        {showLikedTab ? (
          <TabButton
            active={tab === "liked"}
            onClick={() => setTab("liked")}
            icon={<Heart className="size-3.5" />}
            label={t("likedTab")}
            count={likedPets.length}
          />
        ) : null}
        {showCollectionsTab ? (
          <TabButton
            active={tab === "collections"}
            onClick={() => setTab("collections")}
            icon={<Layers className="size-3.5" />}
            label={t("collectionsTab")}
            count={collection ? 1 : 0}
          />
        ) : null}
        {isOwner ? (
          <Link
            href="/submit"
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            {t("submitPet")}
          </Link>
        ) : null}
      </div>

      {tab === "pets" ? (
        <PetsPanel
          isOwner={isOwner}
          publicHandle={publicHandle}
          approvedPets={approvedPets}
          pendingSubmissions={pendingSubmissions}
          rejectedSubmissions={rejectedSubmissions}
          stateCount={stateCount}
          pinnedSet={pinnedSet}
          pinnedCount={pinnedCount}
          maxPins={pinning?.maxPins ?? null}
          onPinChange={pinning?.onPinChange}
          pinActionsDisabled={pinning?.pinActionsDisabled}
          isZh={isZh}
          approvedLabel={(count: number) => t("approvedSection", { count })}
        />
      ) : null}

      {tab === "liked" && showLikedTab ? (
        <LikedPanel pets={likedPets} stateCount={stateCount} isZh={isZh} />
      ) : null}

      {tab === "collections" && showCollectionsTab ? (
        <CollectionsPanel
          isOwner={isOwner}
          canManageCollections={canManageCollections}
          collection={collection}
          collectionApprovedPets={collectionApprovedPets}
          publicHandle={publicHandle}
          ownerCollections={ownerCollections}
          maxOwnerCollections={maxOwnerCollections}
        />
      ) : null}
    </div>
  );
}

function PetsPanel({
  isOwner,
  publicHandle: _publicHandle,
  approvedPets,
  pendingSubmissions,
  rejectedSubmissions,
  stateCount,
  pinnedSet,
  pinnedCount,
  maxPins,
  onPinChange,
  pinActionsDisabled,
  isZh,
  approvedLabel,
}: {
  isOwner: boolean;
  publicHandle: string;
  approvedPets: PetWithMetrics[];
  pendingSubmissions: Submission[];
  rejectedSubmissions: Submission[];
  stateCount: number;
  pinnedSet: Set<string> | null;
  pinnedCount: number;
  maxPins: number | null;
  onPinChange?: (slug: string, isPinned: boolean) => void;
  pinActionsDisabled?: boolean;
  isZh: boolean;
  approvedLabel: (count: number) => string;
}) {
  if (
    approvedPets.length === 0 &&
    pendingSubmissions.length === 0 &&
    rejectedSubmissions.length === 0
  ) {
    return (
      <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-12 text-center">
        <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
          No pets yet
        </p>
        <p className="mt-3 text-base text-muted-2">
          {isOwner
            ? "Once you submit a pet and it gets approved, it shows up here."
            : "This creator has not shipped a public pet yet."}
        </p>
        {isOwner ? (
          <Link
            href="/submit"
            className="mt-5 inline-flex h-10 items-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            Submit your first pet
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Live pets first — what visitors care about, what owners see
          as their portfolio. */}
      {approvedPets.length > 0 ? (
        <section className="space-y-3">
          {isOwner &&
          (pendingSubmissions.length > 0 || rejectedSubmissions.length > 0) ? (
            <header>
              <p className="font-mono text-[11px] tracking-[0.22em] text-chip-success-fg uppercase">
                {approvedLabel(approvedPets.length)}
              </p>
            </header>
          ) : null}
          {(() => {
            const grid = (
              <div
                className={cn(
                  "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
                  isZh && "sm:gap-3",
                )}
              >
                {approvedPets.map((pet, index) => (
                  <PetCard
                    key={pet.slug}
                    pet={pet}
                    index={index}
                    stateCount={stateCount}
                    hideAuthor
                    ownerActions={
                      isOwner
                        ? { submissionId: pet.id, status: "approved" }
                        : undefined
                    }
                    pinState={
                      isOwner && pinnedSet && maxPins != null
                        ? {
                            isPinned: pinnedSet.has(pet.slug),
                            pinnedCount,
                            maxPins,
                            onPinChange: (isPinned) =>
                              onPinChange?.(pet.slug, isPinned),
                            disabled: pinActionsDisabled,
                            disabledTitle: "Pinned order is saving",
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            );
            // Owner with 2+ approved pets gets the "Edit order" toggle
            // that swaps to a drag-reorder grid. Visitors and owners
            // with 1 pet just see the regular grid.
            if (isOwner && approvedPets.length >= 2) {
              return (
                <GalleryReorderGrid pets={approvedPets}>
                  {grid}
                </GalleryReorderGrid>
              );
            }
            return grid;
          })()}
        </section>
      ) : null}

      {/* Pending review — owner-only. Same card shape, status pill
          overlays the dex row so it reads as one continuous grid. */}
      {pendingSubmissions.length > 0 ? (
        <section className="space-y-3">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <p className="font-mono text-[11px] tracking-[0.22em] text-chip-warning-fg uppercase">
              Pending review ({pendingSubmissions.length})
            </p>
            <p className="text-xs text-muted-3">
              Visible only to you until an admin approves.
            </p>
          </header>
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
              isZh && "sm:gap-3",
            )}
          >
            {pendingSubmissions.map((submission, index) => (
              <PetCard
                key={submission.id}
                pet={submissionToPet(submission)}
                index={index}
                stateCount={stateCount}
                hideAuthor
                statusOverlay={{ label: "Pending", tone: "warning" }}
                ownerActions={{
                  submissionId: submission.id,
                  status: "pending",
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Rejected — owner-only. The rejection reason still surfaces on
          the pet detail page; the menu offers a Submit new version
          link as the natural next step. */}
      {rejectedSubmissions.length > 0 ? (
        <section className="space-y-3">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <p className="font-mono text-[11px] tracking-[0.22em] text-chip-danger-fg uppercase">
              Rejected ({rejectedSubmissions.length})
            </p>
            <p className="text-xs text-muted-3">
              Visible only to you. Submit a fresh version when ready.
            </p>
          </header>
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
              isZh && "sm:gap-3",
            )}
          >
            {rejectedSubmissions.map((submission, index) => (
              <PetCard
                key={submission.id}
                pet={submissionToPet(submission)}
                index={index}
                stateCount={stateCount}
                hideAuthor
                statusOverlay={{ label: "Rejected", tone: "danger" }}
                ownerActions={{
                  submissionId: submission.id,
                  status: "rejected",
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// Pending and rejected submissions never make it through rowToPet
// because the gallery queries filter on status='approved'. Build a
// PetWithMetrics-shaped object here so PetCard can render them with
// the same layout as the rest of the grid.
function submissionToPet(submission: Submission): PetWithMetrics {
  return {
    id: submission.id,
    slug: submission.slug,
    // A queued name edit lives in pending.displayName until an admin
    // approves it. Surface it here so the owner sees their rename in
    // flight instead of the stale live name (e.g. "Untitled pet").
    displayName: submission.pending?.displayName ?? submission.displayName,
    description: submission.description,
    spritesheetPath: submission.spritesheetUrl,
    petJsonPath: "",
    zipUrl: submission.zipUrl,
    soundUrl: null,
    approvalState:
      submission.status === "approved" ? "approved" : "needs-review",
    featured: submission.featured,
    kind: submission.kind as PetWithMetrics["kind"],
    vibes: submission.vibes as PetWithMetrics["vibes"],
    tags: submission.tags,
    dominantColor: null,
    colorFamily: null,
    submittedBy: undefined,
    source: "submit",
    approvedAt: submission.approvedAt,
    importedAt: submission.createdAt,
    qa: {},
    metrics: submission.metrics,
  };
}

function LikedPanel({
  pets,
  stateCount,
  isZh,
}: {
  pets: PetWithMetrics[];
  stateCount: number;
  isZh: boolean;
}) {
  return (
    <section className="space-y-4">
      <header>
        <p className="text-sm leading-6 text-muted-2">
          Pets caught with the heart, most recent first. Tap a card to revisit,
          install, or unlike.
        </p>
      </header>
      <div
        className={cn(
          "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
          isZh && "sm:gap-3",
        )}
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
    </section>
  );
}

function CollectionsPanel({
  isOwner,
  canManageCollections,
  collection,
  collectionApprovedPets,
  publicHandle,
  ownerCollections,
  maxOwnerCollections,
}: {
  isOwner: boolean;
  canManageCollections: boolean;
  collection: EditableCollection;
  collectionApprovedPets: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
  }[];
  publicHandle: string;
  ownerCollections?: OwnerCollection[];
  maxOwnerCollections?: number;
}) {
  // Owner-side: multi-collection manager. Lists every collection the
  // user owns (personal + featured) and lets them create/edit/delete
  // the personal ones. Featured ones show as read-only chips.
  if (isOwner && canManageCollections) {
    return (
      <OwnerCollectionsManager
        collections={ownerCollections ?? []}
        approvedPets={collectionApprovedPets}
        maxCollections={maxOwnerCollections ?? 10}
        publicHandle={publicHandle}
      />
    );
  }

  // Visitor view: list every public/personal collection the creator
  // has. If they only have one, fall back to the older single-card UI.
  const visibleCollections = ownerCollections ?? [];
  if (visibleCollections.length === 0 && !collection) {
    return (
      <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
        No collections yet.
      </div>
    );
  }

  if (visibleCollections.length > 0) {
    return (
      <div className="space-y-3">
        {visibleCollections.map((c) => (
          <article
            key={c.id}
            className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur"
          >
            <div className="flex flex-wrap items-center gap-2">
              {c.featured ? (
                <span className="inline-flex items-center rounded-full bg-brand-tint px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-brand-deep uppercase dark:bg-brand-tint-dark dark:text-brand-light">
                  Curated
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-border-base bg-surface px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-muted-3 uppercase">
                  Personal
                </span>
              )}
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                {c.petCount} pets
              </span>
            </div>
            <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
              <Link
                href={`/collections/${c.slug}`}
                prefetch={false}
                className="hover:underline"
              >
                {c.title}
              </Link>
            </h3>
            {c.description ? (
              <p className="mt-1 line-clamp-2 text-sm text-muted-2">
                {c.description}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    );
  }

  // Legacy fallback: only one collection in the prop pipeline. Render
  // the old hero card.
  return (
    <section className="rounded-3xl border border-border-base bg-surface/80 p-6 backdrop-blur md:p-8">
      <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
        Featured collection
      </p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
        {collection?.title}
      </h3>
      <p className="mt-3 max-w-3xl text-base leading-7 text-muted-2">
        {collection?.description}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href={`/collections/${collection?.slug}`}
          prefetch={false}
          className="inline-flex h-10 items-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          View collection
        </Link>
        <span className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
          {collection?.petSlugs.length}{" "}
          {collection?.petSlugs.length === 1 ? "pet" : "pets"} · @{publicHandle}
        </span>
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition ${
        active
          ? "border-inverse bg-inverse text-on-inverse"
          : "border-border-base bg-surface text-foreground hover:border-border-strong"
      }`}
    >
      {icon}
      {label}
      <span
        className={`text-[10px] ${active ? "text-on-inverse/60" : "opacity-60"}`}
      >
        {count}
      </span>
    </button>
  );
}
