import { getTranslations } from "next-intl/server";

import {
  listAllSubmittedPetsWithLatestReview,
  type SubmittedPetWithReview,
} from "@/lib/db/queries";
import { resolveOwnerCredits } from "@/lib/owner-credit";
import { petStates } from "@/lib/pet-states";

import { AdminReviewRow } from "@/components/admin-review-row";
import { AdminStatusFilter } from "@/components/admin-status-filter";

export type SubmissionReviewQueueSearchParams = { status?: string };

type Filter =
  | "all"
  | "pending"
  | "held"
  | "review_failed"
  | "auto_approved"
  | "auto_rejected"
  | "approved"
  | "rejected"
  | "discovered";

export async function SubmissionReviewQueue({
  locale,
  searchParams,
  actionScope = "admin",
}: {
  locale: string;
  searchParams: SubmissionReviewQueueSearchParams;
  actionScope?: "admin" | "collaborator";
}) {
  const t = await getTranslations({ locale, namespace: "admin.queue" });
  const filter = (searchParams.status ?? "pending") as Filter;

  const pets = await listAllSubmittedPetsWithLatestReview();
  const counts = {
    all: pets.length,
    pending: pets.filter(
      (p) => p.status === "pending" && p.source !== "discover",
    ).length,
    held: pets.filter(
      (p) => p.status === "pending" && p.latestReview?.decision === "hold",
    ).length,
    review_failed: pets.filter((p) => p.latestReview?.status === "failed")
      .length,
    auto_approved: pets.filter(
      (p) => p.latestReview?.decision === "auto_approve",
    ).length,
    auto_rejected: pets.filter(
      (p) => p.latestReview?.decision === "auto_reject",
    ).length,
    approved: pets.filter((p) => p.status === "approved").length,
    rejected: pets.filter((p) => p.status === "rejected").length,
    discovered: pets.filter((p) => p.source === "discover").length,
  };

  const visible = filterPets(pets, filter);
  const prioritizedVisible =
    filter === "pending" || filter === "held" || filter === "review_failed"
      ? [...visible].sort(reviewPrioritySort)
      : visible;

  const credits = await resolveOwnerCredits(
    prioritizedVisible.map((p) => ({
      ownerId: p.ownerId,
      creditName: p.creditName,
      creditUrl: p.creditUrl,
      creditImage: p.creditImage,
    })),
  );

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pb-12 md:px-8 md:pb-16">
      <header className="space-y-3">
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          {t("eyebrow")}
        </p>
        <h1 className="text-4xl font-medium tracking-tight md:text-5xl">
          {t("title")}
        </h1>
        <AdminStatusFilter
          counts={counts}
          basePath={actionScope === "collaborator" ? "/collaborator" : "/admin"}
        />
      </header>

      {prioritizedVisible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
          {t("empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {prioritizedVisible.map((pet) => (
            <AdminReviewRow
              key={pet.id}
              pet={actionScope === "collaborator" ? stripOwnerEmail(pet) : pet}
              stateCount={petStates.length}
              ownerHandle={credits.get(pet.ownerId)?.handle}
              actionScope={actionScope}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function reviewPrioritySort(
  a: SubmittedPetWithReview,
  b: SubmittedPetWithReview,
): number {
  const priority = reviewPriority(a) - reviewPriority(b);
  if (priority !== 0) return priority;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function filterPets(
  pets: SubmittedPetWithReview[],
  filter: Filter,
): SubmittedPetWithReview[] {
  if (filter === "all") return pets;
  if (filter === "discovered")
    return pets.filter((p) => p.source === "discover");
  if (filter === "held") {
    return pets.filter(
      (p) => p.status === "pending" && p.latestReview?.decision === "hold",
    );
  }
  if (filter === "review_failed") {
    return pets.filter((p) => p.latestReview?.status === "failed");
  }
  if (filter === "auto_approved") {
    return pets.filter((p) => p.latestReview?.decision === "auto_approve");
  }
  if (filter === "auto_rejected") {
    return pets.filter((p) => p.latestReview?.decision === "auto_reject");
  }
  if (filter === "pending") {
    return pets.filter(
      (p) => p.status === "pending" && p.source !== "discover",
    );
  }
  return pets.filter((p) => p.status === filter);
}

function reviewPriority(pet: SubmittedPetWithReview): number {
  const review = pet.latestReview;
  if (!review) return 5;
  if (review.status === "failed") return 0;
  if (review.decision !== "hold") return 5;
  if (review.reasonCode?.includes("policy")) return 1;
  if (review.reasonCode?.includes("duplicate")) return 2;
  if (review.reasonCode?.includes("asset")) return 3;
  return 4;
}

function stripOwnerEmail(
  pet: SubmittedPetWithReview,
): Omit<SubmittedPetWithReview, "ownerEmail"> {
  const { ownerEmail: _ownerEmail, ...safePet } = pet;
  return safePet;
}
