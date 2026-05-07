import Link from "next/link";

import { Heart, Plus, Star, TerminalSquare, Users } from "lucide-react";

import {
  getActiveCreators,
  getCurrentlyFeatured,
  getHiddenHits,
  getOverviewStats,
  getQueueDepth,
  getSubmissionVelocity,
} from "@/lib/admin-insights";

import { AdminFeatureToggle } from "@/components/admin-feature-toggle";
import { AdminVelocityChart } from "@/components/admin-velocity-chart";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Insights — Petdex admin",
  robots: { index: false, follow: false },
};

export default async function AdminInsightsPage() {
  const [
    overview,
    queueDepth,
    velocity,
    hiddenHits,
    activeCreators,
    currentlyFeatured,
  ] = await Promise.all([
    getOverviewStats(),
    getQueueDepth(),
    getSubmissionVelocity(24),
    getHiddenHits(8),
    getActiveCreators(7, 12),
    getCurrentlyFeatured(24),
  ]);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pb-16 md:px-8">
      <header>
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          Insights
        </p>
        <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          Operational dashboard
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-2">
          Numbers Vercel and Clerk don't surface — submission throughput, queue
          health, hidden hits in the catalog, and active creators.
        </p>
      </header>

      {/* Headline cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Approved"
          value={overview.totalApproved}
          delta={`+${overview.approvedLast24h} last 24h`}
          icon={<Plus className="size-3.5" />}
        />
        <StatCard
          label="Active creators"
          value={overview.totalCreators}
          delta={`${activeCreators.length} shipped this week`}
          icon={<Users className="size-3.5" />}
        />
        <StatCard
          label="Total likes"
          value={overview.totalLikes}
          delta={`${overview.totalInstalls.toLocaleString()} total installs`}
          icon={<Heart className="size-3.5" />}
        />
        <StatCard
          label="Approved last 7d"
          value={overview.approvedLast7d}
          delta={`${overview.totalRejected} rejected lifetime`}
          icon={<TerminalSquare className="size-3.5" />}
        />
      </div>

      {/* Queue depth */}
      <section className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur md:p-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              Queue depth
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
              {overview.totalPending === 1
                ? "1 submission waiting"
                : `${overview.totalPending} submissions waiting`}
            </h2>
          </div>
          <Link
            href="/admin"
            className="inline-flex h-8 items-center rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
          >
            Open queue →
          </Link>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <QueueRow
            label="New submissions"
            count={queueDepth.pending}
            ageMinutes={queueDepth.oldestPendingAgeMinutes}
            tone="warning"
          />
          <QueueRow
            label="Pending edits"
            count={queueDepth.pendingEdits}
            ageMinutes={queueDepth.oldestPendingEditAgeMinutes}
            tone="default"
          />
        </div>
      </section>

      {/* Submission velocity */}
      <section className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur md:p-6">
        <header className="mb-4">
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            Submission velocity
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Hourly submissions, last 24 hours
          </h2>
        </header>
        <AdminVelocityChart data={velocity} />
      </section>

      {/* Hidden hits */}
      <section className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur md:p-6">
        <header className="mb-4">
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            Hidden hits
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            High install-to-like ratio, not yet featured
          </h2>
          <p className="mt-1 text-xs text-muted-3">
            Pets quietly converting installs without much heart pressure.
            Promote-worthy candidates.
          </p>
        </header>
        {hiddenHits.length === 0 ? (
          <p className="text-sm text-muted-3">
            Nothing crossed the install threshold yet.
          </p>
        ) : (
          <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
            {hiddenHits.map((pet) => {
              const ratio =
                pet.likeCount > 0
                  ? (pet.installCount / pet.likeCount).toFixed(2)
                  : `${pet.installCount}.0`;
              return (
                <li
                  key={pet.slug}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div className="flex flex-col">
                    <Link
                      href={`/pets/${pet.slug}`}
                      className="font-medium text-foreground transition hover:text-brand"
                    >
                      {pet.displayName}
                    </Link>
                    <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                      {pet.slug}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tracking-[0.16em] text-muted-2 uppercase">
                    <span className="inline-flex items-center gap-1">
                      <TerminalSquare className="size-3" />
                      {pet.installCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Heart className="size-3" />
                      {pet.likeCount}
                    </span>
                    <span className="rounded-full bg-chip-success-bg px-2 py-0.5 text-chip-success-fg">
                      {ratio}× ratio
                    </span>
                    <AdminFeatureToggle
                      petId={pet.id}
                      initialFeatured={false}
                      petName={pet.displayName}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Currently featured */}
      <section className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur md:p-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <Star className="size-3 fill-current" />
              Currently featured
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
              {currentlyFeatured.length === 0
                ? "No pets featured"
                : currentlyFeatured.length === 1
                  ? "1 pet featured"
                  : `${currentlyFeatured.length} pets featured`}
            </h2>
            <p className="mt-1 text-xs text-muted-3">
              Featured pets land in the home hero strip and the curated sort's
              top tier. Demote stale ones to free up the slot.
            </p>
          </div>
        </header>
        {currentlyFeatured.length === 0 ? (
          <p className="text-sm text-muted-3">
            Promote a hidden hit above or flip the star on a pet from the queue.
          </p>
        ) : (
          <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
            {currentlyFeatured.map((pet) => (
              <li
                key={pet.slug}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div className="flex flex-col">
                  <Link
                    href={`/pets/${pet.slug}`}
                    className="font-medium text-foreground transition hover:text-brand"
                  >
                    {pet.displayName}
                  </Link>
                  <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                    {pet.slug}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tracking-[0.16em] text-muted-2 uppercase">
                  <span className="inline-flex items-center gap-1">
                    <TerminalSquare className="size-3" />
                    {pet.installCount}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Heart className="size-3" />
                    {pet.likeCount}
                  </span>
                  <AdminFeatureToggle
                    petId={pet.id}
                    initialFeatured={true}
                    petName={pet.displayName}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Active creators */}
      <section className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur md:p-6">
        <header className="mb-4">
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            Active creators
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Shipped a submission in the last 7 days
          </h2>
        </header>
        {activeCreators.length === 0 ? (
          <p className="text-sm text-muted-3">No creator activity this week.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {activeCreators.map((creator) => (
              <li
                key={creator.ownerId}
                className="flex items-center justify-between rounded-2xl bg-background/40 px-3 py-2 text-sm"
              >
                <span className="truncate text-foreground">
                  {creator.creditName ?? `${creator.ownerId.slice(-8)}…`}
                </span>
                <span className="ml-3 shrink-0 font-mono text-[10px] tracking-[0.16em] text-muted-3 uppercase">
                  {creator.approvedCount > 0
                    ? `${creator.approvedCount} approved`
                    : `${formatRelative(creator.lastSubmittedAt)} ago`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function StatCard({
  label,
  value,
  delta,
  icon,
}: {
  label: string;
  value: number;
  delta?: string;
  icon: React.ReactNode;
}) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-4 backdrop-blur">
      <header className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {icon}
        {label}
      </header>
      <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-foreground">
        {value.toLocaleString()}
      </p>
      {delta ? <p className="mt-1 text-xs text-muted-2">{delta}</p> : null}
    </article>
  );
}

function QueueRow({
  label,
  count,
  ageMinutes,
  tone,
}: {
  label: string;
  count: number;
  ageMinutes: number | null;
  tone: "warning" | "default";
}) {
  const tint =
    tone === "warning" &&
    count > 0 &&
    ageMinutes != null &&
    ageMinutes > 24 * 60
      ? "border-chip-warning-fg/30 bg-chip-warning-bg text-chip-warning-fg"
      : "border-border-base bg-background/40 text-foreground";
  return (
    <div className={`rounded-2xl border px-3 py-3 ${tint}`}>
      <p className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">
        {count}
      </p>
      <p className="mt-1 text-xs opacity-80">
        {count === 0
          ? "All caught up"
          : ageMinutes == null
            ? "Oldest unknown"
            : `Oldest ${formatAge(ageMinutes)}`}
      </p>
    </div>
  );
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  return `${d}d`;
}
