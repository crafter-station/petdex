import Link from "next/link";

import { getTranslations } from "next-intl/server";

import { listApprovedSubmittedPetsForModeration } from "@/lib/db/queries";
import type { SubmittedPet } from "@/lib/db/schema";
import { resolveOwnerCredits } from "@/lib/owner-credit";
import { petStates } from "@/lib/pet-states";

import { AdminReviewRow } from "@/components/admin-review-row";

import { localizePath } from "@/i18n/config";

export type PublishedPetModerationSearchParams = {
  page?: string | string[];
  q?: string | string[];
};

const PAGE_SIZE = 25;

export async function PublishedPetModerationPage({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: PublishedPetModerationSearchParams;
}) {
  const t = await getTranslations({
    locale,
    namespace: "collaborator.moderation",
  });
  const query = firstParam(searchParams.q).trim();
  const page = parsePage(firstParam(searchParams.page));
  const pets = await listApprovedSubmittedPetsForModeration({
    query,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  const visible = pets.slice(0, PAGE_SIZE);
  const hasNext = pets.length > PAGE_SIZE;
  const hasPrevious = page > 1;
  const credits = await resolveOwnerCredits(
    visible.map((pet) => ({
      ownerId: pet.ownerId,
      creditName: pet.creditName,
      creditUrl: pet.creditUrl,
      creditImage: pet.creditImage,
      ownerIsProxy: pet.source === "discover",
    })),
  );
  const resetHref = moderationHref(locale);
  const previousHref = moderationHref(locale, query, page - 1);
  const nextHref = moderationHref(locale, query, page + 1);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pb-12 md:px-8 md:pb-16">
      <header className="space-y-4">
        <div className="space-y-3">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h1 className="text-4xl font-medium tracking-tight md:text-5xl">
            {t("title")}
          </h1>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          action=""
          method="get"
        >
          <input
            name="q"
            defaultValue={query}
            placeholder={t("searchPlaceholder")}
            className="h-10 min-w-0 flex-1 rounded-lg border border-border-base bg-surface px-3 text-sm text-foreground outline-none transition focus:border-border-strong"
          />
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            {t("search")}
          </button>
          {query ? (
            <Link
              href={resetHref}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-surface px-5 text-sm font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
            >
              {t("clear")}
            </Link>
          ) : null}
        </form>
      </header>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
          {t("empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((pet) => (
            <AdminReviewRow
              key={pet.id}
              pet={moderationPetForRow(pet)}
              stateCount={petStates.length}
              ownerHandle={
                pet.source === "discover"
                  ? undefined
                  : credits.get(pet.ownerId)?.handle
              }
              actionScope="moderator"
            />
          ))}
        </div>
      )}

      {hasPrevious || hasNext ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasPrevious ? (
            <Link
              href={previousHref}
              className="inline-flex h-9 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
            >
              {t("previous")}
            </Link>
          ) : null}
          {hasNext ? (
            <Link
              href={nextHref}
              className="inline-flex h-9 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
            >
              {t("next")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parsePage(value: string): number {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function moderationHref(locale: string, query = "", page = 1): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const pathname = localizePath(locale, "/collaborator/moderation");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function moderationPetForRow(pet: SubmittedPet) {
  return {
    createdAt: pet.createdAt,
    description: pet.description,
    displayName: pet.displayName,
    featured: pet.featured,
    id: pet.id,
    petJsonUrl: pet.petJsonUrl,
    slug: pet.slug,
    spritesheetUrl: pet.spritesheetUrl,
    status: pet.status,
    zipUrl: pet.zipUrl,
  };
}
