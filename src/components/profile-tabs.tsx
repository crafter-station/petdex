"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Heart, Layers, PawPrint } from "lucide-react";

import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";

import {
  CollectionEditor,
  type EditableCollection,
} from "@/components/collection-editor";
import { ClaimableBanner, type Submission } from "@/components/my-pets-view";
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
  } | null;
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
    ? Boolean(collection) || canManageCollections
    : Boolean(collection);
  const showLikedTab = likedPets.length > 0;

  const [tab, setTab] = useState<TabKey>("pets");

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
          label="Pets"
          count={totalPets}
        />
        {showLikedTab ? (
          <TabButton
            active={tab === "liked"}
            onClick={() => setTab("liked")}
            icon={<Heart className="size-3.5" />}
            label="Liked"
            count={likedPets.length}
          />
        ) : null}
        {showCollectionsTab ? (
          <TabButton
            active={tab === "collections"}
            onClick={() => setTab("collections")}
            icon={<Layers className="size-3.5" />}
            label="Collections"
            count={collection ? 1 : 0}
          />
        ) : null}
        {isOwner ? (
          <Link
            href="/submit"
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            Submit pet
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
        />
      ) : null}

      {tab === "liked" && showLikedTab ? (
        <LikedPanel pets={likedPets} stateCount={stateCount} />
      ) : null}

      {tab === "collections" && showCollectionsTab ? (
        <CollectionsPanel
          isOwner={isOwner}
          canManageCollections={canManageCollections}
          collection={collection}
          collectionApprovedPets={collectionApprovedPets}
          publicHandle={publicHandle}
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
                Approved ({approvedPets.length})
              </p>
            </header>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {approvedPets.map((pet, index) => (
              <PetCard
                key={pet.slug}
                pet={pet}
                index={index}
                stateCount={stateCount}
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
                      }
                    : undefined
                }
              />
            ))}
          </div>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {pendingSubmissions.map((submission, index) => (
              <PetCard
                key={submission.id}
                pet={submissionToPet(submission)}
                index={index}
                stateCount={stateCount}
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {rejectedSubmissions.map((submission, index) => (
              <PetCard
                key={submission.id}
                pet={submissionToPet(submission)}
                index={index}
                stateCount={stateCount}
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
    displayName: submission.displayName,
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
}: {
  pets: PetWithMetrics[];
  stateCount: number;
}) {
  return (
    <section className="space-y-4">
      <header>
        <p className="text-sm leading-6 text-muted-2">
          Pets caught with the heart, most recent first. Tap a card to revisit,
          install, or unlike.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
}) {
  if (isOwner && canManageCollections) {
    return (
      <CollectionEditor
        approvedPets={collectionApprovedPets}
        initial={collection}
        profileHandle={publicHandle}
      />
    );
  }
  if (!collection) {
    return (
      <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
        No collection yet.
      </div>
    );
  }
  // Visitor view: read-only summary linking to the public collection page.
  return (
    <section className="rounded-3xl border border-border-base bg-surface/80 p-6 backdrop-blur md:p-8">
      <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
        Featured collection
      </p>
      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
        {collection.title}
      </h3>
      <p className="mt-3 max-w-3xl text-base leading-7 text-muted-2">
        {collection.description}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href={`/collections/${collection.slug}`}
          className="inline-flex h-10 items-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          View collection
        </Link>
        <span className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
          {collection.petSlugs.length}{" "}
          {collection.petSlugs.length === 1 ? "pet" : "pets"} · @{publicHandle}
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
