"use client";

// Client wrapper around the /download CTA so we can attribute clicks
// per surface (hero vs /pets/<slug> vs site-header etc). Vercel
// Analytics rolls up `download_desktop_click` with the surface as a
// custom property.

import Link from "next/link";
import type { ReactNode } from "react";

import { track } from "@/lib/vercel-analytics";

type DownloadDesktopCTAProps = {
  href: string;
  source: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function DownloadDesktopCTA({
  href,
  source,
  children,
  className,
  ariaLabel,
}: DownloadDesktopCTAProps) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={className}
      onClick={() => {
        track("download_desktop_click", { source });
      }}
    >
      {children}
    </Link>
  );
}
