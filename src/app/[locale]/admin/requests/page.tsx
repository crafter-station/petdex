import Link from "next/link";

import { clerkClient } from "@clerk/nextjs/server";
import { desc, sql as dsql, inArray } from "drizzle-orm";
import { ExternalLink, Sparkles } from "lucide-react";

import { db, schema } from "@/lib/db/client";

import { AdminRequestActions } from "@/components/admin-request-actions";

export const metadata = {
  title: "Petdex — Admin · Requests",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type ClerkInfo = {
  imageUrl: string | null;
  displayName: string | null;
  username: string | null;
  handle: string;
};

async function loadClerkInfo(
  userIds: string[],
): Promise<Map<string, ClerkInfo>> {
  const out = new Map<string, ClerkInfo>();
  if (userIds.length === 0) return out;
  let client: Awaited<ReturnType<typeof clerkClient>>;
  try {
    client = await clerkClient();
  } catch {
    return out;
  }
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += 100) {
    chunks.push(userIds.slice(i, i + 100));
  }
  for (const ids of chunks) {
    try {
      const list = await client.users.getUserList({ userId: ids, limit: 100 });
      for (const u of list.data) {
        const displayName = [u.firstName, u.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        out.set(u.id, {
          imageUrl: u.imageUrl ?? null,
          displayName: displayName || null,
          username: u.username ?? null,
          handle: u.username
            ? u.username.toLowerCase()
            : u.id.slice(-8).toLowerCase(),
        });
      }
    } catch {
      /* swallow — we still render rows without identity */
    }
  }
  return out;
}

const STATUS_META: Record<string, { label: string; tone: string }> = {
  open: {
    label: "Open",
    tone: "bg-chip-warning-bg text-chip-warning-fg ring-chip-warning-fg/20",
  },
  fulfilled: {
    label: "Fulfilled",
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
  },
  dismissed: {
    label: "Dismissed",
    tone: "bg-surface-muted text-stone-600 ring-stone-200 dark:text-stone-300 dark:ring-stone-700",
  },
};

export default async function AdminRequestsPage() {
  const rows = await db
    .select()
    .from(schema.petRequests)
    .orderBy(
      dsql`${schema.petRequests.upvoteCount} DESC, ${schema.petRequests.createdAt} DESC`,
    )
    .limit(200);

  const requestIds = rows.map((r) => r.id);

  // Top voters per request: top 3 most-recent voters as avatar stack.
  // Postgres-friendly approach: pull all votes for visible requests + a
  // global voter count, slice client-side to top 3.
  type VoteRow = { requestId: string; userId: string; createdAt: Date };
  const votes: VoteRow[] = requestIds.length
    ? ((await db
        .select({
          requestId: schema.petRequestVotes.requestId,
          userId: schema.petRequestVotes.userId,
          createdAt: schema.petRequestVotes.createdAt,
        })
        .from(schema.petRequestVotes)
        .where(inArray(schema.petRequestVotes.requestId, requestIds))
        .orderBy(desc(schema.petRequestVotes.createdAt))) as VoteRow[])
    : [];

  // Pull every userId we'll need (requesters + voters) so we batch one
  // Clerk lookup. Cheaper than per-row.
  const userIdSet = new Set<string>();
  for (const r of rows) if (r.requestedBy) userIdSet.add(r.requestedBy);
  for (const v of votes) userIdSet.add(v.userId);
  const clerkInfo = await loadClerkInfo([...userIdSet]);

  // Pull fulfilled pet thumbnails so the row can show what shipped.
  const fulfilledSlugs = rows
    .filter(
      (r): r is typeof r & { fulfilledPetSlug: string } =>
        r.status === "fulfilled" && typeof r.fulfilledPetSlug === "string",
    )
    .map((r) => r.fulfilledPetSlug);
  type Pet = {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
  };
  const pets: Pet[] = fulfilledSlugs.length
    ? await db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
          spritesheetUrl: schema.submittedPets.spritesheetUrl,
        })
        .from(schema.submittedPets)
        .where(inArray(schema.submittedPets.slug, fulfilledSlugs))
    : [];
  const petBySlug = new Map(pets.map((p) => [p.slug, p]));

  const open = rows.filter((r) => r.status === "open");
  const fulfilled = rows.filter((r) => r.status === "fulfilled");
  const dismissed = rows.filter((r) => r.status === "dismissed");

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 pb-12 md:px-8 md:pb-16">
      <header>
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          Community wishlist
        </p>
        <h1 className="mt-2 text-4xl font-medium tracking-tight md:text-5xl">
          Pet requests
        </h1>
        <p className="mt-3 text-sm text-muted-2">
          {open.length} open · {fulfilled.length} fulfilled · {dismissed.length}{" "}
          dismissed
        </p>
      </header>

      {open.length > 0 ? (
        <Section title="Open" count={open.length}>
          {open.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              requester={r.requestedBy ? clerkInfo.get(r.requestedBy) : null}
              voters={votes
                .filter(
                  (v) => v.requestId === r.id && v.userId !== r.requestedBy,
                )
                .map((v) => clerkInfo.get(v.userId))
                .filter((v): v is ClerkInfo => Boolean(v))}
              fulfilledPet={null}
            />
          ))}
        </Section>
      ) : (
        <Empty>No open requests right now.</Empty>
      )}

      {fulfilled.length > 0 ? (
        <Section title="Fulfilled" count={fulfilled.length}>
          {fulfilled.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              requester={r.requestedBy ? clerkInfo.get(r.requestedBy) : null}
              voters={votes
                .filter(
                  (v) => v.requestId === r.id && v.userId !== r.requestedBy,
                )
                .map((v) => clerkInfo.get(v.userId))
                .filter((v): v is ClerkInfo => Boolean(v))}
              fulfilledPet={
                r.fulfilledPetSlug ? petBySlug.get(r.fulfilledPetSlug) : null
              }
            />
          ))}
        </Section>
      ) : null}

      {dismissed.length > 0 ? (
        <Section title="Dismissed" count={dismissed.length}>
          {dismissed.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              requester={r.requestedBy ? clerkInfo.get(r.requestedBy) : null}
              voters={votes
                .filter(
                  (v) => v.requestId === r.id && v.userId !== r.requestedBy,
                )
                .map((v) => clerkInfo.get(v.userId))
                .filter((v): v is ClerkInfo => Boolean(v))}
              fulfilledPet={null}
            />
          ))}
        </Section>
      ) : null}
    </section>
  );
}

