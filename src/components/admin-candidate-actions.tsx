"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Check, Loader2, X } from "lucide-react";

type Action = "approve" | "reject";

export function AdminCandidateActions({
  petId,
  requestId,
}: {
  petId: string;
  requestId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action) {
    setError(null);
    setBusy(action);
    try {
      const res = await fetch("/api/admin/request-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, petId, requestId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(j?.error ?? `Request failed (${res.status})`);
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2 self-center">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => run("reject")}
          disabled={busy !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-chip-danger-fg/20 bg-chip-danger-bg px-3 text-xs font-medium text-chip-danger-fg transition hover:bg-chip-danger-bg/70 disabled:opacity-50"
        >
          {busy === "reject" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <X className="size-3" />
          )}
          Reject
        </button>
        <button
          type="button"
          onClick={() => run("approve")}
          disabled={busy !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
        >
          {busy === "approve" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          Approve
        </button>
      </div>
      {error ? (
        <p className="font-mono text-[10px] text-chip-danger-fg">{error}</p>
      ) : null}
    </div>
  );
}
