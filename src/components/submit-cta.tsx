"use client";

import Link from "next/link";

import { SignInButton, useAuth } from "@clerk/nextjs";

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
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) {
    return (
      <SignInButton
        mode="modal"
        forceRedirectUrl={href}
        signUpForceRedirectUrl={href}
      >
        <Button
          variant="petdex-cta"
          size="petdex-pill"
          className={className}
          render={<button type="button" />}
        >
          {children}
        </Button>
      </SignInButton>
    );
  }

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
