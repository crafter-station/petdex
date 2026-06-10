"use client";

import { useEffect } from "react";

import { useAuth } from "@clerk/nextjs";

import type { RequestRow } from "@/components/requests-view";

export function RequestsAuthRefresh({
  onRefresh,
}: {
  onRefresh: (requests: RequestRow[]) => void;
}) {
  const { isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/pet-requests?status=all&limit=80");
        if (!res.ok) return;
        const data = (await res.json()) as { requests: RequestRow[] };
        if (!cancelled) onRefresh(data.requests);
      } catch {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, onRefresh]);

  return null;
}
