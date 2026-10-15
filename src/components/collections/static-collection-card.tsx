import Link from "next/link";

import {
  type CollectionKind,
  collectionKind,
  KIND_SLUG,
} from "@/lib/collection-kind";
import type { OwnerCredit } from "@/lib/owner-credit";
import { petStates } from "@/lib/pet-states";

import type { CollectionCoverPet } from "@/components/collections/collection-cover";
import { StaticPetSprite } from "@/components/pets/static-pet-sprite";

type StaticCollectionCardProps = {
  collection: {
    slug: string;
    title: string;
    description: string;
    ownerId: string | null;
    externalUrl: string | null;
    coverPetSlug: string | null;
    petCount: number;
    pets: CollectionCoverPet[];
  };
  owner: OwnerCredit | null;
  labels: {
    kind: Record<"franchise" | "category" | "categorySub" | "other", string>;
    petCount: string;
    siteLink: string;
    byOwner: string | null;
    spriteStill: (name: string) => string;
  };
};

export function StaticCollectionCard({
  collection,
  owner,
  labels,
}: StaticCollectionCardProps) {
  const kind = KIND_SLUG_KEY(collectionKind(collection.slug));

  return (
    <article
      data-slot="card"
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border-base bg-surface/60 backdrop-blur transition hover:border-brand/35 hover:bg-surface"
    >
      <Link
        href={`/collections/${collection.slug}`}
        prefetch={false}
        aria-label={collection.title}
      >
        <StaticCollectionCover
          pets={collection.pets}
          coverSlug={collection.coverPetSlug}
          max={5}
          scale={0.55}
          spriteLabel={labels.spriteStill}
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2 border-t border-border-base px-5 pt-4 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-brand/15 px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-brand uppercase ring-1 ring-brand/25">
                {labels.kind[kind]}
              </span>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                {labels.petCount}
              </span>
            </div>
            <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
              <Link href={`/collections/${collection.slug}`} prefetch={false}>
                {collection.title}
              </Link>
            </h3>
          </div>
          {collection.externalUrl ? (
            <Link
              href={collection.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center justify-center rounded-full border border-border-base bg-surface/70 px-3 text-muted-2 text-xs backdrop-blur transition hover:bg-surface-muted hover:text-foreground"
            >
              {labels.siteLink}
            </Link>
          ) : null}
        </div>
        <p className="line-clamp-2 text-sm leading-6 text-muted-2">
          {collection.description}
        </p>
        {owner && labels.byOwner ? (
          <div className="mt-auto border-t border-border-base pt-2">
            <Link
              href={`/u/${owner.handle}`}
              prefetch={false}
              className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase hover:text-foreground"
            >
              {labels.byOwner}
            </Link>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function StaticCollectionCover({
  pets,
  coverSlug,
  max = 5,
  scale = 0.55,
  className = "",
  spriteLabel,
}: {
  pets: CollectionCoverPet[];
  coverSlug: string | null;
  max?: number;
  scale?: number;
  className?: string;
  spriteLabel: (name: string) => string;
}) {
  if (pets.length === 0) {
    return (
      <div
        aria-hidden="true"
        className={`pet-sprite-stage relative grid aspect-[16/9] place-items-center overflow-hidden ${className}`}
      >
        <span className="size-12 rounded-full border border-border-base/70 bg-surface/70 shadow-inner shadow-blue-950/5" />
      </div>
    );
  }

  const coverPet = coverSlug
    ? (pets.find((p) => p.slug === coverSlug) ?? null)
    : null;
  const otherPets = pets.filter((p) => p.slug !== coverPet?.slug);
  const lineup = (coverPet ? [coverPet, ...otherPets] : otherPets).slice(
    0,
    max,
  );

  if (lineup.length === 1) {
    const pet = lineup[0];
    return (
      <div
        className={`pet-sprite-stage relative grid aspect-[16/9] place-items-center overflow-hidden ${className}`}
      >
        <StaticPetSprite
          src={pet.spritesheetPath}
          state={petStates[hashSlug(pet.slug) % petStates.length].id}
          scale={scale * 1.5}
          label={spriteLabel(pet.displayName)}
        />
      </div>
    );
  }

  const ordered = arrangeLineup(lineup);
  const n = ordered.length;
  const innerLeft = 8;
  const innerRight = 92;
  const innerSpan = innerRight - innerLeft;

  return (
    <div
      className={`pet-sprite-stage relative aspect-[16/9] overflow-hidden ${className}`}
    >
      {ordered.map((pet, index) => {
        const isLead =
          pet.slug === lineup[0].slug && index === Math.floor((n - 1) / 2);
        const hash = hashSlug(pet.slug);
        const xCenter =
          innerLeft + innerSpan * (n === 1 ? 0.5 : index / (n - 1));
        const yCenter = isLead ? 0.55 : 0.5 + (frac(hash, 1) - 0.5) * 0.2;
        const petScale = scale * (isLead ? 1.3 : 0.9 + frac(hash, 2) * 0.25);
        const zIndex = isLead ? n + 10 : 5 + Math.floor(frac(hash, 3) * n);

        return (
          <div
            key={pet.slug}
            className="pointer-events-none absolute flex items-center justify-center"
            style={{
              left: `${xCenter}%`,
              top: `${yCenter * 100}%`,
              transform: "translate(-50%, -50%)",
              zIndex,
              width: `${(innerSpan / Math.max(n - 1, 1)) * 1.4}%`,
              height: "100%",
            }}
          >
            <StaticPetSprite
              src={pet.spritesheetPath}
              state={petStates[hash % petStates.length].id}
              scale={petScale}
              label={spriteLabel(pet.displayName)}
            />
          </div>
        );
      })}
    </div>
  );
}

function arrangeLineup(lineup: CollectionCoverPet[]) {
  const count = lineup.length;
  if (count <= 1) return lineup;
  const [lead, ...rest] = lineup;
  const middle = Math.floor((count - 1) / 2);
  const arranged = Array.from({ length: count }, () => lead);
  arranged[middle] = lead;
  let leftCursor = middle - 1;
  let rightCursor = middle + 1;
  let left = true;
  for (const pet of rest) {
    if (left && leftCursor >= 0) {
      arranged[leftCursor] = pet;
      leftCursor -= 1;
    } else if (rightCursor < count) {
      arranged[rightCursor] = pet;
      rightCursor += 1;
    } else if (leftCursor >= 0) {
      arranged[leftCursor] = pet;
      leftCursor -= 1;
    }
    left = !left;
  }
  return arranged;
}

function hashSlug(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function frac(hash: number, salt: number) {
  const value = Math.sin(hash * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function KIND_SLUG_KEY(kind: CollectionKind) {
  return KIND_SLUG[kind] as "franchise" | "category" | "categorySub" | "other";
}
