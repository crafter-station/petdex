"use client";

import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";

// Paused — see QUEUE below. Keep the import so re-enabling is one
// line and we catch any rename to the modal at typecheck time.
// biome-ignore lint/correctness/noUnusedImports: scheduled to come back when /download is public
import { DesktopAnnouncementModal as _DesktopAnnouncementModal } from "@/components/desktop-announcement-modal";
import { GithubStarModal } from "@/components/github-star-modal";

void _DesktopAnnouncementModal;

type QueuedAnnouncement = {
  id: string;
  delayMs: number;
  gateMs: number;
  Component: ComponentType<{ onClose: () => void }>;
};

const HOME_PATH_RE = /^\/(?:en|es|zh)?\/?$/;

// Order matters — github-star runs first (permanent CTA), then the
// desktop launch announcement (one-shot per browser, dismissed via
// localStorage). The collections + vibe-search announcements were
// retired now that those features are mature.
//
// NOTE: the desktop announcement is paused while the desktop app
// is in admin-only pre-launch. Restore the entry below to re-enable
// once /download is publicly accessible.
const QUEUE: QueuedAnnouncement[] = [
  {
    id: "petdex_announce_github_star_v1",
    delayMs: 1200,
    gateMs: 600,
    Component: GithubStarModal,
  },
  // {
  //   id: "petdex_announce_desktop_v1",
  //   delayMs: 0,
  //   gateMs: 0,
  //   Component: DesktopAnnouncementModal,
  // },
];

type Phase = "idle" | "showing";

function isEligible(_index: number, pathname: string | null) {
  // Both modals only fire from the home page so contributors landing on
  // /pets/<slug> or /admin don't get hit with marketing.
  return HOME_PATH_RE.test(pathname ?? "/");
}

export function AnnouncementQueue() {
  const pathname = usePathname();
  const [index, setIndex] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const activeItem = useMemo(
    () => (index === null ? null : (QUEUE[index] ?? null)),
    [index],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    for (let nextIndex = 0; nextIndex < QUEUE.length; nextIndex += 1) {
      if (!isEligible(nextIndex, pathname)) continue;
      if (window.localStorage.getItem(QUEUE[nextIndex].id) === "1") continue;
      setIndex(nextIndex);
      setPhase("idle");
      return;
    }

    setIndex(null);
    setPhase("idle");
  }, [pathname]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      activeItem === null ||
      phase !== "idle"
    )
      return;

    const timeout = window.setTimeout(() => {
      setPhase("showing");
    }, activeItem.delayMs);

    return () => window.clearTimeout(timeout);
  }, [activeItem, phase]);

  const handleClose = () => {
    if (typeof window === "undefined" || activeItem === null) return;

    window.localStorage.setItem(activeItem.id, "1");

    const nextIndex = (() => {
      for (
        let candidate = (index ?? -1) + 1;
        candidate < QUEUE.length;
        candidate += 1
      ) {
        if (!isEligible(candidate, pathname)) continue;
        if (window.localStorage.getItem(QUEUE[candidate].id) === "1") continue;
        return candidate;
      }
      return null;
    })();

    window.setTimeout(() => {
      setIndex(nextIndex);
      setPhase("idle");
    }, activeItem.gateMs);
  };

  if (activeItem === null || phase !== "showing") {
    return null;
  }

  const Component = activeItem.Component;
  return <Component onClose={handleClose} />;
}
