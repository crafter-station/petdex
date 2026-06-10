"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type DownloadDesktopCTAProps = {
  href: string;
  source: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function DownloadDesktopCTA({
  href,
  children,
  className,
  ariaLabel,
}: DownloadDesktopCTAProps) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </Link>
  );
}
