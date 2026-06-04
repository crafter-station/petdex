import {
  BarChart2,
  Globe,
  MonitorSmartphone,
  Terminal,
  Users,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import {
  getTelemetrySummary,
  versionAdoptionOverTime,
} from "@/lib/telemetry/queries";

import { AdminAdoptionChart } from "@/components/admin-adoption-chart";
import { AdminVersionAdoptionChart } from "@/components/admin-version-adoption-chart";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Telemetry | Petdex admin",
  robots: { index: false, follow: false },
};

export default async function AdminTelemetryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.telemetry" });

  const [summary, adoptionOverTime] = await Promise.all([
    getTelemetrySummary(),
    versionAdoptionOverTime(),
  ]);

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

      <Card>
        <CardHeader>
          <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            <BarChart2 className="size-3" />
            Cost attribution
          </p>
          <CardTitle className="text-base md:text-lg">
            Estimated route requests, last 24 hours
          </CardTitle>
          <CardDescription>
            Top contributors by estimated request volume.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RouteCostList
            items={summary.routeCostTop}
            emptyLabel={t("noData")}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <BarChart2 className="size-3" />
              {t("sections.adoptionCurve")}
            </p>
            <CardTitle className="text-base md:text-lg">
              Daily installs, last 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AdminAdoptionChart
              data={summary.installsByDay}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <MonitorSmartphone className="size-3" />
              {t("sections.osDistribution")}
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              items={summary.osDistribution.map((r) => ({
                label: r.os,
                count: r.count,
              }))}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <MonitorSmartphone className="size-3" />
              {t("sections.archDistribution")}
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              items={summary.archDistribution.map((r) => ({
                label: r.arch,
                count: r.count,
              }))}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <BarChart2 className="size-3" />
              {t("sections.versionAdoption")}
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              items={summary.versionDistribution.map((r) => ({
                label: r.binary_version,
                count: r.count,
              }))}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <Terminal className="size-3" />
              {t("sections.topAgents")}
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              items={summary.topAgents.map((r) => ({
                label: r.agent,
                count: r.count,
              }))}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              <Globe className="size-3" />
              {t("sections.geoTop10")}
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              items={summary.countryTop10.map((r) => ({
                label: r.country,
                count: r.count,
              }))}
              emptyLabel={t("noData")}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            <BarChart2 className="size-3" />
            Version adoption
          </p>
          <CardTitle className="text-base md:text-lg">
            Version adoption over time
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AdminVersionAdoptionChart
            data={adoptionOverTime}
            emptyLabel={t("noData")}
          />
          <p className="mt-3 text-[10px] text-muted-3">
            Watch v0.2.0 reach 50% of installs
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            <BarChart2 className="size-3" />
            {t("sections.funnel")}
          </p>
          <CardTitle className="text-base md:text-lg">
            Install to first event
          </CardTitle>
          <CardDescription>
            Conversion rate from install to first telemetry event recorded.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
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
    <Card size="sm">
      <CardHeader>
        <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {icon}
          {label}
        </p>
        <CardTitle className="font-mono text-3xl tracking-tight">
          {value.toLocaleString()}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function RouteCostList({
  items,
  emptyLabel,
}: {
  items: {
    estimatedRequests: number;
    method: string;
    referrerSource: string;
    route: string;
    routeKind: string;
    samples: number;
    trafficSource: string;
  }[];
  emptyLabel: string;
}) {
  const max = Math.max(...items.map((item) => item.estimatedRequests), 0);
  if (items.length === 0 || max === 0) {
    return <p className="text-sm text-muted-3">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const pct =
          max > 0
            ? Math.max(4, Math.round((item.estimatedRequests / max) * 100))
            : 0;
        return (
          <li
            key={`${item.method}:${item.routeKind}:${item.route}:${item.trafficSource}:${item.referrerSource}`}
            className="grid gap-2 rounded-md border border-border-base px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_160px]"
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline">{item.method}</Badge>
                <span className="truncate font-mono text-xs text-foreground">
                  {item.route}
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] tracking-[0.14em] text-muted-4 uppercase">
                {item.routeKind} - {item.trafficSource} / {item.referrerSource}{" "}
                - {item.samples.toLocaleString()} samples
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-border-base">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand/60"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 text-right font-mono text-xs text-muted-2">
                {item.estimatedRequests.toLocaleString()}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
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
    <Card size="sm">
      <CardHeader>
        <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {label}
        </p>
        <CardTitle className="font-mono text-2xl tracking-tight">
          {count.toLocaleString()}
        </CardTitle>
        {pct !== undefined ? (
          <CardDescription>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {pct}% from prev
            </Badge>
          </CardDescription>
        ) : null}
      </CardHeader>
    </Card>
  );
}
