import Link from "next/link";

type PetdexLogoProps = {
  href?: string;
  showWordmark?: boolean;
  className?: string;
  markClassName?: string;
  ariaLabel?: string;
};

export function PetdexLogo({
  href,
  showWordmark = true,
  className = "",
  markClassName = "size-10",
  ariaLabel = "Petdex home",
}: PetdexLogoProps) {
  const content = (
    <>
      <PetdexMark className={markClassName} />
      {showWordmark ? (
        <span className="text-xl font-semibold tracking-normal">Petdex</span>
      ) : null}
    </>
  );

  const classes = `inline-flex items-center gap-3 text-foreground ${className}`;

  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        className={classes}
        aria-label={ariaLabel}
      >
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}

function PetdexMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="petdex-body"
          x1="8"
          y1="8"
          x2="56"
          y2="56"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3847f5" />
          <stop offset="1" stopColor="#1a1d2e" />
        </linearGradient>
      </defs>

      <rect
        x="4"
        y="4"
        width="56"
        height="56"
        rx="16"
        fill="url(#petdex-body)"
      />

      <g fill="#ffffff">
        <rect x="22" y="20" width="6" height="6" />
        <rect x="36" y="20" width="6" height="6" />
        <rect x="16" y="26" width="6" height="18" />
        <rect x="42" y="26" width="6" height="18" />
        <rect x="22" y="38" width="20" height="6" />
      </g>
    </svg>
  );
}