function RequestRow({
  request,
  requester,
  voters,
  fulfilledPet,
}: {
  request: typeof schema.petRequests.$inferSelect;
  requester: ClerkInfo | null | undefined;
  voters: ClerkInfo[];
  fulfilledPet:
    | { slug: string; displayName: string; spritesheetUrl: string }
    | null
    | undefined;
}) {
  const statusMeta = STATUS_META[request.status] ?? STATUS_META.open;
  const top3 = voters.slice(0, 3);
  const moreVoters = Math.max(0, request.upvoteCount - top3.length);

  return (
    <div className="rounded-2xl border border-border-base bg-surface/80 p-4 backdrop-blur">
      <div className="flex items-start gap-3">
        {/* Vote tile */}
        <div className="flex shrink-0 flex-col items-center rounded-xl border border-border-base bg-surface px-3 py-2 text-muted-2">
          <span className="font-mono text-base font-semibold leading-none">
            {request.upvoteCount}
          </span>
          <span className="font-mono text-[9px] tracking-[0.18em] text-muted-4 uppercase">
            votes
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base text-stone-900 dark:text-stone-100">
              {request.query}
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ring-1 ${statusMeta.tone}`}
            >
              {statusMeta.label}
            </span>
            <span className="font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
              {new Date(request.createdAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-3">
            {/* Requester */}
            {requester ? (
              <Link
                href={`/u/${requester.handle}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-1 transition hover:bg-surface-muted hover:text-stone-900 dark:hover:text-stone-100"
              >
                {requester.imageUrl ? (
                  // biome-ignore lint/performance/noImgElement: Clerk avatar
                  <img
                    src={requester.imageUrl}
                    alt=""
                    className="size-5 rounded-full ring-1 ring-black/10"
                  />
                ) : (
                  <span className="grid size-5 place-items-center rounded-full bg-stone-200 font-mono text-[9px] font-semibold text-muted-2 dark:bg-stone-700">
                    {(requester.displayName ?? requester.handle)
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}
                <span className="text-foreground">
                  {requester.displayName ?? `@${requester.handle}`}
                </span>
                {requester.username ? (
                  <span className="font-mono text-[10px] text-muted-4">
                    @{requester.username}
                  </span>
                ) : null}
              </Link>
            ) : request.requestedBy ? (
              <span className="font-mono text-[10px] text-muted-4">
                {request.requestedBy.slice(0, 14)}…
              </span>
            ) : (
              <span className="font-mono text-[10px] text-muted-4">
                anonymous
              </span>
            )}

            {/* Voter avatar stack */}
            {top3.length > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="flex -space-x-2">
                  {top3.map((v) =>
                    v.imageUrl ? (
                      // biome-ignore lint/performance/noImgElement: Clerk avatar
                      <img
                        key={v.handle}
                        src={v.imageUrl}
                        alt=""
                        title={v.displayName ?? `@${v.handle}`}
                        className="size-5 rounded-full ring-2 ring-white"
                      />
                    ) : (
                      <span
                        key={v.handle}
                        title={v.displayName ?? `@${v.handle}`}
                        className="grid size-5 place-items-center rounded-full bg-stone-200 font-mono text-[9px] font-semibold text-muted-2 ring-2 ring-white dark:bg-stone-700"
                      >
                        {(v.displayName ?? v.handle).slice(0, 1).toUpperCase()}
                      </span>
                    ),
                  )}
                </span>
                {moreVoters > 0 ? (
                  <span className="font-mono text-[10px] text-muted-3">
                    +{moreVoters} more
                  </span>
                ) : null}
              </span>
            ) : null}

            {/* Fulfilled-pet thumbnail */}
            {fulfilledPet ? (
              <Link
                href={`/pets/${fulfilledPet.slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-chip-success-bg px-2 py-1 text-chip-success-fg transition hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-800/60 dark:hover:border-emerald-700 dark:hover:bg-emerald-900/40"
              >
                <Sparkles className="size-3" />
                <span className="font-medium">{fulfilledPet.displayName}</span>
                <ExternalLink className="size-3" />
              </Link>
            ) : null}
          </div>

          {request.imageUrl ? (
            <div className="mt-3 flex flex-wrap items-start gap-3 rounded-2xl border border-border-base bg-background/60 p-2">
              {/* biome-ignore lint/performance/noImgElement: admin request reference */}
              <img
                src={request.imageUrl}
                alt=""
                className="h-24 w-32 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] tracking-[0.14em] text-muted-4 uppercase">
                  Reference image: {request.imageReviewStatus}
                </p>
                {request.imageRejectionReason ? (
                  <p className="mt-1 text-xs text-rose-600">
                    {request.imageRejectionReason}
                  </p>
                ) : null}
                <a
                  href={request.imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-brand underline-offset-4 hover:underline"
                >
                  Open image
                  <ExternalLink className="size-3" />
                </a>
              </div>
            </div>
          ) : null}
        </div>

        {/* Actions */}
        <AdminRequestActions
          id={request.id}
          status={request.status as "open" | "fulfilled" | "dismissed"}
          defaultSlug={request.fulfilledPetSlug ?? null}
          imageUrl={request.imageUrl}
          imageReviewStatus={request.imageReviewStatus}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
          {count}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border-base bg-surface/60 p-6 text-center text-sm text-muted-2">
      {children}
    </div>
  );
}
