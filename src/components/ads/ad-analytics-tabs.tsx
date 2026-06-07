"use client";

import { useId, useMemo, useState } from "react";

import type {
  AdCampaignSeriesPoint,
  AdCampaignTimeSeries,
} from "@/lib/ads/queries";

type WindowKey = keyof AdCampaignTimeSeries;
type MetricKey = "impressions" | "hovers" | "clicks";
type ChartLabels = {
  label: string;
  empty: string;
  exactValues: string;
  bucket: string;
  impressions: string;
  hovers: string;
  clicks: string;
};

const CHART = {
  width: 640,
  height: 220,
  top: 14,
  right: 14,
  bottom: 34,
  left: 44,
} as const;

const SERIES: Array<{ key: MetricKey; color: string }> = [
  { key: "impressions", color: "var(--color-brand)" },
  { key: "hovers", color: "#0ea5e9" },
  { key: "clicks", color: "#f59e0b" },
];

export function AdAnalyticsTabs({
  series,
  labels,
  chartLabels,
}: {
  series: AdCampaignTimeSeries;
  labels: Record<WindowKey, string>;
  chartLabels: ChartLabels;
}) {
  const [active, setActive] = useState<WindowKey>("day");
  const exactValuesId = useId();
  const data = series[active];
  const model = useMemo(() => createChartModel(data), [data]);

  return (
    <div className="mt-5 rounded-2xl border border-border-base bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-full border border-border-base bg-surface p-0.5">
          {(Object.keys(labels) as WindowKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              className={`rounded-full px-2.5 py-1 font-mono text-[9px] tracking-[0.1em] uppercase transition md:px-3 ${
                active === key
                  ? "bg-inverse text-on-inverse"
                  : "text-muted-3 hover:text-foreground"
              }`}
            >
              {labels[key]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-3">
          {SERIES.map((item) => (
            <Legend
              key={item.key}
              color={item.color}
              label={chartLabels[item.key]}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 aspect-[32/11] w-full overflow-hidden rounded-xl bg-surface/50">
        <svg
          role="img"
          aria-label={chartLabels.label}
          aria-describedby={exactValuesId}
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          className="h-full w-full"
        >
          <title>{chartLabels.label}</title>
          {model.grid.map((line) => (
            <g key={line.value}>
              <line
                x1={CHART.left}
                x2={CHART.width - CHART.right}
                y1={line.y}
                y2={line.y}
                className="stroke-border-base/70"
                strokeWidth="1"
              />
              <text
                x={CHART.left - 8}
                y={line.y + 4}
                textAnchor="end"
                className="fill-muted-3 font-mono text-[10px]"
              >
                {formatCompact(line.value)}
              </text>
            </g>
          ))}

          {model.xLabels.map((label) => (
            <text
              key={`${label.index}-${label.text}`}
              x={label.x}
              y={CHART.height - 10}
              textAnchor={label.anchor}
              className="fill-muted-3 text-[10px]"
            >
              {formatTick(label.text)}
            </text>
          ))}

          {SERIES.map((item) =>
            model.paths[item.key] ? (
              <path
                key={item.key}
                d={model.paths[item.key]}
                fill="none"
                stroke={item.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null,
          )}
        </svg>
      </div>

      <details
        id={exactValuesId}
        className="mt-3 rounded-xl border border-border-base bg-surface px-3 py-2"
      >
        <summary className="cursor-pointer font-mono text-[10px] tracking-[0.16em] text-muted-3 uppercase">
          {chartLabels.exactValues}
        </summary>
        {data.length > 0 ? (
          <div className="mt-2 max-h-52 overflow-auto">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead className="text-muted-3">
                <tr className="border-b border-border-base">
                  <th className="py-2 pr-3 font-medium">
                    {chartLabels.bucket}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {chartLabels.impressions}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {chartLabels.hovers}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {chartLabels.clicks}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.label} className="border-b border-border-base">
                    <td className="py-2 pr-3 text-muted-2">
                      {formatTick(point.label)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatInteger(point.impressions)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatInteger(point.hovers)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatInteger(point.clicks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-3">{chartLabels.empty}</p>
        )}
      </details>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function createChartModel(data: AdCampaignSeriesPoint[]) {
  const max = Math.max(
    1,
    ...data.flatMap((point) =>
      SERIES.map((item) => Number(point[item.key] ?? 0)),
    ),
  );
  const niceMax = niceCeil(max);
  const gridValues = createTickValues(niceMax);
  const scaleMax = gridValues[0] ?? niceMax;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const xFor = (index: number) =>
    CHART.left +
    (data.length <= 1 ? 0 : (index / (data.length - 1)) * plotWidth);
  const yFor = (value: number) =>
    CHART.top + plotHeight - (Math.max(0, value) / scaleMax) * plotHeight;

  const paths = Object.fromEntries(
    SERIES.map((item) => [
      item.key,
      data
        .map((point, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xFor(index).toFixed(1)},${yFor(point[item.key]).toFixed(1)}`;
        })
        .join(" "),
    ]),
  ) as Record<MetricKey, string>;

  const grid = gridValues.map((value) => ({
    value,
    y: yFor(value),
  }));

  const xLabelIndexes = uniqueNumbers([
    0,
    Math.floor((data.length - 1) / 2),
    data.length - 1,
  ]).filter((index) => index >= 0 && index < data.length);
  const xLabels = xLabelIndexes.map((index) => ({
    index,
    text: data[index]?.label ?? "",
    x: xFor(index),
    anchor:
      index === 0 ? "start" : index === data.length - 1 ? "end" : "middle",
  })) as Array<{
    index: number;
    text: string;
    x: number;
    anchor: "start" | "middle" | "end";
  }>;

  return { paths, grid, xLabels };
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function niceCeil(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function createTickValues(max: number): number[] {
  if (max <= 5) {
    return Array.from({ length: max + 1 }, (_, index) => max - index);
  }

  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let value = top; value >= 0; value -= step) {
    values.push(value);
  }
  if (values.at(-1) !== 0) values.push(0);
  return values;
}

function niceStep(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTick(value: string): string {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}
