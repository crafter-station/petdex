// Arrow-key navigation for the few `role="tablist"` groups in the app
// (install method/platform, leaderboard category). The ARIA tabs pattern
// requires arrow keys to move between tabs with a roving tabindex; without
// this the groups were mouse-only and screen readers announced a tablist the
// keyboard could not traverse. Activation follows focus, the APG's
// automatic-activation variant, because each group is a cheap local toggle.
import type { KeyboardEvent } from "react";

const NAV_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"] as const;

export function onTablistKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!(NAV_KEYS as readonly string[]).includes(event.key)) return;
  const container = event.currentTarget;
  const tabs = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  );
  if (tabs.length === 0) return;
  const from = tabs.indexOf(event.target as HTMLButtonElement);
  if (from === -1) return;

  const last = tabs.length - 1;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : event.key === "ArrowRight"
          ? (from + 1) % tabs.length
          : (from - 1 + tabs.length) % tabs.length;

  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
