import {
  and,
  asc,
  desc,
  eq,
  isNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";

import { type AdUtmFields, buildAdClickUrl } from "@/lib/ads/url";
import { db, schema } from "@/lib/db/client";

export type PublicFeedAd = {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  clickUrl: string;
};

export type AdvertiserCampaign = {
  id: string;
  companyName: string;
  title: string;
  description: string;
  imageUrl: string;
  destinationUrl: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  packageViews: number;
  priceCents: number;
  viewsServed: number;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  activatedAt: Date | null;
  deletedAt: Date | null;
  removalReason: string | null;
  timeSeries: AdCampaignTimeSeries;
  hovers: number;
  clicks: number;
  dismissals: number;
  avgTimeInViewMs: number;
};

type CampaignMetrics = Pick<
  AdvertiserCampaign,
  "timeSeries" | "hovers" | "clicks" | "dismissals" | "avgTimeInViewMs"
>;

type AdvertiserCampaignRow = Omit<AdvertiserCampaign, keyof CampaignMetrics>;

export type UpdateOwnedAdCampaignCreativeParams = {
  id: string;
  userId: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  destinationUrl?: string;
} & Partial<AdUtmFields>;

export type AdCampaignTimeSeries = {
  eightHours: AdCampaignSeriesPoint[];
  day: AdCampaignSeriesPoint[];
  week: AdCampaignSeriesPoint[];
  month: AdCampaignSeriesPoint[];
};

export type AdCampaignSeriesPoint = {
  label: string;
  impressions: number;
  hovers: number;
  clicks: number;
};

export type CreateAdCampaignParams = {
  userId: string;
  companyName: string;
  contactEmail: string;
  title: string;
  description: string;
  imageUrl: string;
  destinationUrl: string;
  packageViews: number;
  priceCents: number;
} & AdUtmFields;

const FEED_AD_ROTATION_SECONDS = 60 * 60;

export function createAdCampaignId(): string {
  return `ad_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

export function createAdImpressionId(): string {
  return `adi_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

export function createAdEventId(): string {
  return `ade_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

export async function createAdCampaign(params: CreateAdCampaignParams) {
  const id = createAdCampaignId();
  await db.insert(schema.adCampaigns).values({
    id,
    userId: params.userId,
    companyName: params.companyName,
    contactEmail: params.contactEmail,
    title: params.title,
    description: params.description,
    imageUrl: params.imageUrl,
    destinationUrl: params.destinationUrl,
    utmSource: params.utmSource,
    utmMedium: params.utmMedium,
    utmCampaign: params.utmCampaign,
    utmTerm: params.utmTerm,
    utmContent: params.utmContent,
    packageViews: params.packageViews,
    priceCents: params.priceCents,
    acceptedTermsAt: new Date(),
  });
  return id;
}

export async function getPendingOwnedCampaign(id: string, userId: string) {
  const rows = await db
    .select()
    .from(schema.adCampaigns)
    .where(
      and(
        eq(schema.adCampaigns.id, id),
        eq(schema.adCampaigns.userId, userId),
        eq(schema.adCampaigns.status, "pending_payment"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getOwnedAdCampaignForEditing(id: string, userId: string) {
  const rows = await db
    .select({
      id: schema.adCampaigns.id,
      companyName: schema.adCampaigns.companyName,
      title: schema.adCampaigns.title,
      description: schema.adCampaigns.description,
      imageUrl: schema.adCampaigns.imageUrl,
      destinationUrl: schema.adCampaigns.destinationUrl,
      utmSource: schema.adCampaigns.utmSource,
      utmMedium: schema.adCampaigns.utmMedium,
      utmCampaign: schema.adCampaigns.utmCampaign,
      utmTerm: schema.adCampaigns.utmTerm,
      utmContent: schema.adCampaigns.utmContent,
      packageViews: schema.adCampaigns.packageViews,
      priceCents: schema.adCampaigns.priceCents,
      viewsServed: schema.adCampaigns.viewsServed,
      status: schema.adCampaigns.status,
      createdAt: schema.adCampaigns.createdAt,
      activatedAt: schema.adCampaigns.activatedAt,
      deletedAt: schema.adCampaigns.deletedAt,
      removalReason: schema.adCampaigns.removalReason,
    })
    .from(schema.adCampaigns)
    .where(
      and(eq(schema.adCampaigns.id, id), eq(schema.adCampaigns.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function updateOwnedAdCampaignCreative(
  params: UpdateOwnedAdCampaignCreativeParams,
): Promise<
  | {
      ok: true;
      campaign: {
        id: string;
        title: string;
        description: string;
        imageUrl: string;
        destinationUrl: string;
        updatedAt: Date;
      };
    }
  | {
      ok: false;
      error: "not_found" | "campaign_not_editable" | "nothing_changed";
    }
> {
  const row = await db.query.adCampaigns.findFirst({
    where: and(
      eq(schema.adCampaigns.id, params.id),
      eq(schema.adCampaigns.userId, params.userId),
    ),
  });

  if (!row) return { ok: false, error: "not_found" };
  if (row.status === "deleted" || row.deletedAt) {
    return { ok: false, error: "campaign_not_editable" };
  }

  const patch: Partial<typeof schema.adCampaigns.$inferInsert> = {};
  if (params.title !== undefined && params.title !== row.title) {
    patch.title = params.title;
  }
  if (
    params.description !== undefined &&
    params.description !== row.description
  ) {
    patch.description = params.description;
  }
  if (params.imageUrl !== undefined && params.imageUrl !== row.imageUrl) {
    patch.imageUrl = params.imageUrl;
  }
  if (
    params.destinationUrl !== undefined &&
    params.destinationUrl !== row.destinationUrl
  ) {
    patch.destinationUrl = params.destinationUrl;
  }
  if (params.utmSource !== undefined && params.utmSource !== row.utmSource) {
    patch.utmSource = params.utmSource;
  }
  if (params.utmMedium !== undefined && params.utmMedium !== row.utmMedium) {
    patch.utmMedium = params.utmMedium;
  }
  if (
    params.utmCampaign !== undefined &&
    params.utmCampaign !== row.utmCampaign
  ) {
    patch.utmCampaign = params.utmCampaign;
  }
  if (params.utmTerm !== undefined && params.utmTerm !== row.utmTerm) {
    patch.utmTerm = params.utmTerm;
  }
  if (params.utmContent !== undefined && params.utmContent !== row.utmContent) {
    patch.utmContent = params.utmContent;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "nothing_changed" };
  }

  const [updated] = await db
    .update(schema.adCampaigns)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(schema.adCampaigns.id, params.id),
        eq(schema.adCampaigns.userId, params.userId),
      ),
    )
    .returning({
      id: schema.adCampaigns.id,
      title: schema.adCampaigns.title,
      description: schema.adCampaigns.description,
      imageUrl: schema.adCampaigns.imageUrl,
      destinationUrl: schema.adCampaigns.destinationUrl,
      updatedAt: schema.adCampaigns.updatedAt,
    });

  return { ok: true, campaign: updated };
}

export async function setCampaignCheckoutSession(
  campaignId: string,
  sessionId: string,
) {
  await db
    .update(schema.adCampaigns)
    .set({ stripeCheckoutSessionId: sessionId, updatedAt: new Date() })
    .where(eq(schema.adCampaigns.id, campaignId));
}

export async function activateCampaignFromCheckout(params: {
  campaignId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
}) {
  const now = new Date();
  await db
    .update(schema.adCampaigns)
    .set({
      status: "active",
      stripeCheckoutSessionId: params.checkoutSessionId,
      stripePaymentIntentId: params.paymentIntentId,
      paidAt: now,
      activatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.adCampaigns.id, params.campaignId),
        eq(schema.adCampaigns.status, "pending_payment"),
      ),
    );
}

export async function getActiveFeedAds(limit = 6): Promise<PublicFeedAd[]> {
  const requestedLimit = Math.max(0, Math.floor(limit));
  if (requestedLimit === 0) return [];

  const poolLimit = Math.min(Math.max(requestedLimit * 4, requestedLimit), 60);
  const [rows, bucketResult] = await Promise.all([
    db
      .select({
        id: schema.adCampaigns.id,
        title: schema.adCampaigns.title,
        description: schema.adCampaigns.description,
        imageUrl: schema.adCampaigns.imageUrl,
        destinationUrl: schema.adCampaigns.destinationUrl,
        utmSource: schema.adCampaigns.utmSource,
        utmMedium: schema.adCampaigns.utmMedium,
        utmCampaign: schema.adCampaigns.utmCampaign,
        utmTerm: schema.adCampaigns.utmTerm,
        utmContent: schema.adCampaigns.utmContent,
      })
      .from(schema.adCampaigns)
      .where(
        and(
          eq(schema.adCampaigns.status, "active"),
          isNull(schema.adCampaigns.deletedAt),
          lt(schema.adCampaigns.viewsServed, schema.adCampaigns.packageViews),
        ),
      )
      .orderBy(
        asc(schema.adCampaigns.viewsServed),
        asc(schema.adCampaigns.createdAt),
        asc(schema.adCampaigns.id),
      )
      .limit(poolLimit),
    db.execute<{ bucket: number }>(sql`
      SELECT floor(extract(epoch from now()) / ${FEED_AD_ROTATION_SECONDS})::int AS bucket
    `),
  ]);

  const bucket = Number(bucketResult.rows[0]?.bucket ?? 0);
  const selectedRows = rotateWindow(rows, requestedLimit, bucket);

  return selectedRows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    clickUrl: buildAdClickUrl(row.destinationUrl, row),
  }));
}

function rotateWindow<T>(rows: T[], limit: number, bucket: number): T[] {
  if (rows.length <= limit) return rows;
  const offset = bucket % rows.length;
  return [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, limit);
}

export async function getUserAdCampaigns(
  userId: string,
): Promise<AdvertiserCampaign[]> {
  const campaigns: AdvertiserCampaignRow[] = await db
    .select({
      id: schema.adCampaigns.id,
      companyName: schema.adCampaigns.companyName,
      title: schema.adCampaigns.title,
      description: schema.adCampaigns.description,
      imageUrl: schema.adCampaigns.imageUrl,
      destinationUrl: schema.adCampaigns.destinationUrl,
      utmSource: schema.adCampaigns.utmSource,
      utmMedium: schema.adCampaigns.utmMedium,
      utmCampaign: schema.adCampaigns.utmCampaign,
      utmTerm: schema.adCampaigns.utmTerm,
      utmContent: schema.adCampaigns.utmContent,
      packageViews: schema.adCampaigns.packageViews,
      priceCents: schema.adCampaigns.priceCents,
      viewsServed: schema.adCampaigns.viewsServed,
      status: schema.adCampaigns.status,
      createdAt: schema.adCampaigns.createdAt,
      paidAt: schema.adCampaigns.paidAt,
      activatedAt: schema.adCampaigns.activatedAt,
      deletedAt: schema.adCampaigns.deletedAt,
      removalReason: schema.adCampaigns.removalReason,
    })
    .from(schema.adCampaigns)
    .where(eq(schema.adCampaigns.userId, userId))
    .orderBy(desc(schema.adCampaigns.createdAt));

  return hydrateCampaignMetrics(campaigns);
}

async function hydrateCampaignMetrics<T extends AdvertiserCampaignRow>(
  campaigns: T[],
): Promise<Array<T & CampaignMetrics>> {
  if (campaigns.length === 0) return [];

  const campaignIds = campaigns.map((campaign) => campaign.id);
  const [seriesByCampaign, eventsByCampaign] = await Promise.all([
    loadCampaignTimeSeries(campaignIds),
    loadCampaignEventTotals(campaignIds),
  ]);

  return campaigns.map((campaign) => ({
    ...campaign,
    timeSeries: seriesByCampaign.get(campaign.id) ?? createEmptyTimeSeries(),
    hovers: eventsByCampaign.get(campaign.id)?.hovers ?? 0,
    clicks: eventsByCampaign.get(campaign.id)?.clicks ?? 0,
    dismissals: eventsByCampaign.get(campaign.id)?.dismissals ?? 0,
    avgTimeInViewMs:
      eventsByCampaign.get(campaign.id)?.avg_time_in_view_ms ?? 0,
  }));
}

async function loadCampaignTimeSeries(campaignIds: string[]) {
  const campaignIdsSubquery = createCampaignIdsSubquery(campaignIds);

  const seriesRows = await db.execute<{
    campaign_id: string;
    window_key: keyof AdCampaignTimeSeries;
    bucket: string;
    impressions: number;
    hovers: number;
    clicks: number;
  }>(sql`
    WITH campaign_ids AS (
      ${campaignIdsSubquery}
    ), buckets AS (
      SELECT 'eightHours'::text AS window_key, generate_series(date_trunc('hour', now()) - interval '7 hours', date_trunc('hour', now()), interval '1 hour') AS bucket
      UNION ALL
      SELECT 'day'::text AS window_key, generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') AS bucket
      UNION ALL
      SELECT 'week'::text AS window_key, generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS bucket
      UNION ALL
      SELECT 'month'::text AS window_key, generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS bucket
    ), campaign_buckets AS (
      SELECT ci.id AS campaign_id, b.window_key, b.bucket
      FROM campaign_ids ci
      CROSS JOIN buckets b
    ), impressions_source AS (
      SELECT
        ai.campaign_id,
        ai.created_at,
        count(*)::int AS impressions
      FROM ad_impressions ai
      INNER JOIN campaign_ids ci ON ci.id = ai.campaign_id
      WHERE ai.created_at >= now() - interval '30 days'
      GROUP BY ai.campaign_id, ai.created_at
    ), impressions AS (
      SELECT
        cb.campaign_id,
        cb.window_key,
        cb.bucket,
        coalesce(sum(src.impressions), 0)::int AS impressions
      FROM campaign_buckets cb
      LEFT JOIN impressions_source src
        ON src.campaign_id = cb.campaign_id
        AND src.created_at >= cb.bucket
        AND src.created_at < cb.bucket + CASE WHEN cb.window_key IN ('eightHours', 'day') THEN interval '1 hour' ELSE interval '1 day' END
      GROUP BY cb.campaign_id, cb.window_key, cb.bucket
    ), events_source AS (
      SELECT
        ae.campaign_id,
        ae.created_at,
        count(*) FILTER (WHERE ae.kind = 'hover')::int AS hovers,
        count(*) FILTER (WHERE ae.kind = 'click')::int AS clicks
      FROM ad_events ae
      INNER JOIN campaign_ids ci ON ci.id = ae.campaign_id
      WHERE ae.created_at >= now() - interval '30 days'
      GROUP BY ae.campaign_id, ae.created_at
    ), events AS (
      SELECT
        cb.campaign_id,
        cb.window_key,
        cb.bucket,
        coalesce(sum(src.hovers), 0)::int AS hovers,
        coalesce(sum(src.clicks), 0)::int AS clicks
      FROM campaign_buckets cb
      LEFT JOIN events_source src
        ON src.campaign_id = cb.campaign_id
        AND src.created_at >= cb.bucket
        AND src.created_at < cb.bucket + CASE WHEN cb.window_key IN ('eightHours', 'day') THEN interval '1 hour' ELSE interval '1 day' END
      GROUP BY cb.campaign_id, cb.window_key, cb.bucket
    )
    SELECT
      cb.campaign_id,
      cb.window_key,
      to_char(cb.bucket, 'YYYY-MM-DD HH24:MI') AS bucket,
      coalesce(i.impressions, 0)::int AS impressions,
      coalesce(e.hovers, 0)::int AS hovers,
      coalesce(e.clicks, 0)::int AS clicks
    FROM campaign_buckets cb
    LEFT JOIN impressions i ON i.campaign_id = cb.campaign_id AND i.window_key = cb.window_key AND i.bucket = cb.bucket
    LEFT JOIN events e ON e.campaign_id = cb.campaign_id AND e.window_key = cb.window_key AND e.bucket = cb.bucket
    ORDER BY cb.campaign_id, cb.window_key, cb.bucket
  `);

  const seriesByCampaign = new Map<string, AdCampaignTimeSeries>();
  for (const row of seriesRows.rows) {
    const current =
      seriesByCampaign.get(row.campaign_id) ?? createEmptyTimeSeries();
    current[row.window_key].push({
      label: row.bucket,
      impressions: Number(row.impressions),
      hovers: Number(row.hovers),
      clicks: Number(row.clicks),
    });
    seriesByCampaign.set(row.campaign_id, current);
  }

  return seriesByCampaign;
}

async function loadCampaignEventTotals(campaignIds: string[]) {
  const campaignIdsSubquery = createCampaignIdsSubquery(campaignIds);

  const eventRows = await db.execute<{
    campaign_id: string;
    hovers: number | string;
    clicks: number | string;
    dismissals: number | string;
    avg_time_in_view_ms: number | string | null;
  }>(sql`
    WITH campaign_ids AS (
      ${campaignIdsSubquery}
    )
    SELECT
      ae.campaign_id,
      count(*) FILTER (WHERE ae.kind = 'hover')::int AS hovers,
      count(*) FILTER (WHERE ae.kind = 'click')::int AS clicks,
      count(*) FILTER (WHERE ae.kind = 'dismissed')::int AS dismissals,
      avg(ae.duration_ms) FILTER (WHERE ae.kind = 'time_in_view')::int AS avg_time_in_view_ms
    FROM ad_events ae
    INNER JOIN campaign_ids ci ON ci.id = ae.campaign_id
    GROUP BY ae.campaign_id
  `);

  const eventsByCampaign = new Map(
    eventRows.rows.map((row) => [
      row.campaign_id,
      {
        hovers: Number(row.hovers),
        clicks: Number(row.clicks),
        dismissals: Number(row.dismissals),
        avg_time_in_view_ms: Number(row.avg_time_in_view_ms ?? 0),
      },
    ]),
  );

  return eventsByCampaign;
}

function createCampaignIdsSubquery(campaignIds: string[]): SQL {
  const values = sql.join(
    campaignIds.map((campaignId) => sql`(${campaignId})`),
    sql`, `,
  );
  return sql`SELECT id::text AS id FROM (VALUES ${values}) AS selected(id)`;
}

function createEmptyTimeSeries(): AdCampaignTimeSeries {
  return { eightHours: [], day: [], week: [], month: [] };
}

export async function recordAdEvent(params: {
  campaignId: string;
  kind: "hover" | "click" | "dismissed" | "time_in_view";
  userId: string | null;
  anonymousId: string | null;
  sessionId: string;
  requestId: string;
  durationMs: number | null;
  path: string;
  locale: string;
}): Promise<{ recorded: boolean }> {
  const result = await db.execute<{ id: string }>(sql`
    WITH campaign AS (
      SELECT id
      FROM ad_campaigns
      WHERE id = ${params.campaignId}
        AND deleted_at IS NULL
    ), inserted AS (
      INSERT INTO ad_events (
        id, campaign_id, kind, user_id, anonymous_id, session_id, request_id,
        duration_ms, path, locale
      )
      SELECT
        ${createAdEventId()}, ${params.campaignId}, ${params.kind}::ad_event_kind,
        ${params.userId}, ${params.anonymousId}, ${params.sessionId},
        ${params.requestId}, ${params.durationMs}, ${params.path}, ${params.locale}
      FROM campaign
      ON CONFLICT (campaign_id, kind, session_id, request_id) DO NOTHING
      RETURNING id
    )
    SELECT id FROM inserted
  `);
  return { recorded: result.rows.length > 0 };
}

export async function recordAdImpression(params: {
  campaignId: string;
  userId: string | null;
  anonymousId: string | null;
  sessionId: string;
  requestId: string;
  visibleMs: number;
  path: string;
  locale: string;
  userAgentHash: string | null;
  ipHash: string | null;
}): Promise<{ counted: boolean; exhausted: boolean }> {
  const result = await db.execute<{ id: string; status: string }>(sql`
    WITH campaign AS (
      SELECT id
      FROM ad_campaigns
      WHERE id = ${params.campaignId}
        AND status = 'active'
        AND deleted_at IS NULL
        AND views_served < package_views
    ), inserted AS (
      INSERT INTO ad_impressions (
        id, campaign_id, user_id, anonymous_id, session_id, request_id,
        visible_ms, path, locale, user_agent_hash, ip_hash
      )
      SELECT
        ${createAdImpressionId()}, ${params.campaignId}, ${params.userId},
        ${params.anonymousId}, ${params.sessionId}, ${params.requestId},
        ${params.visibleMs}, ${params.path}, ${params.locale},
        ${params.userAgentHash}, ${params.ipHash}
      FROM campaign
      ON CONFLICT (campaign_id, session_id, request_id) DO NOTHING
      RETURNING campaign_id
    ), updated AS (
      UPDATE ad_campaigns
      SET
        views_served = views_served + 1,
        status = CASE
          WHEN views_served + 1 >= package_views THEN 'exhausted'::ad_campaign_status
          ELSE status
        END,
        updated_at = now()
      WHERE id IN (SELECT campaign_id FROM inserted)
      RETURNING id, status
    )
    SELECT id, status FROM updated
  `);
  const row = result.rows[0];
  return { counted: Boolean(row), exhausted: row?.status === "exhausted" };
}
