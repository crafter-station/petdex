import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  combineRouteCostAttributionRows,
  type RouteCostAttributionRow,
  type RouteCostBucketInput,
  type RouteCostSourceBucketInput,
} from "@/lib/telemetry/route-cost-attribution";

export type InstallsByDayRow = { date: string; count: number };
export type OsRow = { os: string; count: number };
export type ArchRow = { arch: string; count: number };
export type VersionRow = { binary_version: string; count: number };
export type AgentRow = { agent: string; count: number };
export type CountryRow = { country: string; count: number };
export type RouteCostRow = RouteCostAttributionRow;
export type VersionAdoptionRow = {
  day: string;
  version: string;
  installs: number;
};

export type TelemetrySummary = {
  totalInstalls: number;
  weeklyActiveInstalls: number;
  totalEvents: number;
  installsByDay: InstallsByDayRow[];
  osDistribution: OsRow[];
  archDistribution: ArchRow[];
  versionDistribution: VersionRow[];
  topAgents: AgentRow[];
  countryTop10: CountryRow[];
  routeCostTop: RouteCostRow[];
  funnel: {
    install: number;
    hooks: number;
    start: number;
    firstEvent: number;
    installToHooksPct: number;
    hooksToStartPct: number;
    startToFirstPct: number;
  };
};

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseInt(v, 10) || 0;
  return 0;
}

