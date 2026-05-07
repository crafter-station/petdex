"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Check, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";

export function AdminEditActions({ id }: { id: string }) {
  const t = useTranslations("admin.editActions");
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [, startTransition] = useTransition();

  async function run(action: "approve" | "reject") {
    let reason: string | null = null;
    if (action === "reject") {
      const v = window.prompt(t("rejectPrompt")) ?? "";
      reason = v.trim() || null;
    }
    setBusy(action);
    try {
      const res = await fetch(`/api/admin/edits/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
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

  const disabled = busy !== null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run("approve")}
        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-600 px-3 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
      >
        {busy === "approve" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        {t("approve")}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run("reject")}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-rose-300 bg-chip-danger-bg px-3 text-xs font-medium text-chip-danger-fg transition hover:border-rose-400 hover:bg-rose-100 disabled:opacity-60 dark:hover:bg-rose-900/40"
      >
        {busy === "reject" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <X className="size-3.5" />
        )}
        {t("reject")}
      </button>
    </div>
  );
}
