"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  AlertTriangle,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  Pencil,
  Slash,
  Trash2,
  User,
  X,
} from "lucide-react";

import type { SubmittedPet } from "@/lib/db/schema";
import { petStates } from "@/lib/pet-states";

import { AdminFeatureToggle } from "@/components/admin-feature-toggle";

type AdminReviewRowProps = {
  pet: SubmittedPet;
  stateCount: number;
  /** Pre-resolved profile handle for the submitter (Clerk username, fallback to userId tail). */
  ownerHandle?: string;
};

// Lima time, en-US so the format stays predictable. The admin only
// works from Peru — having a single non-locale clock means we don't
// have to read the user's browser locale and risk getting MM/DD/YYYY
// vs DD/MM/YYYY ambiguity.
const PET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Lima",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatPetTime(d: Date): string {
  return PET_FORMATTER.format(d);
}

// Compact relative time without pulling in a date library. Mirrors the
// pattern used in feedback threads but keeps it inline since this is the
// only callsite for the admin row.
function relativeTime(d: Date, now: number): string {
  const diff = Math.max(0, now - d.getTime());
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.round(month / 12)}y ago`;
}

export function AdminReviewRow({
  pet,
  stateCount,
  ownerHandle,
}: AdminReviewRowProps) {
  const [status, setStatus] = useState(pet.status);
  const [displayName, setDisplayName] = useState(pet.displayName);
  const [description, setDescription] = useState(pet.description);
  const [slug, setSlug] = useState(pet.slug);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick once a minute so "5m ago" doesn't go stale while the admin
  // sits on the queue page. Resets on row mount; cheap.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const isUntitled = pet.displayName === "Untitled pet";
  const createdAtDate = new Date(pet.createdAt);
  // stateCount is intentionally read here (linter would otherwise flag
  // the unused param) — the count never varies per row but the prop
  // stays for API stability with admin/page.tsx callers.
  void stateCount;

  async function decide(action: "approve" | "reject" | "revive") {
    if (busy) return;
    setBusy(true);
    setError(null);

    let reason: string | null = null;
    if (action === "reject") {
      reason = window.prompt("Reason for rejection (optional)") ?? "";
    }

    // 'revive' is admin-only — flip a previously rejected row back to
    // pending so it shows up in the queue again. Server side this is
    // expressed as action: 'edit' with status patched explicitly via
    // the dedicated 'pending' action keyword.
    const apiAction = action === "revive" ? "pending" : action;

    const res = await fetch(`/api/admin/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: apiAction,
        reason,
        displayName,
        description,
        slug,
      }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      setError(data.message ?? data.error ?? `Request failed (${res.status})`);
      setBusy(false);
      return;
    }

    setStatus(
      action === "approve"
        ? "approved"
        : action === "revive"
          ? "pending"
          : "rejected",
    );
    setBusy(false);
  }

  async function takedown() {
    if (busy) return;

    // Double confirmation: typing the slug avoids muscle-memory clicks
    // wiping a popular pet. The reason ends up in the audit log + email.
    const typed = window.prompt(
      `Type the slug "${pet.slug}" to confirm takedown.\nThis deletes the row and every R2 asset. Slug becomes free again.`,
    );
    if (typed?.trim() !== pet.slug) {
      if (typed !== null) {
        window.alert("Slug did not match. Takedown cancelled.");
      }
      return;
    }
    const reason =
      window.prompt("Reason (sent to owner email, optional)") ?? "";

    setBusy(true);
    setError(null);

    const res = await fetch(`/api/admin/${pet.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      setError(data.message ?? data.error ?? `Request failed (${res.status})`);
      setBusy(false);
      return;
    }

    // Refresh so the row disappears from the queue.
    setBusy(false);
    window.location.reload();
  }

  async function saveEdit() {
    if (busy) return;
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/admin/${pet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit",
        displayName,
        description,
        slug,
      }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      setError(data.message ?? data.error ?? `Request failed (${res.status})`);
      setBusy(false);
      return;
    }

    setEditing(false);
    setBusy(false);
  }

  function cancelEdit() {
    setDisplayName(pet.displayName);
    setDescription(pet.description);
    setSlug(pet.slug);
    setEditing(false);
    setError(null);
  }

  return (
    <article
      className={`grid gap-4 rounded-2xl border bg-surface/80 p-4 backdrop-blur md:grid-cols-[160px_1fr_auto] md:items-start ${
        isUntitled
          ? "border-chip-warning-fg/30 bg-chip-warning-bg/30"
          : "border-border-base"
      }`}
    >
      <SpritePreview src={pet.spritesheetUrl} />

      <div className="space-y-2">
        {editing ? (
          <div className="space-y-2">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Pet display name"
              maxLength={60}
              className="w-full rounded-lg border border-border-base bg-surface px-3 py-1.5 text-base font-semibold text-foreground outline-none focus:border-border-strong"
            />
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="slug (url-safe)"
              maxLength={40}
              className="w-full rounded-lg border border-border-base bg-surface px-3 py-1.5 font-mono text-xs text-muted-2 outline-none focus:border-border-strong"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
              rows={2}
              maxLength={280}
              className="w-full rounded-lg border border-border-base bg-surface px-3 py-1.5 text-sm text-muted-2 outline-none focus:border-border-strong"
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-lg font-semibold text-foreground">
                {displayName}
                {isUntitled ? (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 align-middle font-mono text-[10px] tracking-[0.15em] text-chip-warning-fg uppercase">
                    Needs name
                  </span>
                ) : null}
              </h3>
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                /{slug}
              </span>
              <StatusBadge status={status} />
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Edit pet"
                className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-2 uppercase transition hover:border-border-strong hover:text-foreground"
              >
                <Pencil className="size-3" />
                Edit
              </button>
            </div>
            <p className="line-clamp-2 text-sm text-muted-2">{description}</p>
          </>
        )}
        <div className="flex flex-wrap gap-3 font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase">
          {pet.ownerEmail ? (
            <span className="inline-flex items-center gap-1">
              <Mail className="size-3" />
              {pet.ownerEmail}
            </span>
          ) : null}
          {ownerHandle ? (
            <Link
              href={`/u/${ownerHandle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline-offset-4 transition hover:text-foreground hover:underline"
            >
              <User className="size-3" />
              /u/{ownerHandle}
            </Link>
          ) : null}
          <span
            className="inline-flex items-center gap-1"
            title={formatPetTime(createdAtDate) + " (PET)"}
          >
            <Clock className="size-3" />
            {relativeTime(createdAtDate, now)}
            <span className="text-muted-4">
              · {formatPetTime(createdAtDate)} PET
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <a
            href={pet.zipUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-2 underline underline-offset-4 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            zip
          </a>
          <a
            href={pet.spritesheetUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-2 underline underline-offset-4 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            sprite
          </a>
          <a
            href={pet.petJsonUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-2 underline underline-offset-4 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            pet.json
          </a>
        </div>
        {error ? (
          <p className="rounded-md bg-chip-danger-bg px-2 py-1 text-xs text-chip-danger-fg">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 md:flex-col md:items-stretch">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void saveEdit()}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface px-4 text-xs font-medium text-muted-2 transition hover:border-border-strong disabled:opacity-60"
            >
              <X className="size-3.5" />
              Cancel
            </button>
          </>
        ) : status === "pending" ? (
          <>
            <button
              type="button"
              onClick={() => void decide("approve")}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-4 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Approve
            </button>
            <button
              type="button"
              onClick={() => void decide("reject")}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface px-4 text-xs font-medium text-muted-2 transition hover:border-chip-danger-fg/40 hover:text-chip-danger-fg disabled:opacity-60"
            >
              <X className="size-3.5" />
              Reject
            </button>
          </>
        ) : status === "rejected" ? (
          <>
            <button
              type="button"
              onClick={() => void decide("revive")}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-chip-warning-fg/30 bg-chip-warning-bg px-4 text-xs font-medium text-chip-warning-fg transition hover:border-chip-warning-fg/50 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Clock className="size-3.5" />
              )}
              Revive to pending
            </button>
            <button
              type="button"
              onClick={() => void takedown()}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-chip-danger-fg/30 bg-chip-danger-bg px-4 text-xs font-medium text-chip-danger-fg transition hover:border-chip-danger-fg/50 disabled:opacity-60"
            >
              <Trash2 className="size-3.5" />
              Take down
            </button>
          </>
        ) : status === "approved" ? (
          <>
            <AdminFeatureToggle
              petId={pet.id}
              initialFeatured={pet.featured}
              petName={pet.displayName}
              variant="solid"
            />
            <button
              type="button"
              onClick={() => void takedown()}
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-chip-danger-fg/30 bg-chip-danger-bg px-4 text-xs font-medium text-chip-danger-fg transition hover:border-chip-danger-fg/50 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Take down
            </button>
          </>
        ) : null}
      </div>
      <SimilarPanel petId={pet.id} status={status} />
    </article>
  );
}

