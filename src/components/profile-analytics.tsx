"use client";

import { track } from "@vercel/analytics";
import { useEffect } from "react";

// Fires a single profile_viewed event when a /u/[handle] page is opened.
// Self-views (where viewerIsOwner === true) are tagged so they can be
// excluded from creator-facing leaderboards.
export function ProfileAnalytics({
  handle,
  petCount,
  pinnedCount,
  viewerIsOwner,
}: {
  handle: string;
  petCount: number;
  pinnedCount: number;
  viewerIsOwner: boolean;
}) {
  useEffect(() => {
    track("profile_viewed", {
      handle,
      pet_count: petCount,
      pinned_count: pinnedCount,
      self_view: viewerIsOwner,
    });
  }, [handle, petCount, pinnedCount, viewerIsOwner]);

  return null;
}
