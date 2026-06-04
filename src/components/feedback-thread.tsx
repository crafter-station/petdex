"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Bell, BellOff, Loader2, Send } from "lucide-react";

import { useHeaderState } from "@/components/header-state-provider";

type Reply = {
  id: string;
  authorKind: "admin" | "user";
  body: string;
  createdAt: string;
};

type Feedback = {
  id: string;
  kind: string;
  status: string;
  message: string;
  createdAt: string;
  notifyEmail: boolean;
};

const KIND_LABEL: Record<string, string> = {
  suggestion: "Suggestion",
  bug: "Bug",
  praise: "Praise",
  other: "Other",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-chip-warning-bg text-chip-warning-fg ring-chip-warning-fg/20",
  addressed: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
  archived:
    "bg-surface-muted text-stone-600 ring-stone-200 dark:text-stone-300 dark:ring-stone-700",
};

export function FeedbackThread({
  feedback,
  initialReplies,
  viewerKind,
}: {
  feedback: Feedback;
  initialReplies: Reply[];
  viewerKind: "admin" | "user";
}) {
  const [replies, setReplies] = useState<Reply[]>(initialReplies);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(feedback.notifyEmail);
  const [, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement | null>(null);
  const { refresh } = useHeaderState();
  const feedbackId = feedback.id;

  useEffect(() => {
    if (replies.length === 0) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [replies.length]);

  useEffect(() => {
    if (!feedbackId) return;
    void refresh({ force: true });
  }, [feedbackId, refresh]);

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/feedback/${feedbackId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        alert(`Failed: ${j?.error ?? res.statusText}`);
        return;
      }
      const data = (await res.json()) as { reply: Reply };
      setReplies((prev) => [...prev, data.reply]);
      setDraft("");
      void refresh({ force: true });
    } finally {
      setBusy(false);
    }
  }

  async function toggleNotify() {
    if (viewerKind !== "user") return;
    const next = !notify;
    setNotify(next);
    try {
      const res = await fetch(`/api/feedback/${feedbackId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notifyEmail: next }),
      });
      if (!res.ok) {
        setNotify(!next);
      }
    } catch {
      setNotify(!next);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div className="rounded-2xl border border-border-base bg-surface/80 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase">
            {KIND_LABEL[feedback.kind] ?? "Feedback"}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ring-1 ${
              STATUS_TONE[feedback.status] ?? STATUS_TONE.pending
            }`}
          >
            {feedback.status}
          </span>
          <span className="ml-auto font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
            {new Date(feedback.createdAt).toLocaleString()}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 whitespace-pre-wrap text-foreground">
          {feedback.message}
        </p>
        {viewerKind === "user" ? (
          <button
            type="button"
            onClick={() => void toggleNotify()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface px-2.5 py-1 text-[11px] text-muted-2 transition hover:border-border-strong"
          >
            {notify ? (
              <Bell className="size-3.5" />
            ) : (
              <BellOff className="size-3.5" />
            )}
            {notify ? "Email me on reply" : "Email muted"}
          </button>
        ) : null}
      </div>

      {/* Replies */}
      <ol className="space-y-2">
        {replies.length === 0 ? (
          <li className="rounded-2xl border border-dashed border-border-base bg-surface/60 p-6 text-center text-xs text-muted-3">
            No replies yet. Send a follow-up below to keep the thread going.
          </li>
        ) : (
          replies.map((r) => {
            const fromAdmin = r.authorKind === "admin";
            return (
              <li
                key={r.id}
                className={`flex ${fromAdmin ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 ring-1 ${
                    fromAdmin
                      ? "bg-surface-elev text-foreground ring-border-base"
                      : "bg-brand text-white ring-brand/30"
                  }`}
                >
                  <div
                    className={`mb-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] uppercase ${
                      fromAdmin ? "text-muted-3" : "text-white/70"
                    }`}
                  >
                    <span>{fromAdmin ? "Hunter" : "You"}</span>
                    <span>·</span>
                    <span>{new Date(r.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="whitespace-pre-wrap">{r.body}</p>
                </div>
              </li>
            );
          })
        )}
        <div ref={endRef} />
      </ol>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(() => {
            void send();
          });
        }}
        className="rounded-2xl border border-border-base bg-surface/80 p-3 backdrop-blur"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          maxLength={2000}
          placeholder={
            viewerKind === "admin"
              ? "Reply to the user… (⌘+Enter to send)"
              : "Add a follow-up… (⌘+Enter to send)"
          }
          className="w-full resize-none bg-transparent text-sm leading-6 text-stone-900 placeholder:text-muted-4 focus:outline-none dark:text-stone-100"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
            {draft.length}/2000
          </span>
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-stone-800 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
