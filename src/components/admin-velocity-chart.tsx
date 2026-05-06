// Tiny inline SVG bar chart for submission velocity. We avoid pulling
// a chart library into the admin bundle — this is a single 24-hour
// view of three counts per bucket. The y-scale is fitted to the
// max(approved + pending + rejected) across the window so the chart
// doesn't overflow even on big spikes.

import type { SubmissionVelocityPoint } from "@/lib/admin-insights";

type Props = {
  data: SubmissionVelocityPoint[];
};

const COLORS = {
  approved: "var(--chip-success-fg)",
  pending: "var(--chip-warning-fg)",
  rejected: "var(--chip-danger-fg)",
};

export function AdminVelocityChart({ data }: Props) {
  const maxStack = data.reduce(
    (acc, point) =>
      Math.max(acc, point.approved + point.pending + point.rejected),
    0,
  );
  if (data.length === 0 || maxStack === 0) {
    return (
      <p className="text-sm text-muted-3">
        No submissions in the last 24 hours.
      </p>
    );
  }
  const yScale = 1 / maxStack; // unit = bar height fraction
  const barWidthPct = 100 / data.length;

  return (
    <div className="space-y-3">
      <div className="relative h-32 w-full">
        <svg
          role="img"
          aria-label="Submissions per hour, last 24 hours"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="size-full"
        >
          <title>Submissions per hour, last 24 hours</title>
          {data.map((point, i) => {
            const x = i * barWidthPct;
            const approvedH = point.approved * yScale * 100;
            const pendingH = point.pending * yScale * 100;
            const rejectedH = point.rejected * yScale * 100;
            const barW = barWidthPct * 0.78;
            const xCenter = x + (barWidthPct - barW) / 2;
            // Stack from bottom: approved → pending → rejected.
            const yApproved = 100 - approvedH;
            const yPending = yApproved - pendingH;
            const yRejected = yPending - rejectedH;
            return (
              <g key={point.bucket}>
                <rect
                  x={xCenter}
                  y={yApproved}
                  width={barW}
                  height={approvedH}
                  fill={COLORS.approved}
                  opacity={0.8}
                />
                <rect
                  x={xCenter}
                  y={yPending}
                  width={barW}
                  height={pendingH}
                  fill={COLORS.pending}
                  opacity={0.8}
                />
                <rect
                  x={xCenter}
                  y={yRejected}
                  width={barW}
                  height={rejectedH}
                  fill={COLORS.rejected}
                  opacity={0.8}
                />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        <Legend color={COLORS.approved} label="Approved" />
        <Legend color={COLORS.pending} label="Pending" />
        <Legend color={COLORS.rejected} label="Rejected" />
        <span className="ml-auto">Last 24h • peak {maxStack}/h</span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
