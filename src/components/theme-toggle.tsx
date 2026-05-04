"use client";

import { useEffect, useState } from "react";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

// Cycles light -> dark -> system. Icon-only because it sits next to
// the bell + UserButton in the header and we don't want to widen
// that cluster. Renders a sun placeholder until mounted to avoid the
// hydration flash next-themes warns about.
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function next() {
    if (theme === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else setTheme("system");
  }

  // Pre-mount: render the icon that matches the SSR background
  // (light) so the layout doesn't shift.
  const showDark = mounted && resolvedTheme === "dark";
  const Icon = !mounted
    ? Sun
    : theme === "system"
      ? Monitor
      : showDark
        ? Moon
        : Sun;

  const label = !mounted
    ? "Toggle theme"
    : theme === "system"
      ? `System (${resolvedTheme})`
      : theme === "dark"
        ? "Dark"
        : "Light";

  return (
    <button
      type="button"
      aria-label={`Theme: ${label}. Click to cycle.`}
      title={`Theme: ${label}`}
      onClick={next}
      className={
        className ??
        "grid size-10 place-items-center rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition hover:bg-white dark:hover:bg-stone-800"
      }
    >
      <Icon className="size-4" />
    </button>
  );
}
