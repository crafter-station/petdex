"use client";

import Link from "next/link";

import {
  Check,
  CheckCircle2,
  MessageSquare,
  Pencil,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";

export type NotificationKind =
  | "pet_approved"
  | "pet_rejected"
  | "edit_approved"
  | "edit_rejected"
  | "feedback_replied"
  | "request_fulfilled";

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  href: string;
  readAt: string | null;
  createdAt: string;
};

const KIND_META: Record<
  NotificationKind,
  { icon: React.ReactNode; tone: string }
> = {
  pet_approved: {
    icon: <CheckCircle2 className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
  },
  pet_rejected: {
    icon: <XCircle className="size-3.5" />,
    tone: "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20",
  },
  edit_approved: {
    icon: <Pencil className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
  },
  edit_rejected: {
    icon: <Pencil className="size-3.5" />,
    tone: "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20",
  },
  feedback_replied: {
    icon: <MessageSquare className="size-3.5" />,
    tone: "bg-brand-tint text-brand-deep ring-brand/20",
  },
  request_fulfilled: {
    icon: <Sparkles className="size-3.5" />,
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
  },
};

type Props = {
  items: NotificationItem[];
  onClose: () => void;
  onMarkAll: () => void;
  onMarkOne: (id: string) => void;
  unread: number;
};

export function NotificationsPanel({
  items,
  onClose,
  onMarkAll,
  onMarkOne,
  unread,
}: Props) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.06]">
        <span className="text-sm font-semibold text-foreground">
          Notifications
        </span>
        {unread > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMarkAll}
            className="inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] text-brand uppercase hover:underline"
          >
            <Check className="size-3" />
            Mark all read
          </Button>
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
                    if (isUnread) onMarkOne(n.id);
                    onClose();
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
    </>
  );
}

function describe(n: NotificationItem): { title: string; sub?: string } {
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
      if (p.role === "creator") {
        return {
          title: `${p.petName ?? "Your pet"} fulfilled "${p.requestQuery ?? "a request"}"`,
          sub: "The community asked, you delivered.",
        };
      }
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
