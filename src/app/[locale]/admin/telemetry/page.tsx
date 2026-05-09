import {
  BarChart2,
  Globe,
  MonitorSmartphone,
  Terminal,
  Users,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { getTelemetrySummary } from "@/lib/telemetry/queries";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Telemetry — Petdex admin",
  robots: { index: false, follow: false },
};

export default async function AdminTelemetryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.telemetry" });

  const summary = await getTelemetrySummary();

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pb-16 md:px-8">
      <header>
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-2">
          {t("description")}
        </p>
      </header>

      {summary.totalEvents === 0 ? (
        <p className="text-sm text-muted-3">{t("empty")}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t("stats.totalInstalls")}
          value={summary.totalInstalls}
          icon={<Terminal className="size-3.5" />}
        />
        <StatCard
          label={t("stats.weeklyActive")}
          value={summary.weeklyActiveInstalls}
          icon={<Users className="size-3.5" />}
        />
        <StatCard
          label={t("stats.totalEvents")}
          value={summary.totalEvents}
          icon={<BarChart2 className="size-3.5" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t("sections.adoptionCurve")}
          icon={<BarChart2 className="size-3.5" />}
        >
          <AdoptionChart data={summary.installsByDay} />
        </ChartCard>

        <ChartCard
          title={t("sections.osDistribution")}
          icon={<MonitorSmartphone className="size-3.5" />}
        >
          <BarList
            items={summary.osDistribution.map((r) => ({
              label: r.os,
              count: r.count,
            }))}
            emptyLabel={t("noData")}
          />
        </ChartCard>

        <ChartCard
          title={t("sections.archDistribution")}
          icon={<MonitorSmartphone className="size-3.5" />}
        >
          <BarList
            items={summary.archDistribution.map((r) => ({
              label: r.arch,
              count: r.count,
            }))}
            emptyLabel={t("noData")}
          />
        </ChartCard>

        <ChartCard
          title={t("sections.versionAdoption")}
          icon={<BarChart2 className="size-3.5" />}
        >
          <BarList
            items={summary.versionDistribution.map((r) => ({
              label: r.binary_version,
              count: r.count,
            }))}
            emptyLabel={t("noData")}
          />
        </ChartCard>

        <ChartCard
          title={t("sections.topAgents")}
          icon={<Terminal className="size-3.5" />}
        >
          <BarList
            items={summary.topAgents.map((r) => ({
              label: r.agent,
              count: r.count,
            }))}
            emptyLabel={t("noData")}
          />
        </ChartCard>

        <ChartCard
          title={t("sections.geoTop10")}
          icon={<Globe className="size-3.5" />}
        >
          <BarList
            items={summary.countryTop10.map((r) => ({
              label: r.country,
              count: r.count,
            }))}
            emptyLabel={t("noData")}
          />
        </ChartCard>
      </div>

      <ChartCard
        title={t("sections.funnel")}
        icon={<BarChart2 className="size-3.5" />}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FunnelCard
            label={t("funnel.install")}
            count={summary.funnel.install}
          />
          <FunnelCard
            label={t("funnel.hooks")}
            count={summary.funnel.hooks}
            pct={summary.funnel.installToHooksPct}
          />
          <FunnelCard
            label={t("funnel.start")}
            count={summary.funnel.start}
            pct={summary.funnel.hooksToStartPct}
          />
          <FunnelCard
            label={t("funnel.firstEvent")}
            count={summary.funnel.firstEvent}
            pct={summary.funnel.startToFirstPct}
          />
        </div>
      </ChartCard>
    </section>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
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
    </article>
  );
}

function ChartCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-5 backdrop-blur">
      <header className="mb-4 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {icon}
        {title}
      </header>
      {children}
    </article>
  );
}

function AdoptionChart({ data }: { data: { date: string; count: number }[] }) {
  const max = data.reduce((a, r) => Math.max(a, r.count), 0);
  if (data.length === 0 || max === 0) {
    return <p className="text-sm text-muted-3">No data yet.</p>;
  }
  return (
    <div className="relative h-24 w-full">
      <svg
        role="img"
        aria-label="Daily install counts over last 30 days"
        viewBox={`0 0 ${data.length * 10} 40`}
        preserveAspectRatio="none"
        className="h-full w-full"
      >
        {data.map((d, i) => {
          const h = max > 0 ? (d.count / max) * 36 : 0;
          return (
            <rect
              key={d.date}
              x={i * 10 + 1}
              y={40 - h}
              width={8}
              height={h}
              rx={1}
              className="fill-brand/70"
            />
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-3">
        <span>{data[0]?.date?.slice(5) ?? ""}</span>
        <span>{data[data.length - 1]?.date?.slice(5) ?? ""}</span>
      </div>
    </div>
  );
}

function BarList({
  items,
  emptyLabel,
}: {
  items: { label: string; count: number }[];
  emptyLabel: string;
}) {
  const total = items.reduce((a, r) => a + r.count, 0);
  if (items.length === 0 || total === 0) {
    return <p className="text-sm text-muted-3">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
        return (
          <li key={item.label} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-2">
              {item.label}
            </span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-border-base">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-brand/60"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-12 text-right font-mono text-xs text-muted-3">
              {item.count.toLocaleString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FunnelCard({
  label,
  count,
  pct,
}: {
  label: string;
  count: number;
  pct?: number;
}) {
  return (
    <div className="rounded-2xl border border-border-base bg-background/40 px-3 py-3">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight text-foreground">
        {count.toLocaleString()}
      </p>
      {pct !== undefined ? (
        <p className="mt-0.5 font-mono text-xs text-brand">{pct}% from prev</p>
      ) : null}
    </div>
  );
}
