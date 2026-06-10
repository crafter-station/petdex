import Image from "next/image";
import Link from "next/link";

import { ExternalLink } from "lucide-react";

import { formatUsd } from "@/lib/ads/packages";
import type { AdvertiserCampaign } from "@/lib/ads/queries";

import { AdAnalyticsTabs } from "@/components/ads/ad-analytics-tabs";

export type AdCampaignCardLabels = {
  editCreative?: string;
  progress: string;
  destination: string;
  removedFallback: string;
  created: (date: string) => string;
  activated: (date: string) => string;
  metrics: {
    package: string;
    served: string;
    remaining: string;
    spend: string;
    clicks: string;
    ctr: string;
    avgTime: string;
  };
  chartWindows: {
    eightHours: string;
    day: string;
    week: string;
    month: string;
  };
  chart: {
    label: string;
    empty: string;
    exactValues: string;
    bucket: string;
    impressions: string;
    hovers: string;
    clicks: string;
  };
};

export type AdCampaignOwnerDetails = {
  title: string;
  userIdLabel: string;
  contactEmailLabel: string;
  companyLabel: string;
  userId: string;
  contactEmail: string;
  companyName: string;
};

export function AdCampaignCard({
  campaign,
  editHref,
  labels,
  ownerDetails,
}: {
  campaign: AdvertiserCampaign;
  editHref?: string;
  labels: AdCampaignCardLabels;
  ownerDetails?: AdCampaignOwnerDetails;
}) {
  const served = Math.min(campaign.viewsServed, campaign.packageViews);
  const remaining = Math.max(campaign.packageViews - served, 0);
  const progress = Math.round((served / campaign.packageViews) * 100);
  const ctr = served > 0 ? (campaign.clicks / served) * 100 : 0;
  const editable =
    Boolean(editHref) && campaign.status !== "deleted" && !campaign.deletedAt;

  return (
    <article className="rounded-[2rem] border border-border-base bg-surface/82 p-5 shadow-sm shadow-blue-950/5 backdrop-blur md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
            {campaign.companyName}
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            {campaign.title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={campaign.status} />
          {editable && editHref && labels.editCreative ? (
            <Link
              href={editHref}
              className="inline-flex h-9 items-center justify-center rounded-full border border-border-base bg-background px-4 text-sm font-medium text-foreground transition hover:border-brand/60 hover:text-brand"
            >
              {labels.editCreative}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[180px_1fr]">
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border-base bg-background lg:aspect-square">
          <Image
            src={campaign.imageUrl}
            alt=""
            fill
            sizes="180px"
            className="object-cover"
          />
        </div>
        <div className="min-w-0">
          <p className="max-w-2xl text-sm leading-6 text-muted-2">
            {campaign.description}
          </p>

          {ownerDetails ? <OwnerDetails details={ownerDetails} /> : null}

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label={labels.metrics.package}
              value={formatAdMetricNumber(campaign.packageViews)}
            />
            <Metric
              label={labels.metrics.served}
              value={formatAdMetricNumber(served)}
            />
            <Metric
              label={labels.metrics.remaining}
              value={formatAdMetricNumber(remaining)}
            />
            <Metric
              label={labels.metrics.spend}
              value={formatUsd(campaign.priceCents)}
            />
            <Metric
              label={labels.metrics.clicks}
              value={formatAdMetricNumber(campaign.clicks)}
            />
            <Metric label={labels.metrics.ctr} value={`${ctr.toFixed(2)}%`} />
            <Metric
              label={labels.metrics.avgTime}
              value={formatAdDuration(campaign.avgTimeInViewMs)}
            />
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between gap-3 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
              <span>{labels.progress}</span>
              <span>{progress}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {campaign.status === "deleted" ? (
            <p className="mt-4 rounded-2xl bg-chip-danger-bg p-3 text-sm text-chip-danger-fg">
              {campaign.removalReason ?? labels.removedFallback}
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-3 text-sm text-muted-2">
            <a
              href={campaign.destinationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-brand underline-offset-4 hover:underline"
            >
              {labels.destination}
              <ExternalLink className="size-3.5" />
            </a>
            <span>{labels.created(formatAdDate(campaign.createdAt))}</span>
            {campaign.activatedAt ? (
              <span>
                {labels.activated(formatAdDate(campaign.activatedAt))}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-3xl border border-border-base bg-background/50 p-3">
        <AdAnalyticsTabs
          series={campaign.timeSeries}
          labels={labels.chartWindows}
          chartLabels={labels.chart}
        />
      </div>
    </article>
  );
}

function OwnerDetails({ details }: { details: AdCampaignOwnerDetails }) {
  return (
    <div className="mt-5 rounded-2xl border border-border-base bg-background/60 p-3">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {details.title}
      </p>
      <div className="mt-2 grid gap-2 text-xs text-muted-2 md:grid-cols-3">
        <OwnerField label={details.companyLabel} value={details.companyName} />
        <OwnerField
          label={details.contactEmailLabel}
          value={details.contactEmail}
        />
        <OwnerField label={details.userIdLabel} value={details.userId} />
      </div>
    </div>
  );
}

function OwnerField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9px] tracking-[0.16em] text-muted-3 uppercase">
        {label}
      </p>
      <p className="mt-0.5 truncate text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-chip-success-bg text-chip-success-fg"
      : status === "deleted" || status === "paused"
        ? "bg-chip-danger-bg text-chip-danger-fg"
        : "bg-chip-warning-bg text-chip-warning-fg";
  return (
    <span
      className={`rounded-full px-3 py-1 font-mono text-[10px] tracking-[0.16em] uppercase ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border-base bg-background p-3">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

export function formatAdMetricNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatAdDuration(value: number): string {
  if (value <= 0) return "0s";
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatAdDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}