function StatusBadge({ status }: { status: SubmittedPet["status"] }) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-chip-warning-fg uppercase">
        <Clock className="size-3" />
        Pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-chip-success-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-chip-success-fg uppercase">
        <Check className="size-3" />
        Approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-chip-danger-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-chip-danger-fg uppercase">
      <Slash className="size-3" />
      Rejected
    </span>
  );
}

function SpritePreview({ src }: { src: string }) {
  const [index, setIndex] = useState(0);
  const animation = petStates[index];

  useEffect(() => {
    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % petStates.length);
    }, 1500);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="w-fit rounded-2xl border border-border-base bg-background p-3">
      <div
        className="pet-sprite-frame"
        role="img"
        aria-label="pet animation"
        style={{ "--pet-scale": 0.42 } as React.CSSProperties}
      >
        <div
          className="pet-sprite"
          style={
            {
              "--sprite-url": `url(${src})`,
              "--sprite-row": animation.row,
              "--sprite-frames": animation.frames,
              "--sprite-duration": `${animation.durationMs}ms`,
            } as React.CSSProperties
          }
        />
      </div>
    </div>
  );
}

// SimilarPanel — calls /api/admin/similar/<id> on mount and renders a
// strip of similar pets so the admin can spot dupes (visual or
// semantic) before approving. Collapsed by default; auto-expands when
// at least one match is "very similar" (visual distance <= 6).
type SimilarMatch = {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  featured: boolean;
  spritesheetUrl: string;
  visualDistance: number | null;
  semanticScore: number | null;
};

