import Link from "next/link";

import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { AdminCollectionRequestActions } from "@/components/admin-collection-request-actions";

export const metadata = {
  title: "Petdex — Admin · Collection requests",
  robots: { index: false, follow: false },
};

export default async function AdminCollectionRequestsPage() {
  // Pending first (newest first), then anything decided in the last
  // ~30 days for a quick audit trail. Older history can stay paged
  // when there's enough volume to justify it.
  const pending = await db
    .select()
    .from(schema.petCollectionRequests)
    .where(eq(schema.petCollectionRequests.status, "pending"))
    .orderBy(desc(schema.petCollectionRequests.createdAt));

  const recentDecided = await db
    .select()
    .from(schema.petCollectionRequests)
    .where(eq(schema.petCollectionRequests.status, "approved"))
    .orderBy(desc(schema.petCollectionRequests.decidedAt))
    .limit(20);

  const recentRejected = await db
    .select()
    .from(schema.petCollectionRequests)
    .where(eq(schema.petCollectionRequests.status, "rejected"))
    .orderBy(desc(schema.petCollectionRequests.decidedAt))
    .limit(20);

  const allRows = [...pending, ...recentDecided, ...recentRejected];

  // Hydrate collection titles + pet display names + requester credits
  // in the smallest number of queries possible.
  const collectionIds = Array.from(new Set(allRows.map((r) => r.collectionId)));
  const collections =
    collectionIds.length > 0
      ? await db
          .select({
            id: schema.petCollections.id,
            slug: schema.petCollections.slug,
            title: schema.petCollections.title,
          })
          .from(schema.petCollections)
      : [];
  const collectionById = new Map(collections.map((c) => [c.id, c]));

  const petSlugs = Array.from(new Set(allRows.map((r) => r.petSlug)));
  const petRows =
    petSlugs.length > 0
      ? await db
          .select({
            slug: schema.submittedPets.slug,
            displayName: schema.submittedPets.displayName,
            ownerId: schema.submittedPets.ownerId,
          })
          .from(schema.submittedPets)
      : [];
  const petBySlug = new Map(petRows.map((p) => [p.slug, p]));

  const requesterIds = Array.from(new Set(allRows.map((r) => r.requestedBy)));
  const credits =
    requesterIds.length > 0
      ? await resolveOwnerCredits(
          requesterIds.map((ownerId) => ({
            ownerId,
            creditName: null,
            creditUrl: null,
            creditImage: null,
          })),
        )
      : new Map();

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 pt-2 pb-12 md:px-8 md:pb-16">
      <div>
        <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
          Admin · Collection requests
        </p>
        <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight md:text-3xl">
          Pending collection requests
        </h1>
        <p className="mt-2 text-sm text-muted-2">
          Owners can suggest their pets for any featured collection. Approving
          inserts the pet at the end of the collection's list.
        </p>
      </div>

      <Group title="Pending" rows={pending} highlight>
        {(row) => (
          <RequestRow
            key={row.id}
            row={row}
            collection={collectionById.get(row.collectionId)}
            pet={petBySlug.get(row.petSlug)}
            requester={credits.get(row.requestedBy) ?? null}
            actions={<AdminCollectionRequestActions id={row.id} />}
          />
        )}
      </Group>

      <Group title="Recently approved" rows={recentDecided}>
        {(row) => (
          <RequestRow
            key={row.id}
            row={row}
            collection={collectionById.get(row.collectionId)}
            pet={petBySlug.get(row.petSlug)}
            requester={credits.get(row.requestedBy) ?? null}
            badge="approved"
          />
        )}
      </Group>

      <Group title="Recently rejected" rows={recentRejected}>
        {(row) => (
          <RequestRow
            key={row.id}
            row={row}
            collection={collectionById.get(row.collectionId)}
            pet={petBySlug.get(row.petSlug)}
            requester={credits.get(row.requestedBy) ?? null}
            badge="rejected"
          />
        )}
      </Group>
    </section>
  );
}

type Row = typeof schema.petCollectionRequests.$inferSelect;

function Group<R>({
  title,
  rows,
  children,
  highlight,
}: {
  title: string;
  rows: R[];
  children: (row: R) => React.ReactNode;
  highlight?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <h2
        className={`font-mono text-[11px] tracking-[0.22em] uppercase ${
          highlight ? "text-brand" : "text-muted-3"
        }`}
      >
        {title} · {rows.length}
      </h2>
      <ul className="flex flex-col gap-2">{rows.map((r) => children(r))}</ul>
    </div>
  );
}

function RequestRow({
  row,
  collection,
  pet,
  requester,
  actions,
  badge,
}: {
  row: Row;
  collection: { slug: string; title: string } | undefined;
  pet: { slug: string; displayName: string; ownerId: string } | undefined;
  requester: { name: string; handle: string } | null;
  actions?: React.ReactNode;
  badge?: "approved" | "rejected";
}) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-border-base bg-surface/80 px-4 py-3 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/pets/${pet?.slug ?? row.petSlug}`}
            className="text-base font-semibold text-foreground hover:underline"
          >
            {pet?.displayName ?? row.petSlug}
          </Link>
          <span className="text-xs text-muted-3">→</span>
          <Link
            href={`/collections/${collection?.slug ?? row.collectionId}`}
            className="text-sm font-medium text-brand hover:underline"
          >
            {collection?.title ?? row.collectionId}
          </Link>
          {badge ? (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
                badge === "approved"
                  ? "bg-chip-success-bg text-chip-success-fg"
                  : "bg-chip-danger-bg text-chip-danger-fg"
              }`}
            >
              {badge}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-3">
          <span>
            requested by{" "}
            {requester ? (
              <Link
                href={`/u/${requester.handle}`}
                className="text-foreground hover:underline"
              >
                {requester.name}
              </Link>
            ) : (
              row.requestedBy.slice(-8)
            )}
          </span>
          <span>{row.createdAt.toISOString().slice(0, 10)}</span>
          {row.rejectionReason ? (
            <span className="text-chip-danger-fg">
              reason: {row.rejectionReason}
            </span>
          ) : null}
        </div>
        {row.note ? (
          <p className="mt-1 text-sm leading-6 text-muted-2">"{row.note}"</p>
        ) : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </li>
  );
}
