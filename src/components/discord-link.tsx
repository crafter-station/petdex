"use client";

import type { ReactNode } from "react";

type DiscordLinkProps = {
  href: string;
  source: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function DiscordLink({
  href,
  children,
  className,
  ariaLabel,
}: DiscordLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </a>
  );
}
