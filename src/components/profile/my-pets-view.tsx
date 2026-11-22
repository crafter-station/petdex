"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Heart,
  Mail,
  Plus,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import type { PendingEditView } from "@/lib/pet-edit-state";
import { petStates } from "@/lib/pet-states";
import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import {
  CollectionEditor,
  type EditableCollection,
} from "@/components/collections/collection-editor";
import { PetActionMenu } from "@/components/pets/pet-action-menu";
import { PetCard } from "@/components/pets/pet-gallery";
import { PetSprite } from "@/components/pets/pet-sprite";
import { OwnerEditPanel } from "@/components/profile/owner-edit-panel";
import {
  ProfileCard,
  type ProfileData,
} from "@/components/profile/profile-card";
import { ActionButton } from "@/components/ui/action-button";
import { Button, buttonVariants } from "@/components/ui/button";

type Submission = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  zipUrl: string;
  kind: string;
  vibes: string[];
  tags: string[];
  featured: boolean;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  pending: PendingEditView | null;
  pendingRejectionReason: string | null;
  metrics: {
    installCount: number;
    zipDownloadCount: number;
    likeCount: number;
  };
};

type Tab = "all" | "pending" | "approved" | "rejected";

export function MyPetsView({
  submissions,
  catchProgress,
  likedPets,
  canManageCollections,
  collection,
  profile,
}: {
  submissions: Submission[];
  catchProgress: { caught: number; total: number; pct: number };
  likedPets: PetWithMetrics[];
  canManageCollections: boolean;
  collection: EditableCollection;
  profile: ProfileData;
}) {
  const t = useTranslations("myPets");
  const [tab, setTab] = useState<Tab>("all");

  const counts = useMemo(() => {
    return {
      all: submissions.length,
      pending: submissions.filter((s) => s.status === "pending").length,
      approved: submissions.filter((s) => s.status === "approved").length,
      rejected: submissions.filter((s) => s.status === "rejected").length,
    };
  }, [submissions]);

  const filtered = useMemo(() => {
    if (tab === "all") return submissions;
    return submissions.filter((s) => s.status === tab);
  }, [submissions, tab]);

  if (submissions.length === 0) {
    return (
      <>
        <ProfileCard profile={profile} />
        <ClaimableBanner />
        {canManageCollections ? (
          <CollectionEditor
            approvedPets={profile.approvedPets}
            initial={collection}
            profileHandle={profile.handle}
          />
        ) : null}
        <AlbumProgress catchProgress={catchProgress} />
        <LikedPets pets={likedPets} />
        <EmptyState />
      </>
    );
  }

  return (
    <div className="space-y-8">
      <ProfileCard profile={profile} />
      <ClaimableBanner />
      {canManageCollections ? (
        <CollectionEditor
          approvedPets={profile.approvedPets}
          initial={collection}
          profileHandle={profile.handle}
        />
      ) : null}
      <header>
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-balance text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
          {t("submissionCount", { count: counts.all })}
        </h1>
        <p className="mt-3 max-w-xl text-base leading-7 text-muted-2">
          Approved submissions go live on your{" "}
          <a
            href={`/u/${profile.handle}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            public profile
          </a>
          . Pending stay private until reviewed; rejected ones are gone. Edit
          name, description or tags directly on each card. Changes go through a
          quick re-approval.
        </p>
      </header>

      <AlbumProgress catchProgress={catchProgress} />

      <LikedPets pets={likedPets} />

      <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.08] pb-3 dark:border-white/[0.08]">
        <TabButton
          active={tab === "all"}
          onClick={() => setTab("all")}
          label={t("tabs.all")}
          count={counts.all}
        />
        {counts.pending > 0 ? (
          <TabButton
            active={tab === "pending"}
            onClick={() => setTab("pending")}
            label={t("tabs.pending")}
            count={counts.pending}
            tone="amber"
          />
        ) : null}
        {counts.approved > 0 ? (
          <TabButton
            active={tab === "approved"}
            onClick={() => setTab("approved")}
            label={t("tabs.approved")}
            count={counts.approved}
            tone="emerald"
          />
        ) : null}
        {counts.rejected > 0 ? (
          <TabButton
            active={tab === "rejected"}
            onClick={() => setTab("rejected")}
            label={t("tabs.rejected")}
            count={counts.rejected}
            tone="rose"
          />
        ) : null}
        <Link
          href="/submit"
          className={cn(
            buttonVariants({ variant: "cobalt", size: "lg" }),
            "ml-auto",
          )}
        >
          <Plus className="size-3.5" />
          {t("submitAnother")}
        </Link>
      </div>

      {filtered.length === 0 ? (
        <p className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-10 text-center text-sm text-muted-2 dark:border-white/12">
          {t("emptyState")}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((s) => (
            <SubmissionCard key={s.id} submission={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumProgress({
  catchProgress,
}: {
  catchProgress: { caught: number; total: number; pct: number };
}) {
  return (
    <section className="toy-shell rounded-3xl border border-[#D4DCF4] p-5 dark:border-white/12">
      <p className="toy-tag text-brand">Your album</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-foreground">
        {catchProgress.caught}/{catchProgress.total} ({catchProgress.pct}%)
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-2">
        {catchProgress.caught === 0
          ? "You have not liked any pets yet, catch them with the heart button"
          : "Liked pets count toward your personal Petdex album progress."}
      </p>
    </section>
  );
}

// Renders the actual sprites the user has liked, most recent first.
// The album counter above only shows the number; this block answers the
// "where do I see them?" question (issue #103). Hidden when the user
// has no likes yet so the empty state on the album section above is
// the single CTA.
function LikedPets({ pets }: { pets: PetWithMetrics[] }) {
  const isZh = useLocale() === "zh";
  if (pets.length === 0) return null;

  const stateCount = petStates.length;
  const heading =
    pets.length === 1 ? "1 liked pet" : `${pets.length} liked pets`;

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            Liked pets
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {heading}
          </h2>
          <p className="mt-1 text-sm text-muted-2">
            Pets you have caught with the heart, most recent first. Tap a card
            to revisit, install, or unlike.
          </p>
        </div>
      </header>
      <div
        className={cn(
          "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
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

export type { Submission };

export function SubmissionCard({ submission }: { submission: Submission }) {
  const [isPending, startTransition] = useTransition();
  const [withdrawn, setWithdrawn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = useLocale();

  if (withdrawn) {
    return (
      <article className="rounded-3xl border border-dashed border-border-base bg-surface/70 p-6 text-center">
        <p className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
          Withdrawn
        </p>
        <p className="mt-2 text-sm text-muted-2">
          {submission.displayName} has been removed from the queue.
        </p>
      </article>
    );
  }

  const handleWithdraw = () => {
    if (
      !window.confirm(
        `Withdraw "${submission.displayName}"? This can't be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/my-pets/${submission.id}/withdraw`, {
          method: "POST",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "withdraw_failed");
          return;
        }
        setWithdrawn(true);
      } catch {
        setError("network_error");
      }
    });
  };

  const statusConfig = {
    pending: {
      label: "Pending review",
      icon: <Clock className="size-3.5" />,
      className:
        "bg-chip-warning-bg text-chip-warning-fg ring-1 ring-chip-warning-fg/20",
      timeLabel: "Submitted",
      time: submission.createdAt,
    },
    approved: {
      label: "Approved · live",
      icon: <CheckCircle2 className="size-3.5" />,
      className:
        "bg-chip-success-bg text-chip-success-fg ring-1 ring-chip-success-fg/20",
      timeLabel: "Approved",
      time: submission.approvedAt ?? submission.createdAt,
    },
    rejected: {
      label: "Rejected",
      icon: <XCircle className="size-3.5" />,
      className:
        "bg-chip-danger-bg text-chip-danger-fg ring-1 ring-chip-danger-fg/20",
      timeLabel: "Rejected",
      time: submission.rejectedAt ?? submission.createdAt,
    },
  }[submission.status];

  const { likeCount, installCount, zipDownloadCount } = submission.metrics;
  const showMetrics =
    submission.status === "approved" &&
    (likeCount > 0 || installCount > 0 || zipDownloadCount > 0);

  return (
    <article
      className={cn(
        "toy-shell group relative flex flex-col rounded-3xl border transition focus-within:z-30",
        submission.featured
          ? "border-[#3B59F2]/50"
          : "border-[#D4DCF4] dark:border-white/12",
      )}
    >
      <div className="flex items-center justify-between border-b border-black/[0.06] px-5 pt-4 pb-3 dark:border-white/[0.06]">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase ${statusConfig.className}`}
        >
          {statusConfig.icon}
          {statusConfig.label}
        </span>
        {submission.featured ? (
          <span className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            ★ Featured
          </span>
        ) : null}
      </div>

      <div className="pet-sprite-stage relative flex items-center justify-center overflow-hidden px-5 py-6">
        <PetSprite
          src={submission.spritesheetUrl}
          cycleStates
          scale={0.65}
          label={`${submission.displayName} animated`}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-black/[0.06] px-5 py-4 dark:border-white/[0.06]">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            {submission.displayName}
          </h3>
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
            {submission.kind}
          </span>
        </div>
        <p className="line-clamp-2 text-sm leading-6 text-muted-2">
          {submission.description}
        </p>
        <p className="font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
          {statusConfig.timeLabel}{" "}
          {new Date(statusConfig.time).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>

        {submission.status === "rejected" && submission.rejectionReason ? (
          <div className="mt-2 rounded-2xl border border-rose-200 bg-chip-danger-bg p-3 text-sm text-chip-danger-fg dark:border-rose-800/60">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" />
              Reason
            </div>
            <p className="mt-1 leading-6">{submission.rejectionReason}</p>
          </div>
        ) : null}

        {showMetrics ? (
          <div className="mt-2 flex items-center gap-4 border-t border-black/[0.05] pt-3 font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase dark:border-white/[0.05]">
            {likeCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Heart className="size-3" />
                {formatLocalizedNumber(likeCount, locale)} likes
              </span>
            ) : null}
            {installCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <TerminalSquare className="size-3" />
                {formatLocalizedNumber(installCount, locale)} installs
              </span>
            ) : null}
            {zipDownloadCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                ↓ {formatLocalizedNumber(zipDownloadCount, locale)} zips
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/[0.05] pt-3 dark:border-white/[0.05]">
          {submission.status === "approved" ? (
            <>
              <Link
                href={`/pets/${submission.slug}`}
                className={buttonVariants({ variant: "cobalt", size: "lg" })}
              >
                View public page
              </Link>
              <PetActionMenu
                pet={{
                  slug: submission.slug,
                  displayName: submission.displayName,
                  zipUrl: submission.zipUrl,
                  description: submission.description,
                }}
                variant="detail"
              />
            </>
          ) : submission.status === "rejected" ? (
            <Link
              href="/submit"
              className={buttonVariants({ variant: "cobalt", size: "lg" })}
            >
              Submit a new version
            </Link>
          ) : (
            <ActionButton
              type="button"
              variant="destructive"
              size="lg"
              onClick={handleWithdraw}
              pending={isPending}
              pendingLabel="Withdrawing…"
            >
              <Trash2 className="size-3.5" />
              Withdraw
            </ActionButton>
          )}
        </div>

        {submission.status === "approved" ? (
          <div className="mt-3 border-t border-black/[0.05] pt-3 dark:border-white/[0.05]">
            <OwnerEditPanel
              petId={submission.id}
              slug={submission.slug}
              currentDisplayName={submission.displayName}
              currentDescription={submission.description}
              currentTags={submission.tags}
              initialPending={submission.pending}
              initialRejection={submission.pendingRejectionReason}
            />
          </div>
        ) : null}

        {error ? (
          <p className="font-mono text-[10px] tracking-[0.12em] text-rose-600 uppercase">
            {error}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "default" | "amber" | "emerald" | "rose";
}) {
  const inactiveToneClass =
    !active && tone === "amber"
      ? "text-chip-warning-fg"
      : !active && tone === "emerald"
        ? "text-chip-success-fg"
        : !active && tone === "rose"
          ? "text-chip-danger-fg"
          : undefined;

  return (
    <Button
      type="button"
      variant={active ? "cobalt" : "pearl"}
      size="lg"
      onClick={onClick}
      aria-pressed={active}
      className={inactiveToneClass}
    >
      {label}
      <span
        className={`text-[10px] ${active ? "text-white/80" : "opacity-60"}`}
      >
        {count}
      </span>
    </Button>
  );
}

type Claimable = {
  id: string;
  slug: string;
  displayName: string;
  status: "pending" | "approved" | "rejected";
};

export function ClaimableBanner() {
  const [pets, setPets] = useState<Claimable[] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/my-pets/claim");
        if (!res.ok) return;
        const data = (await res.json()) as {
          pets: Claimable[];
          email?: string | null;
          githubUrl?: string | null;
        };
        if (cancelled) return;
        setPets(data.pets);
        setEmail(data.email ?? null);
        setGithubUrl(data.githubUrl ?? null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const claim = async (id: string) => {
    setError(null);
    setClaiming(id);
    try {
      const res = await fetch("/api/my-pets/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? data.error ?? "claim_failed");
        return;
      }
      setClaimed((prev) => new Set(prev).add(id));
    } catch {
      setError("network_error");
    } finally {
      setClaiming(null);
    }
  };

  if (!pets || pets.length === 0 || dismissed) return null;
  const remaining = pets.filter((p) => !claimed.has(p.id));
  if (remaining.length === 0) {
    return (
      <div className="rounded-3xl border border-emerald-200 bg-chip-success-bg p-5 text-sm text-chip-success-fg dark:border-emerald-800/60">
        Claimed. Refresh to see them in your list.
      </div>
    );
  }

  return (
    <div className="toy-shell rounded-3xl border border-[#D8B822]/60 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-800/60">
          <Mail className="size-4" />
        </span>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-foreground">
            We found {remaining.length} pet
            {remaining.length === 1 ? "" : "s"} that look like yours
          </p>
          <p className="text-sm leading-6 text-muted-2">
            Matched via{" "}
            {email ? <span className="font-mono">{email}</span> : null}
            {email && githubUrl ? " or " : null}
            {githubUrl ? (
              <span className="font-mono">
                {githubUrl.replace("https://", "")}
              </span>
            ) : null}
            . Click claim to move each one to your current account so you can
            manage and re-submit edits.
          </p>
          <ul className="mt-2 space-y-2">
            {remaining.map((pet) => (
              <li
                key={pet.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-[#D4DCF4] bg-surface/80 px-3 py-2 dark:border-white/12"
              >
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <span className="font-semibold">{pet.displayName}</span>
                  <span className="toy-tag text-muted-3">{pet.status}</span>
                </div>
                <Button
                  type="button"
                  variant="volt"
                  size="default"
                  onClick={() => claim(pet.id)}
                  disabled={claiming !== null}
                >
                  {claiming === pet.id ? "Claiming…" : "Claim"}
                </Button>
              </li>
            ))}
          </ul>
          {error ? (
            <p className="font-mono text-[10px] tracking-[0.12em] text-rose-700 uppercase dark:text-rose-300">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setDismissed(true)}
            className="mt-1 text-muted-3"
          >
            Not mine, dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="space-y-6">
      <header>
        <p className="toy-tag text-brand">Dashboard</p>
        <h1 className="mt-2 text-balance text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
          No submissions yet
        </h1>
      </header>
      <div className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-10 dark:border-white/12">
        <p className="text-base leading-7 text-muted-2">
          Send your first animated companion to Petdex. Submissions go through a
          quick review and land here while they wait. Once approved they show up
          on your public profile too.
        </p>
        <Link
          href="/submit"
          className={cn(
            buttonVariants({ variant: "cobalt", size: "petdex-pill" }),
            "mt-6",
          )}
        >
          <Plus className="size-4" />
          Submit your first pet
        </Link>
      </div>
    </div>
  );
}
