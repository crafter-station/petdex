"use client";

// Client wrapper around the Discord invite anchor so we can attribute
// clicks per surface (footer vs /community vs anywhere else we add it
// later). Vercel Analytics will roll up `discord_click` events with
// the surface as a custom property.

import type { ReactNode } from "react";

import { track } from "@/lib/vercel-analytics";

type DiscordLinkProps = {
  href: string;
  source: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function DiscordLink({
  href,
  source,
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
      onClick={() => {
        track("discord_click", { source });
      }}
    >
      {children}
    </a>
  );
}
