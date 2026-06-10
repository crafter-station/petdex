"use client";

import { useEffect, useState } from "react";

import { ClerkProvider } from "@clerk/nextjs";
import { useLocale } from "next-intl";
import { ThemeProvider, useTheme } from "next-themes";

type ClerkProviderProps = React.ComponentProps<typeof ClerkProvider>;
type ClerkAppearance = NonNullable<ClerkProviderProps["appearance"]>;

function ClerkWithTheme({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);
  const [baseTheme, setBaseTheme] =
    useState<ClerkAppearance["baseTheme"]>(undefined);
  const [localization, setLocalization] =
    useState<ClerkProviderProps["localization"]>(undefined);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let cancelled = false;
    if (mounted && resolvedTheme === "dark") {
      void import("@clerk/themes").then((mod) => {
        if (!cancelled) setBaseTheme(mod.dark);
      });
      return () => {
        cancelled = true;
      };
    }
    setBaseTheme(undefined);
    return () => {
      cancelled = true;
    };
  }, [mounted, resolvedTheme]);

  useEffect(() => {
    let cancelled = false;
    if (locale === "es") {
      void import("@clerk/localizations/es-ES").then((mod) => {
        if (cancelled) return;
        setLocalization(mod.esES);
      });
      return () => {
        cancelled = true;
      };
    }
    if (locale === "zh") {
      void import("@clerk/localizations/zh-CN").then((mod) => {
        if (cancelled) return;
        setLocalization(mod.zhCN);
      });
      return () => {
        cancelled = true;
      };
    }
    setLocalization(undefined);
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return (
    <ClerkProvider appearance={{ baseTheme }} localization={localization}>
      {children}
    </ClerkProvider>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ClerkWithTheme>{children}</ClerkWithTheme>
    </ThemeProvider>
  );
}
