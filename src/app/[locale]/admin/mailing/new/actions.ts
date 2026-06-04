"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@clerk/nextjs/server";
import { desc, sql as dsql, eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import {
  type Campaign,
  type SendResult,
  sendBroadcast,
} from "@/lib/admin/send-broadcast";
import { db, schema } from "@/lib/db/client";

import type { Locale } from "@/i18n/config";

function parseCampaign(raw: unknown): Campaign {
  return raw === "desktop_launch" ? "desktop_launch" : "collections_drop";
}

// Loads the top featured collections by pet count. The email template
// renders up to 10 — that limit lives here so the admin UI can preview
// what the broadcast will actually contain.
async function loadCollections(): Promise<
  { slug: string; title: string; description: string }[]
> {
  const rows = await db
    .select({
      slug: schema.petCollections.slug,
      title: schema.petCollections.title,
      description: schema.petCollections.description,
      pets: dsql<number>`count(${schema.petCollectionItems.petSlug})`.as(
        "pets",
      ),
    })
    .from(schema.petCollections)
    .leftJoin(
      schema.petCollectionItems,
      eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
    )
    .where(eq(schema.petCollections.featured, true))
    .groupBy(
      schema.petCollections.slug,
      schema.petCollections.title,
      schema.petCollections.description,
    )
    .orderBy(desc(dsql`count(${schema.petCollectionItems.petSlug})`))
    .limit(10);

  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
  }));
}

export async function sendTestAction(form: FormData): Promise<{
  ok: boolean;
  result?: SendResult;
  error?: string;
}> {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return { ok: false, error: "unauthorized" };

  const localeRaw = String(form.get("locale") ?? "en");
  const locale = (
    ["en", "es", "zh"].includes(localeRaw) ? localeRaw : "en"
  ) as Locale;
  const campaign = parseCampaign(form.get("campaign"));

  let collections: Awaited<ReturnType<typeof loadCollections>> | undefined;
  if (campaign === "collections_drop") {
    collections = await loadCollections();
    if (collections.length === 0) {
      return { ok: false, error: "no_collections_seeded" };
    }
  }

  const result = await sendBroadcast({
    campaign,
    batchKey: `${campaign.replace(/_/g, "-")}-test-${Date.now()}`,
    toUserIds: [userId],
    localeFilter: locale,
    collections,
  });

  revalidatePath("/admin/mailing");
  return { ok: true, result };
}

export async function sendBroadcastAction(form: FormData): Promise<{
  ok: boolean;
  result?: SendResult;
  error?: string;
}> {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return { ok: false, error: "unauthorized" };

  const confirm = String(form.get("confirm") ?? "");
  if (confirm !== "SEND") {
    return { ok: false, error: "missing_confirmation" };
  }

  const localeRaw = String(form.get("locale") ?? "all");
  const localeFilter =
    localeRaw === "all"
      ? null
      : ["en", "es", "zh"].includes(localeRaw)
        ? (localeRaw as Locale)
        : null;

  const limitRaw = Number(form.get("limit") ?? 0);
  let toUserIds: string[] | null = null;
  if (limitRaw > 0) {
    const recipients = await db
      .select({ userId: schema.emailPreferences.userId })
      .from(schema.emailPreferences)
      .where(eq(schema.emailPreferences.unsubscribedMarketing, false))
      .limit(limitRaw);
    toUserIds = recipients.map((r) => r.userId);
  }

  const campaign = parseCampaign(form.get("campaign"));
  let collections: Awaited<ReturnType<typeof loadCollections>> | undefined;
  if (campaign === "collections_drop") {
    collections = await loadCollections();
    if (collections.length === 0) {
      return { ok: false, error: "no_collections_seeded" };
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const batchKey = `${campaign.replace(/_/g, "-")}-${today}`;

  const result = await sendBroadcast({
    campaign,
    batchKey,
    toUserIds,
    localeFilter,
    collections,
  });

  revalidatePath("/admin/mailing");
  return { ok: true, result };
}
