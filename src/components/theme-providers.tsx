"use client";

import { ThemeProvider } from "next-themes";

import { AuthIntentProvider } from "@/components/auth-intent";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <AuthIntentProvider>{children}</AuthIntentProvider>
    </ThemeProvider>
  );
}
