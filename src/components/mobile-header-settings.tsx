"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "next-intl";

type Controls = {
  ThemeToggle: React.ComponentType;
  LocaleSwitcher: React.ComponentType;
};

export function MobileHeaderSettings() {
  const t = useTranslations("header");
  const [controls, setControls] = useState<Controls | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      import("@/components/theme-toggle"),
      import("@/components/locale-switcher"),
    ]).then(([theme, locale]) => {
      if (!cancelled) {
        setControls({
          ThemeToggle: theme.ThemeToggle,
          LocaleSwitcher: locale.LocaleSwitcher,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-2 border-border-base border-t px-1 pt-3">
      <p className="px-2 pb-2 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
        {t("settings")}
      </p>
      <div className="flex items-center gap-2 px-2 pb-1">
        {controls ? (
          <>
            <controls.ThemeToggle />
            <controls.LocaleSwitcher />
          </>
        ) : (
          <>
            <span className="size-10 rounded-full border border-border-base bg-surface/70" />
            <span className="h-10 w-20 rounded-full border border-border-base bg-surface/70" />
          </>
        )}
      </div>
    </div>
  );
}