function SimilarPanel({ petId, status }: { petId: string; status: string }) {
  const [matches, setMatches] = useState<SimilarMatch[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/similar/${petId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { matches: SimilarMatch[] };
        if (cancelled) return;
        setMatches(data.matches);
        // Auto-expand when there's a near-identical visual hit.
        const strong = data.matches.find(
          (m) => m.visualDistance != null && m.visualDistance <= 6,
        );
        if (strong) setOpen(true);
      } catch {
        /* ignore — admin still sees the rest of the row */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [petId]);

  if (!matches || matches.length === 0) return null;

  // Status filter: rejected pets aren't worth highlighting at admin time.
  if (status === "rejected") return null;

  const strongest = matches[0];
  const tone = (() => {
    if (strongest.visualDistance != null && strongest.visualDistance <= 6) {
      return {
        bg: "bg-chip-danger-bg",
        border: "border-chip-danger-fg/20",
        text: "text-chip-danger-fg",
        label: "Possible duplicate",
      };
    }
    if (strongest.visualDistance != null && strongest.visualDistance <= 14) {
      return {
        bg: "bg-chip-warning-bg",
        border: "border-chip-warning-fg/20",
        text: "text-chip-warning-fg",
        label: "Looks similar",
      };
    }
    return {
      bg: "bg-chip-info-bg",
      border: "border-chip-info-fg/20",
      text: "text-chip-info-fg",
      label: "Same character?",
    };
  })();

  return (
    <div
      className={`md:col-span-3 mt-2 rounded-xl border ${tone.bg} ${tone.border} px-3 py-2`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 text-left ${tone.text}`}
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.18em] uppercase">
          <AlertTriangle className="size-3.5" />
          {tone.label} ({matches.length})
        </span>
        <span className="text-[10px] opacity-70">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {matches.map((m) => (
            <Link
              key={m.id}
              href={`/pets/${m.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col gap-1 rounded-lg border border-border-base bg-surface p-2 transition hover:border-border-strong"
            >
              <div className="aspect-square overflow-hidden rounded-md bg-surface-muted">
                {/* biome-ignore lint/performance/noImgElement: admin-only sprite preview */}
                <img
                  src={m.spritesheetUrl}
                  alt={m.displayName}
                  className="size-full object-cover"
                  style={{ imageRendering: "pixelated" }}
                />
              </div>
              <div className="flex items-center gap-1 truncate text-[11px] font-medium text-foreground">
                {m.featured ? "★ " : ""}
                {m.displayName}
              </div>
              <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-tight text-muted-3">
                <span
                  className={
                    m.status === "approved"
                      ? "text-chip-success-fg"
                      : "text-chip-warning-fg"
                  }
                >
                  {m.status}
                </span>
                {m.visualDistance != null ? (
                  <span title="dHash hamming distance">
                    · v:{m.visualDistance}
                  </span>
                ) : null}
                {m.semanticScore != null ? (
                  <span title="cosine similarity">
                    · s:{m.semanticScore.toFixed(2)}
                  </span>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
