import "server-only";

import { count, desc, sql as dsql, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export type CampaignSummary = {
  campaign: string;
  batchKey: string;
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  failed: number;
  firstSentAt: Date | null;
};

export async function listCampaignBatches(): Promise<CampaignSummary[]> {
  const rows = await db
    .select({
      campaign: schema.emailSends.campaign,
      batchKey: schema.emailSends.batchKey,
      total: count(),
      sent: dsql<number>`count(*) filter (where status in ('sent','delivered','opened','bounced','complained'))`,
      delivered: dsql<number>`count(*) filter (where status in ('delivered','opened'))`,
      opened: dsql<number>`count(*) filter (where status = 'opened')`,
      bounced: dsql<number>`count(*) filter (where status = 'bounced')`,
      failed: dsql<number>`count(*) filter (where status = 'failed')`,
      firstSentAt: dsql<Date | null>`min(${schema.emailSends.createdAt})`,
    })
    .from(schema.emailSends)
    .groupBy(schema.emailSends.campaign, schema.emailSends.batchKey)
    .orderBy(desc(dsql`min(${schema.emailSends.createdAt})`));

  return rows.map((r) => ({
    campaign: r.campaign,
    batchKey: r.batchKey,
    total: Number(r.total),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    opened: Number(r.opened),
    bounced: Number(r.bounced),
    failed: Number(r.failed),
    firstSentAt: r.firstSentAt,
  }));
}

export type AudienceCounts = {
  total: number;
  optedIn: number;
  optedOut: number;
  byLocale: Record<string, number>;
};

export async function getAudienceCounts(): Promise<AudienceCounts> {
  const totalRow = await db
    .select({ c: count() })
    .from(schema.emailPreferences);

  const optedInRow = await db
    .select({ c: count() })
    .from(schema.emailPreferences)
    .where(eq(schema.emailPreferences.unsubscribedMarketing, false));

  const localeRows = await db
    .select({
      locale: schema.emailPreferences.locale,
      c: count(),
    })
    .from(schema.emailPreferences)
    .where(eq(schema.emailPreferences.unsubscribedMarketing, false))
    .groupBy(schema.emailPreferences.locale);

  const total = Number(totalRow[0]?.c ?? 0);
  const optedIn = Number(optedInRow[0]?.c ?? 0);
  const byLocale: Record<string, number> = {};
  for (const row of localeRows) byLocale[row.locale] = Number(row.c);

  return { total, optedIn, optedOut: total - optedIn, byLocale };
}

export type SubscriberRow = {
  userId: string;
  email: string;
  locale: string;
  unsubscribedMarketing: boolean;
  unsubscribedAt: Date | null;
  createdAt: Date;
};

export async function listSubscribers(opts: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: SubscriberRow[]; total: number }> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const search = opts.search?.trim().toLowerCase();

  const where = search
    ? dsql`lower(${schema.emailPreferences.email}) like ${`%${search}%`}`
    : undefined;

  const totalRow = await db
    .select({ c: count() })
    .from(schema.emailPreferences)
    .where(where);

  const rows = await db
    .select({
      userId: schema.emailPreferences.userId,
      email: schema.emailPreferences.email,
      locale: schema.emailPreferences.locale,
      unsubscribedMarketing: schema.emailPreferences.unsubscribedMarketing,
      unsubscribedAt: schema.emailPreferences.unsubscribedAt,
      createdAt: schema.emailPreferences.createdAt,
    })
    .from(schema.emailPreferences)
    .where(where)
    .orderBy(desc(schema.emailPreferences.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map((r) => ({
      ...r,
      locale: r.locale as string,
    })),
    total: Number(totalRow[0]?.c ?? 0),
  };
}
