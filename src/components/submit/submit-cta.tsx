"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";

type SubmitCTAProps = {
  className?: string;
  children?: React.ReactNode;
  href?: string;
  variant?: "petdex-cta" | "petdex-secondary" | "petdex-inverse";
};

const DEFAULT_CLASS = "";

export function SubmitCTA({
  className = DEFAULT_CLASS,
  children = "Submit a pet",
  href = "/submit",
  variant = "petdex-cta",
}: SubmitCTAProps) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        buttonVariants({ variant, size: "petdex-pill" }),
        className,
      )}
    >
      {children}
    </Link>
  );
}
