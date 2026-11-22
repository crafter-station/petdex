"use client";

import { ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";

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
      className={cn(
        buttonVariants({ variant: "pearl", size: "default" }),
        "font-mono text-[11px] tracking-[0.06em]",
      )}
    >
      <ExternalLink className="size-3" />
      {label}
    </a>
  );
}
