import Link from "next/link";

import { getTranslations } from "next-intl/server";

import type { AdvertiserCampaign } from "@/lib/ads/queries";
import { withLocale } from "@/lib/locale-routing";

import {
  AdCampaignCard,
  formatAdMetricNumber,
} from "@/components/ads/ad-campaign-card";

import type { Locale } from "@/i18n/config";

export async function AdDashboard({
  campaigns,
  locale,
}: {
  campaigns: AdvertiserCampaign[];
  locale: Locale;
}) {
  const t = await getTranslations("advertise.dashboard");
  const createHref = withLocale("/advertise/new", locale);

  if (campaigns.length === 0) {
    return (
      <div className="rounded-[2rem] border border-border-base bg-surface/82 p-8 text-center shadow-xl shadow-blue-950/5 backdrop-blur">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
          {t("empty.eyebrow")}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">
          {t("empty.title")}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-2">
          {t("empty.body")}
        </p>
        <Link
          href={createHref}
          className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          {t("empty.cta")}
        </Link>
      </div>
    );
  }

  const totalServed = campaigns.reduce(
    (sum, campaign) =>
      sum + Math.min(campaign.viewsServed, campaign.packageViews),
    0,
  );
  const totalClicks = campaigns.reduce(
    (sum, campaign) => sum + campaign.clicks,
    0,
  );
  const activeCampaigns = campaigns.filter(
    (campaign) => campaign.status === "active" && !campaign.deletedAt,
  ).length;
  const ctr = totalServed > 0 ? (totalClicks / totalServed) * 100 : 0;
  const cardLabels = {
    editCreative: t("editCreative"),
    progress: t("progress"),
    destination: t("destination"),
    removedFallback: t("removedFallback"),
    created: (date: string) => t("created", { date }),
    activated: (date: string) => t("activated", { date }),
    metrics: {
      package: t("metrics.package"),
      served: t("metrics.served"),
      remaining: t("metrics.remaining"),
      spend: t("metrics.spend"),
      clicks: t("metrics.clicks"),
      ctr: t("metrics.ctr"),
      avgTime: t("metrics.avgTime"),
    },
    chartWindows: {
      eightHours: t("chart.windows.eightHours"),
      day: t("chart.windows.day"),
      week: t("chart.windows.week"),
      month: t("chart.windows.month"),
    },
    chart: {
      label: t("chart.label"),
      empty: t("chart.empty"),
      exactValues: t("chart.exactValues"),
      bucket: t("chart.bucket"),
      impressions: t("chart.impressions"),
      hovers: t("chart.hovers"),
      clicks: t("chart.clicks"),
    },
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard
          label={t("summary.total")}
          value={formatAdMetricNumber(campaigns.length)}
        />
        <SummaryCard
          label={t("summary.active")}
          value={formatAdMetricNumber(activeCampaigns)}
        />
        <SummaryCard
          label={t("summary.served")}
          value={formatAdMetricNumber(totalServed)}
        />
        <SummaryCard
          label={t("summary.clicks")}
          value={formatAdMetricNumber(totalClicks)}
        />
        <SummaryCard label={t("summary.ctr")} value={`${ctr.toFixed(2)}%`} />
      </div>

      {campaigns.map((campaign) => {
        const editHref = withLocale(
          `/advertise/dashboard/${campaign.id}/edit`,
          locale,
        );
        return (
          <AdCampaignCard
            key={campaign.id}
            campaign={campaign}
            editHref={editHref}
            labels={cardLabels}
          />
        );
      })}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-4 backdrop-blur">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {label}
      </p>
      <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
    </article>
  );
}
