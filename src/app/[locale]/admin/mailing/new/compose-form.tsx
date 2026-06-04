"use client";

import { useState, useTransition } from "react";

import { sendBroadcastAction, sendTestAction } from "./actions";

type Campaign = "collections_drop" | "desktop_launch";

type Props = {
  optedIn: number;
  byLocale: Record<string, number>;
  collectionsReady: boolean;
};

export function ComposeForm({ optedIn, byLocale, collectionsReady }: Props) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audienceLocale, setAudienceLocale] = useState<string>("all");
  const [limit, setLimit] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [campaign, setCampaign] = useState<Campaign>("desktop_launch");
  const requiresCollections = campaign === "collections_drop";
  const blockedByMissingCollections = requiresCollections && !collectionsReady;

  const audienceCount = (() => {
    if (audienceLocale === "all") return optedIn;
    return byLocale[audienceLocale] ?? 0;
  })();

  const targetCount = (() => {
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) return Math.min(n, audienceCount);
    return audienceCount;
  })();

  function handleTest(form: FormData) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await sendTestAction(form);
      if (!res.ok) {
        setError(res.error ?? "unknown");
        return;
      }
      if (!res.result) {
        setError("unknown");
        return;
      }
      const r = res.result;
      setMessage(
        `Test sent. attempted=${r.attempted} sent=${r.sent} failed=${r.failed}`,
      );
    });
  }

  function handleSend(form: FormData) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await sendBroadcastAction(form);
      if (!res.ok) {
        setError(res.error ?? "unknown");
        return;
      }
      if (!res.result) {
        setError("unknown");
        return;
      }
      const r = res.result;
      setMessage(
        `Broadcast complete. attempted=${r.attempted} sent=${r.sent} failed=${r.failed} skipped=${r.skipped}`,
      );
      setConfirm("");
    });
  }

  return (
    <div className="space-y-6">
      {blockedByMissingCollections ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
          No themed collections are seeded yet. Run{" "}
          <code className="font-mono">
            bun scripts/seed-themed-collections.ts
          </code>{" "}
          before sending the collections-drop campaign.
        </div>
      ) : null}

      <div className="rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
        <h2 className="text-base font-semibold">Campaign</h2>
        <p className="mt-1 text-sm text-muted-2">
          Pick which broadcast template to send. Each campaign uses its own
          template + batch key, so the same audience can receive multiple over
          time.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="text-xs text-muted-3">
            <select
              value={campaign}
              onChange={(e) => setCampaign(e.target.value as Campaign)}
              className="mt-1 block h-10 rounded-full border border-border-base bg-transparent px-3 text-sm"
            >
              <option value="desktop_launch">desktop_launch</option>
              <option value="collections_drop">collections_drop</option>
            </select>
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
        <h2 className="text-base font-semibold">Test send</h2>
        <p className="mt-1 text-sm text-muted-2">
          Sends one email to your own admin account so you can validate the
          render before broadcasting.
        </p>
        <form
          action={handleTest}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="campaign" value={campaign} />
          <label className="text-xs text-muted-3">
            Locale
            <select
              name="locale"
              defaultValue="en"
              className="mt-1 block h-10 rounded-full border border-border-base bg-transparent px-3 text-sm"
            >
              <option value="en">en</option>
              <option value="es">es</option>
              <option value="zh">zh</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={pending || blockedByMissingCollections}
            className="inline-flex h-10 items-center rounded-full border border-border-base px-4 text-sm font-medium hover:bg-surface disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send test to me"}
          </button>
        </form>
      </div>

      <div className="rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
        <h2 className="text-base font-semibold">Broadcast</h2>
        <p className="mt-1 text-sm text-muted-2">
          Sends to every opted-in user matching the filters. Type{" "}
          <code className="font-mono">SEND</code> to confirm.
        </p>
        <form action={handleSend} className="mt-4 grid gap-4 md:grid-cols-3">
          <input type="hidden" name="campaign" value={campaign} />
          <label className="text-xs text-muted-3">
            Locale
            <select
              name="locale"
              value={audienceLocale}
              onChange={(e) => setAudienceLocale(e.target.value)}
              className="mt-1 block h-10 w-full rounded-full border border-border-base bg-transparent px-3 text-sm"
            >
              <option value="all">all ({optedIn})</option>
              {Object.entries(byLocale).map(([l, c]) => (
                <option key={l} value={l}>
                  {l} ({c})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-3">
            Limit (optional)
            <input
              type="number"
              name="limit"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="e.g. 10 to dry-run"
              className="mt-1 block h-10 w-full rounded-full border border-border-base bg-transparent px-3 text-sm"
            />
          </label>
          <label className="text-xs text-muted-3">
            Confirm
            <input
              type="text"
              name="confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="type SEND"
              className="mt-1 block h-10 w-full rounded-full border border-border-base bg-transparent px-3 text-sm"
            />
          </label>
          <div className="md:col-span-3 flex items-center justify-between">
            <p className="text-xs text-muted-3">
              Target: <strong>{targetCount}</strong> users
            </p>
            <button
              type="submit"
              disabled={
                pending || blockedByMissingCollections || confirm !== "SEND"
              }
              className="inline-flex h-10 items-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse hover:bg-inverse-hover disabled:opacity-50"
            >
              {pending ? "Sending…" : `Send to ${targetCount}`}
            </button>
          </div>
        </form>
      </div>

      {message ? (
        <p className="rounded-xl border border-border-base bg-surface/76 p-4 text-sm text-muted-1">
          {message}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
