"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Bell,
  Check,
  CheckCircle2,
  MessageSquare,
  Pencil,
  Sparkles,
  XCircle,
} from "lucide-react";

import { useHeaderState } from "@/components/header-state-provider";

type Kind =
  | "pet_approved"
  | "pet_rejected"
  | "edit_approved"
  | "edit_rejected"
  | "feedback_replied"
  | "request_fulfilled";

type Notif = {
  id: string;
  kind: Kind;
  payload: Record<string, unknown>;
  href: string;
  readAt: string | null;
  createdAt: string;
};

const KIND_META: Record<
  Kind,
  { icon: React.ReactNode; tone: string; verb: string }
> = {
  pet_approved: {
    icon: <CheckCircle2 className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
    verb: "approved",
  },
  pet_rejected: {
    icon: <XCircle className="size-3.5" />,
    tone: "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20",
    verb: "needs changes",
  },
  edit_approved: {
    icon: <Pencil className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
    verb: "edit approved",
  },
  edit_rejected: {
    icon: <Pencil className="size-3.5" />,
    tone: "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20",
    verb: "edit needs changes",
  },
  feedback_replied: {
    icon: <MessageSquare className="size-3.5" />,
    tone: "bg-brand-tint text-brand-deep ring-brand/20",
    verb: "replied",
  },
  request_fulfilled: {
    icon: <Sparkles className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
    verb: "your request shipped",
  },
};

function describe(n: Notif): { title: string; sub?: string } {
  const p = n.payload as Record<string, string | undefined>;
  switch (n.kind) {
    case "pet_approved":
      return { title: `${p.petName ?? "Your pet"} is live` };
    case "pet_rejected":
      return {
        title: `${p.petName ?? "Your submission"} needs changes`,
        sub: p.reason,
      };
    case "edit_approved":
      return { title: `Edit to ${p.petName ?? "your pet"} is live` };
    case "edit_rejected":
      return {
        title: `Edit to ${p.petName ?? "your pet"} was rejected`,
        sub: p.reason,
      };
    case "feedback_replied":
      return {
        title: "Hunter replied to your feedback",
        sub: p.excerpt,
      };
    case "request_fulfilled":
      return {
        title: `Your request "${p.requestQuery ?? "..."}" was fulfilled`,
        sub: p.petName ? `Now live as ${p.petName}` : undefined,
      };
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function NotificationsBell({ compact = false }: { compact?: boolean }) {
  const { state, refresh } = useHeaderState();
  const unread = state.notifications.unreadCount;
  const [items, setItems] = useState<Notif[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const setUnread = useCallback(
    (_next: number | ((n: number) => number)) => {
      void refresh();
    },
    [refresh],
  );

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { items?: Notif[] };
      setItems(j.items ?? []);
      setItemsLoaded(true);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    if (open && !itemsLoaded) void loadItems();
  }, [open, itemsLoaded, loadItems]);

  // Click outside / Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  async function markAll() {
    setUnread(0);
    setItems((prev) =>
      prev.map((n) =>
        n.readAt ? n : { ...n, readAt: new Date().toISOString() },
      ),
    );
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* silent — next poll will reconcile */
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
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch {
      /* silent */
    }
  }

  return (
    <div ref={popoverRef} className="relative">
      <button
        type="button"
        aria-label={
          unread > 0 ? `${unread} unread notifications` : "Notifications"
        }
        onClick={() => setOpen((v) => !v)}
        className={`relative grid place-items-center rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition-[width,height] duration-200 hover:bg-white dark:hover:bg-stone-800 ${compact ? "size-9" : "size-11"}`}
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-white ring-2 ring-white"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-[60] mt-2 flex max-h-[min(70vh,520px)] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border-base bg-surface shadow-xl shadow-blue-950/15">
          <div className="flex shrink-0 items-center justify-between border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.06]">
            <span className="text-sm font-semibold text-foreground">
              Notifications
            </span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAll()}
                className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] text-brand uppercase hover:underline"
              >
                <Check className="size-3" />
                Mark all read
              </button>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-3">
              You're all caught up.
            </div>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-black/[0.06] overflow-y-auto dark:divide-white/[0.06]">
              {items.map((n) => {
                const meta = KIND_META[n.kind];
                const { title, sub } = describe(n);
                const isUnread = !n.readAt;
                return (
                  <li key={n.id}>
                    <Link
                      href={n.href}
                      onClick={() => {
                        if (isUnread) void markOne(n.id);
                        setOpen(false);
                      }}
                      className={`flex items-start gap-3 px-4 py-3 transition hover:bg-stone-50 dark:hover:bg-stone-800/60 ${
                        isUnread
                          ? "bg-brand-tint/40 dark:bg-brand-tint-dark/40"
                          : ""
                      }`}
                    >
                      <span
                        className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ring-1 ${meta.tone}`}
                      >
                        {meta.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <p
                            className={`truncate text-sm ${
                              isUnread
                                ? "font-medium text-foreground"
                                : "text-muted-2"
                            }`}
                          >
                            {title}
                          </p>
                          {isUnread ? (
                            <span className="size-1.5 shrink-0 rounded-full bg-brand" />
                          ) : null}
                          <span className="ml-auto shrink-0 font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
                            {relativeTime(n.createdAt)}
                          </span>
                        </div>
                        {sub ? (
                          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-3">
                            {sub}
                          </p>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
