import Link from "next/link";

import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";

type SubmitLinkProps = {
  href: string;
  label: string;
  variant: "desktop" | "mobile";
};

const variantClassName = {
  desktop: cn(
    buttonVariants({
      variant: "petdex-inverse",
      size: "petdex-pill",
      className: "hidden md:inline-flex",
    }),
  ),
  mobile: cn(
    buttonVariants({
      variant: "petdex-inverse",
      size: "petdex-pill",
      className: "mt-1 w-full justify-center text-sm",
    }),
  ),
} as const;

export function SubmitLink({ href, label, variant }: SubmitLinkProps) {
  return (
    <Link href={href} prefetch={false} className={variantClassName[variant]}>
      {label}
    </Link>
  );
}
