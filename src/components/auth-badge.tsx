"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

import { useAuthIntent } from "@/components/auth-intent";
import { Button } from "@/components/ui/button";

type AuthBadgeComponent = React.ComponentType<{ compact?: boolean }>;

export function AuthBadge({ compact = false }: { compact?: boolean }) {
  const { authActive, requestAuth } = useAuthIntent();
  const [AuthBadgeAuth, setAuthBadgeAuth] = useState<AuthBadgeComponent | null>(
    null,
  );
  const t = useTranslations("header");

  useEffect(() => {
    if (!authActive || AuthBadgeAuth) return;
    let cancelled = false;
    void import("@/components/auth-badge-auth").then((mod) => {
      if (!cancelled) setAuthBadgeAuth(() => mod.AuthBadge);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthBadgeAuth, authActive]);

  if (authActive && AuthBadgeAuth) return <AuthBadgeAuth compact={compact} />;
  return (
    <Button
      variant="petdex-pill"
      type="button"
      onClick={requestAuth}
      className={cn(
        "px-4 font-medium transition-[height,font-size] duration-200",
        compact ? "h-9 text-xs" : "h-11 text-sm",
      )}
    >
      {t("signIn")}
    </Button>
  );
}
