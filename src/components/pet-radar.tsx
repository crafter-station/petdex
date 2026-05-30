type PetRadarProps = {
  vibrance: number;
  popularity: number;
  loved: number;
  freshness: number;
  labels: {
    vibrance: string;
    popularity: string;
    loved: string;
    freshness: string;
  };
  ariaLabel: string;
};

const SIZE = 200;
const CENTER = SIZE / 2;
const MAX_RADIUS = 62;

const AXES = [
  {
    key: "vibrance",
    pointDx: 0,
    pointDy: -88,
    labelX: CENTER,
    labelY: 14,
  },
  {
    key: "popularity",
    pointDx: 88,
    pointDy: 0,
    labelX: 174,
    labelY: CENTER,
  },
  {
    key: "loved",
    pointDx: 0,
    pointDy: 88,
    labelX: CENTER,
    labelY: 188,
  },
  {
    key: "freshness",
    pointDx: -88,
    pointDy: 0,
    labelX: 26,
    labelY: CENTER,
  },
] as const satisfies ReadonlyArray<{
  key: keyof PetRadarProps;
  pointDx: number;
  pointDy: number;
  labelX: number;
  labelY: number;
}>;

function pointAt(dx: number, dy: number, scale: number) {
  return `${CENTER + dx * scale},${CENTER + dy * scale}`;
}

export function PetRadar(props: PetRadarProps) {
  const polygon = AXES.map((axis) =>
    pointAt(
      axis.pointDx,
      axis.pointDy,
      (props[axis.key] / 100) * (MAX_RADIUS / 88),
    ),
  ).join(" ");

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="mx-auto block aspect-square h-auto w-full max-w-[200px] overflow-visible"
      role="img"
      aria-label={props.ariaLabel}
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <polygon
            key={ratio}
            points={AXES.map((axis) =>
              pointAt(axis.pointDx, axis.pointDy, ratio * (MAX_RADIUS / 88)),
            ).join(" ")}
            className="stroke-muted-4"
            strokeWidth={ratio === 1 ? 1.25 : 1}
          />
        ))}
        {AXES.map((axis) => (
          <line
            key={axis.key}
            x1={CENTER}
            y1={CENTER}
            x2={CENTER + axis.pointDx * (MAX_RADIUS / 88)}
            y2={CENTER + axis.pointDy * (MAX_RADIUS / 88)}
            className="stroke-muted-4"
            strokeWidth={1}
          />
        ))}
        <polygon
          points={polygon}
          fill="var(--color-brand)"
          fillOpacity="0.3"
          stroke="var(--color-brand)"
          strokeWidth={2}
        />
      </g>

      {AXES.map((axis) => (
        <text
          key={axis.key}
          x={axis.labelX}
          y={axis.labelY}
          textAnchor={
            axis.pointDx === 0 ? "middle" : axis.pointDx > 0 ? "start" : "end"
          }
          dominantBaseline={
            axis.pointDy === 0
              ? "middle"
              : axis.pointDy > 0
                ? "hanging"
                : "auto"
          }
          className="fill-foreground font-mono text-[10px] tracking-[0.18em]"
        >
          {props.labels[axis.key]}
        </text>
      ))}
    </svg>
  );
}
