"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";

import { useHeaderState } from "@/components/layout/header-state-provider";
import type { NotificationItem } from "@/components/notifications/notifications-panel";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const NotificationsPanel = dynamic(
  () =>
    import("@/components/notifications/notifications-panel").then(
      (mod) => mod.NotificationsPanel,
    ),
  { loading: () => null, ssr: false },
);

export function NotificationsBell({ compact = false }: { compact?: boolean }) {
  const { state, refresh, setUnreadCount } = useHeaderState();
  const t = useTranslations("notifications");
  const unread = state.notifications.unreadCount;
  const [items, setItems] = useState<NotificationItem[]>([]);
  // A failed fetch leaves `items` empty, which the panel renders as "all
  // caught up" — the user is told there is nothing to see when the request
  // actually errored. Track it so the panel can say so instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const setUnread = useCallback(
    (next: number | ((n: number) => number)) => {
      setUnreadCount(next);
    },
    [setUnreadCount],
  );

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const j = (await res.json()) as { items?: NotificationItem[] };
      setItems(j.items ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  // Re-read on every open. The old one-shot gate (`!itemsLoaded`) fetched the
  // list at most once per page session: a notification arriving after the
  // first open bumped the polled badge but never appeared as a row, so the
  // panel showed an unread count with nothing unread in it.
  useEffect(() => {
    if (open) void loadItems();
  }, [open, loadItems]);

  // Both writers below are optimistic, and `fetch` only rejects on a network
  // failure — a 401/403/500 resolves normally. Without the `res.ok` check the
  // panel kept the optimistic "read" forever, because nothing re-read the
  // list on its own. Rolling back on failure and refetching the badge keeps
  // the panel and the count from disagreeing.
  // The list is replaced (not merged) by loadItems on every open. A rollback
  // written before a PATCH may resolve *after* that replace finished — the
  // popover can be closed and reopened while the request is in flight — and
  // restoring the snapshot wholesale would clobber the rows the reload just
  // brought in. Roll back only what this call changed: marks it did make are
  // undone, rows it never touched are left as the reload left them.
  async function markAll() {
    const changedIds = items.filter((n) => !n.readAt).map((n) => n.id);
    setUnread(0);
    setItems((prev) =>
      prev.map((n) =>
        n.readAt ? n : { ...n, readAt: new Date().toISOString() },
      ),
    );
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    } catch {
      setItems((prev) =>
        prev.map((n) =>
          changedIds.includes(n.id) ? { ...n, readAt: null } : n,
        ),
      );
      setUnread(changedIds.length);
    } finally {
      void refresh({ force: true });
    }
  }

  async function markOne(id: string) {
    setItems((prev) =>
      prev.map((n) =>
        n.id === id && !n.readAt
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    } catch {
      // Un-mark only if this row is still marked — if a loadItems replace
      // landed while the request was out, that copy is not ours to restore.
      setItems((prev) =>
        prev.map((n) => (n.id === id && n.readAt ? { ...n, readAt: null } : n)),
      );
      setUnread((n) => n + 1);
    } finally {
      void refresh({ force: true });
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              unread > 0
                ? t("bellAriaUnread", { count: unread })
                : t("bellAria")
            }
            className={`relative rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition-[width,height] duration-200 hover:bg-surface-muted ${compact ? "size-9" : "size-11"}`}
          >
            <Bell className="size-4" />
            {unread > 0 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-on-inverse ring-2 ring-background"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </Button>
        }
      />

      <PopoverContent
        align="end"
        sideOffset={8}
        className="flex max-h-[min(70vh,520px)] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border-base bg-surface p-0 shadow-xl shadow-blue-950/15"
      >
        <NotificationsPanel
          items={items}
          onClose={() => setOpen(false)}
          onMarkAll={() => void markAll()}
          onMarkOne={(id) => void markOne(id)}
          unread={unread}
          loadFailed={loadFailed}
        />
      </PopoverContent>
    </Popover>
  );
}
