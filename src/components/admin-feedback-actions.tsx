"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Archive, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

type Status = "pending" | "addressed" | "archived";

export function AdminFeedbackActions({
  id,
  status,
}: {
  id: string;
  status: Status;
}) {
  const t = useTranslations("admin.feedbackActions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "address" | "archive" | "reopen">(
    null,
  );

  async function run(action: "address" | "archive" | "reopen") {
    setBusy(action);
    try {
      const res = await fetch(`/api/admin/feedback/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        alert(t("failed", { error: j?.error ?? res.statusText }));
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const disabled = pending || busy !== null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {status !== "addressed" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void run("address")}
          aria-label={t("address")}
          title={t("address")}
          className="inline-flex size-8 items-center justify-center rounded-full border border-emerald-200 bg-chip-success-bg text-chip-success-fg transition hover:border-emerald-300 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-800/60 dark:hover:border-emerald-700 dark:hover:bg-emerald-900/40"
        >
          {busy === "address" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
        </button>
      ) : null}

      {status !== "archived" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void run("archive")}
          aria-label={t("archive")}
          title={t("archive")}
          className="inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 transition hover:border-border-strong hover:text-stone-900 disabled:opacity-60 dark:hover:text-stone-100"
        >
          {busy === "archive" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </button>
      ) : null}

      {status !== "pending" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void run("reopen")}
          aria-label={t("reopen")}
          title={t("reopen")}
          className="inline-flex size-8 items-center justify-center rounded-full border border-amber-200 bg-chip-warning-bg text-chip-warning-fg transition hover:border-amber-300 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-800/60 dark:hover:border-amber-700 dark:hover:bg-amber-900/40"
        >
          {busy === "reopen" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
        </button>
      ) : null}
    </div>
  );
}
