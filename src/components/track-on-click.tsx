"use client";

import type { ReactNode } from "react";

import { track } from "@/lib/vercel-analytics";

type TrackOnClickProps = {
  event: string;
  payload?: Record<string, string | number | boolean>;
  children: ReactNode;
  className?: string;
  href?: string;
  download?: boolean;
};

export function TrackOnClick({
  event,
  payload,
  children,
  className,
  href,
  download,
}: TrackOnClickProps) {
  return (
    <a
      href={href}
      download={download}
      className={className}
      onClick={() => {
        track(event, payload);
      }}
    >
      {children}
    </a>
  );
}
