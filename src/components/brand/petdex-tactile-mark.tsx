import { useId } from "react";

type PetdexTactileMarkProps = {
  className?: string;
  size?: number;
};

export function PetdexTactileMark({
  className = "size-16",
  size,
}: PetdexTactileMarkProps) {
  const uid = useId().replace(/:/g, "");
  const bodyGrad = `petdex-tactile-body-${uid}`;
  const topGloss = `petdex-tactile-gloss-${uid}`;
  const rimGrad = `petdex-tactile-rim-${uid}`;
  const glyphShadow = `petdex-tactile-glyph-${uid}`;
  const outerShadow = `petdex-tactile-outer-${uid}`;

  return (
    <svg
      role="img"
      aria-label="Petdex tactile mark"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient
          id={bodyGrad}
          x1="64"
          y1="8"
          x2="64"
          y2="120"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#5876FF" />
          <stop offset="32%" stopColor="#3B59F2" />
          <stop offset="74%" stopColor="#1D2F8A" />
          <stop offset="100%" stopColor="#101944" />
        </linearGradient>

        <radialGradient
          id={topGloss}
          cx="50%"
          cy="14%"
          r="65%"
          fx="50%"
          fy="10%"
        >
          <stop offset="0%" stopColor="#9BB2FF" stopOpacity="0.55" />
          <stop offset="45%" stopColor="#5C7BFF" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#101944" stopOpacity="0" />
        </radialGradient>

        <linearGradient
          id={rimGrad}
          x1="64"
          y1="8"
          x2="64"
          y2="120"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#C2D0FF" stopOpacity="0.72" />
          <stop offset="22%" stopColor="#7C96FF" stopOpacity="0.18" />
          <stop offset="80%" stopColor="#090F2B" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#050818" stopOpacity="0.6" />
        </linearGradient>

        <filter
          id={glyphShadow}
          x="26"
          y="36"
          width="76"
          height="58"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feDropShadow
            dx="0"
            dy="-1.2"
            stdDeviation="0.6"
            floodColor="#0B133A"
            floodOpacity="0.55"
          />
          <feDropShadow
            dx="0"
            dy="1.5"
            stdDeviation="1.4"
            floodColor="#091134"
            floodOpacity="0.32"
          />
        </filter>

        <filter
          id={outerShadow}
          x="0"
          y="2"
          width="128"
          height="126"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feDropShadow
            dx="0"
            dy="6"
            stdDeviation="5"
            floodColor="#0A1030"
            floodOpacity="0.28"
          />
        </filter>
      </defs>

      <g filter={`url(#${outerShadow})`}>
        <path
          d="M64 8C95.5 8 106.4 8 113.2 14.8C120 21.6 120 32.5 120 64C120 95.5 120 106.4 113.2 113.2C106.4 120 95.5 120 64 120C32.5 120 21.6 120 14.8 113.2C8 106.4 8 95.5 8 64C8 32.5 8 21.6 14.8 14.8C21.6 8 32.5 8 64 8Z"
          fill={`url(#${bodyGrad})`}
        />
        <path
          d="M64 8C95.5 8 106.4 8 113.2 14.8C120 21.6 120 32.5 120 64C120 95.5 120 106.4 113.2 113.2C106.4 120 95.5 120 64 120C32.5 120 21.6 120 14.8 113.2C8 106.4 8 95.5 8 64C8 32.5 8 21.6 14.8 14.8C21.6 8 32.5 8 64 8Z"
          fill={`url(#${topGloss})`}
        />
        <path
          d="M64 9.5C94.8 9.5 105.4 9.6 112 16C118.4 22.6 118.5 33.2 118.5 64C118.5 94.8 118.4 105.4 112 112C105.4 118.4 94.8 118.5 64 118.5C33.2 118.5 22.6 118.4 16 112C9.6 105.4 9.5 94.8 9.5 64C9.5 33.2 9.6 22.6 16 16C22.6 9.6 33.2 9.5 64 9.5Z"
          stroke={`url(#${rimGrad})`}
          strokeWidth="2.5"
        />
      </g>

      <g filter={`url(#${glyphShadow})`} fill="#FFFFFF">
        <rect x="44" y="40" width="12" height="12" />
        <rect x="72" y="40" width="12" height="12" />
        <rect x="32" y="52" width="12" height="36" />
        <rect x="84" y="52" width="12" height="36" />
        <rect x="44" y="76" width="40" height="12" />
      </g>
    </svg>
  );
}