export async function getTelemetrySummary(): Promise<TelemetrySummary> {
  const [
    totalsResult,
    wauResult,
    totalEventsResult,
    byDayResult,
    osResult,
    archResult,
    versionResult,
    agentsResult,
    countryResult,
    routeCostResult,
    funnelResult,
  ] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(DISTINCT install_id) AS total
      FROM telemetry_events
      WHERE event = 'cli_install_desktop_success'
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT install_id) AS total
      FROM telemetry_events
      WHERE created_at >= now() - interval '7 days'
    `),
    db.execute(sql`
      SELECT COUNT(*) AS total FROM telemetry_events
    `),
    db.execute(sql`
      SELECT
        to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
        COUNT(DISTINCT install_id) AS count
      FROM telemetry_events
      WHERE
        event = 'cli_install_desktop_success'
        AND created_at >= now() - interval '30 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at) ASC
    `),
    db.execute(sql`
      SELECT os, COUNT(*) AS count
      FROM telemetry_events
      WHERE event = 'cli_install_desktop_success' AND os IS NOT NULL
      GROUP BY os
      ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT arch, COUNT(*) AS count
      FROM telemetry_events
      WHERE event = 'cli_install_desktop_success' AND arch IS NOT NULL
      GROUP BY arch
      ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT binary_version, COUNT(*) AS count
      FROM telemetry_events
      WHERE event = 'cli_install_desktop_success' AND binary_version IS NOT NULL
      GROUP BY binary_version
      ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT
        agent_text AS agent,
        COUNT(*) AS count
      FROM telemetry_events,
           jsonb_array_elements_text(agents) AS agent_text
      WHERE event = 'cli_hooks_install_success' AND agents IS NOT NULL
      GROUP BY agent_text
      ORDER BY count DESC
      LIMIT 10
    `),
    db.execute(sql`
      SELECT country, COUNT(*) AS count
      FROM telemetry_events
      WHERE country IS NOT NULL
      GROUP BY country
      ORDER BY count DESC
      LIMIT 10
    `),
    getRouteCostTop(),
    db.execute(sql`
      SELECT
        COUNT(DISTINCT CASE WHEN event = 'cli_install_desktop_success' THEN install_id END) AS install,
        COUNT(DISTINCT CASE WHEN event = 'cli_hooks_install_success'  THEN install_id END) AS hooks,
        COUNT(DISTINCT CASE WHEN event = 'cli_desktop_start_success'  THEN install_id END) AS start,
        COUNT(DISTINCT CASE WHEN event = 'desktop_first_state_received' THEN install_id END) AS first_event
      FROM telemetry_events
    `),
  ]);

  const totalInstalls = toNum(
    (totalsResult as unknown as { rows: Array<{ total: unknown }> }).rows[0]
      ?.total,
  );
  const weeklyActiveInstalls = toNum(
    (wauResult as unknown as { rows: Array<{ total: unknown }> }).rows[0]
      ?.total,
  );
  const totalEvents = toNum(
    (totalEventsResult as unknown as { rows: Array<{ total: unknown }> })
      .rows[0]?.total,
  );

  const installsByDay = (
    (
      byDayResult as unknown as {
        rows: Array<{ date: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ date: r.date, count: toNum(r.count) }));

  const osDistribution = (
    (
      osResult as unknown as {
        rows: Array<{ os: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ os: r.os, count: toNum(r.count) }));

  const archDistribution = (
    (
      archResult as unknown as {
        rows: Array<{ arch: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ arch: r.arch, count: toNum(r.count) }));

  const versionDistribution = (
    (
      versionResult as unknown as {
        rows: Array<{ binary_version: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ binary_version: r.binary_version, count: toNum(r.count) }));

  const topAgents = (
    (
      agentsResult as unknown as {
        rows: Array<{ agent: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ agent: r.agent, count: toNum(r.count) }));

  const countryTop10 = (
    (
      countryResult as unknown as {
        rows: Array<{ country: string; count: unknown }>;
      }
    ).rows ?? []
  ).map((r) => ({ country: r.country, count: toNum(r.count) }));

  const routeCostTop = routeCostResult;

  const funnelRow = (
    funnelResult as unknown as {
      rows: Array<{
        install: unknown;
        hooks: unknown;
        start: unknown;
        first_event: unknown;
      }>;
    }
  ).rows[0] ?? { install: 0, hooks: 0, start: 0, first_event: 0 };

  const fInstall = toNum(funnelRow.install);
  const fHooks = toNum(funnelRow.hooks);
  const fStart = toNum(funnelRow.start);
  const fFirst = toNum(funnelRow.first_event);

  const pct = (n: number, d: number) =>
    d === 0 ? 0 : Math.round((n / d) * 100);

  return {
    totalInstalls,
    weeklyActiveInstalls,
    totalEvents,
    installsByDay,
    osDistribution,
    archDistribution,
    versionDistribution,
    topAgents,
    countryTop10,
    routeCostTop,
    funnel: {
      install: fInstall,
      hooks: fHooks,
      start: fStart,
      firstEvent: fFirst,
      installToHooksPct: pct(fHooks, fInstall),
      hooksToStartPct: pct(fStart, fHooks),
      startToFirstPct: pct(fFirst, fStart),
    },
  };
}

async function getRouteCostTop(): Promise<RouteCostRow[]> {
  let legacyRows: RouteCostBucketInput[];
  try {
    const legacyResult = await db.execute(sql`
      SELECT
        bucket_start,
        method,
        route,
        route_kind,
        SUM(sample_count) AS samples,
        SUM(estimated_requests) AS estimated_requests
      FROM route_cost_buckets
      WHERE bucket_start >= now() - interval '24 hours'
      GROUP BY bucket_start, method, route, route_kind
    `);
    legacyRows = mapLegacyRows(legacyResult);
  } catch {
    return [];
  }

  let sourceRows: RouteCostSourceBucketInput[] = [];
  try {
    const sourceResult = await db.execute(sql`
      SELECT
        bucket_start,
        method,
        referrer_source,
        route,
        route_kind,
        traffic_source,
        SUM(sample_count) AS samples,
        SUM(estimated_requests) AS estimated_requests
      FROM route_cost_source_buckets
      WHERE bucket_start >= now() - interval '24 hours'
      GROUP BY
        bucket_start,
        method,
        route,
        route_kind,
        traffic_source,
        referrer_source
    `);
    sourceRows = mapSourceRows(sourceResult);
  } catch {}

  return combineRouteCostAttributionRows(legacyRows, sourceRows, 20);
}

function mapLegacyRows(result: unknown): RouteCostBucketInput[] {
  return (
    (
      result as {
        rows?: Array<{
          bucket_start: unknown;
          estimated_requests: unknown;
          method: string;
          route: string;
          route_kind: string;
          samples: unknown;
        }>;
      }
    ).rows ?? []
  ).map((r) => ({
    bucketStart: String(r.bucket_start),
    estimatedRequests: toNum(r.estimated_requests),
    method: r.method,
    route: r.route,
    routeKind: r.route_kind,
    samples: toNum(r.samples),
  }));
}

function mapSourceRows(result: unknown): RouteCostSourceBucketInput[] {
  return (
    (
      result as {
        rows?: Array<{
          bucket_start: unknown;
          estimated_requests: unknown;
          method: string;
          referrer_source: string;
          route: string;
          route_kind: string;
          samples: unknown;
          traffic_source: string;
        }>;
      }
    ).rows ?? []
  ).map((r) => ({
    bucketStart: String(r.bucket_start),
    estimatedRequests: toNum(r.estimated_requests),
    method: r.method,
    referrerSource: r.referrer_source,
    route: r.route,
    routeKind: r.route_kind,
    samples: toNum(r.samples),
    trafficSource: r.traffic_source,
  }));
}

export async function versionAdoptionOverTime(): Promise<VersionAdoptionRow[]> {
  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      binary_version AS version,
      COUNT(DISTINCT install_id) AS installs
    FROM telemetry_events
    WHERE
      event = 'cli_install_desktop_success'
      AND created_at >= NOW() - INTERVAL '60 days'
    GROUP BY 1, 2
    ORDER BY 1
  `);

  return (
    (
      result as unknown as {
        rows: Array<{ day: string; version: string | null; installs: unknown }>;
      }
    ).rows ?? []
  )
    .filter((r) => r.version !== null && r.version !== "")
    .map((r) => ({
      day: r.day,
      version: r.version as string,
      installs: toNum(r.installs),
    }));
}
