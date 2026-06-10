"use client";

import { ExternalLink } from "lucide-react";

export function ProfileExternalLink({
  url,
  label,
}: {
  handle: string;
  url: string;
  label: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-base bg-surface/80 px-3 font-mono text-[11px] tracking-[0.06em] text-muted-2 transition hover:border-border-strong hover:bg-white dark:hover:bg-stone-800"
    >
      <ExternalLink className="size-3" />
      {label}
    </a>
  );
}
