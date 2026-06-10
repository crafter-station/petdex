"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

type SubmitCTAProps = {
  className?: string;
  children?: React.ReactNode;
  href?: string;
};

const DEFAULT_CLASS =
  "inline-flex h-10 items-center justify-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover";

export function SubmitCTA({
  className = DEFAULT_CLASS,
  children = "Submit a pet",
  href = "/submit",
}: SubmitCTAProps) {
  return (
    <Button
      variant="petdex-cta"
      size="petdex-pill"
      className={className}
      render={<Link href={href} prefetch={false} />}
    >
      {children}
    </Button>
  );
}
