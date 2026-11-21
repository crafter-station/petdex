import Link from "next/link";

import { PetdexTactileMark } from "@/components/brand/petdex-tactile-mark";

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
      <span aria-hidden="true" className="inline-flex">
        <PetdexTactileMark className={markClassName} />
      </span>
      {showWordmark ? (
        <span
          className="text-xl font-bold tracking-[-0.03em]"
          style={{
            fontFamily: "var(--font-display), var(--font-cjk), sans-serif",
          }}
        >
          Petdex
        </span>
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
