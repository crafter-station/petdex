"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Loader2, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { PET_ASSET_MAX_BYTES } from "@/lib/upload-limits";

type Pending = {
  displayName: string | null;
  description: string | null;
  tags: string[] | null;
  submittedAt: string | null;
};

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!TAG_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 8) break;
  }
  return out;
}

function readImageDims(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("load_failed"));
    };
    img.src = url;
  });
}

const MAX_SPRITE_BYTES = PET_ASSET_MAX_BYTES;
const MAX_SPRITE_DIM = 4096;

export function OwnerEditPanel({
  petId,
  currentDisplayName,
  currentDescription,
  currentTags,
  initialPending,
  initialRejection,
}: {
  petId: string;
  slug: string;
  currentDisplayName: string;
  currentDescription: string;
  currentTags: string[];
  initialPending: Pending | null;
  initialRejection: string | null;
}) {
  const t = useTranslations("myPets.edit");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(initialPending);
  const [rejection, setRejection] = useState<string | null>(initialRejection);
  const [busy, setBusy] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<
    "auto_approved" | "queued" | null
  >(null);
  const [, startTransition] = useTransition();

  const [displayName, setDisplayName] = useState(
    pending?.displayName ?? currentDisplayName,
  );
  const [description, setDescription] = useState(
    pending?.description ?? currentDescription,
  );
  const [tagsInput, setTagsInput] = useState(
    (pending?.tags ?? currentTags).join(", "),
  );
  const [error, setError] = useState<string | null>(null);

  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const [spritePreviewUrl, setSpritePreviewUrl] = useState<string | null>(null);
  const [spriteError, setSpriteError] = useState<string | null>(null);

  const [metaFile, setMetaFile] = useState<File | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const spriteInputRef = useRef<HTMLInputElement>(null);
  const metaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setDisplayName(pending?.displayName ?? currentDisplayName);
      setDescription(pending?.description ?? currentDescription);
      setTagsInput((pending?.tags ?? currentTags).join(", "));
      setError(null);
      setSpriteFile(null);
      setSpriteError(null);
      setMetaFile(null);
      setMetaError(null);
      setSubmitStatus(null);
      if (spritePreviewUrl) {
        URL.revokeObjectURL(spritePreviewUrl);
        setSpritePreviewUrl(null);
      }
    }
  }, [
    open,
    pending,
    currentDisplayName,
    currentDescription,
    currentTags,
    spritePreviewUrl,
  ]);

  useEffect(() => {
    return () => {
      if (spritePreviewUrl) URL.revokeObjectURL(spritePreviewUrl);
    };
  }, [spritePreviewUrl]);

  async function handleSpriteChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSpriteFile(null);
    setSpriteError(null);
    if (spritePreviewUrl) {
      URL.revokeObjectURL(spritePreviewUrl);
      setSpritePreviewUrl(null);
    }
    if (!file) return;

    if (file.size > MAX_SPRITE_BYTES) {
      setSpriteError(t("fileTooBig"));
      return;
    }

    let dims: { width: number; height: number };
    try {
      dims = await readImageDims(file);
    } catch {
      setSpriteError(t("invalidImage"));
      return;
    }

    if (dims.width > MAX_SPRITE_DIM || dims.height > MAX_SPRITE_DIM) {
      setSpriteError(t("invalidImage"));
      return;
    }

    setSpriteFile(file);
    setSpritePreviewUrl(URL.createObjectURL(file));
  }

  function handleMetaChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setMetaFile(null);
    setMetaError(null);
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error("not_object");
        }
        setMetaFile(file);
      } catch {
        setMetaError(t("invalidJson"));
      }
    };
    reader.onerror = () => setMetaError(t("invalidJson"));
    reader.readAsText(file);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setSubmitStatus(null);
    try {
      const extraBody: Record<string, unknown> = {};

      if (spriteFile || metaFile) {
        const spritesheetExt =
          spriteFile?.type === "image/png" ? "png" : "webp";
        const presignRes = await fetch(`/api/my-pets/${petId}/edit-presign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hasSprite: Boolean(spriteFile),
            hasMeta: Boolean(metaFile),
            spritesheetExt,
          }),
        });
        if (!presignRes.ok) {
          const data = (await presignRes.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          throw new Error(
            typeof data.message === "string"
              ? data.message
              : typeof data.error === "string"
                ? data.error
                : "Presign failed",
          );
        }
        const { files } = (await presignRes.json()) as {
          files: Array<{ role: string; uploadUrl: string; publicUrl: string }>;
        };
        const slot = (role: string) => files.find((f) => f.role === role);

        if (spriteFile) {
          const ss = slot("sprite");
          if (!ss) throw new Error("Missing sprite slot in presign response");
          const putRes = await fetch(ss.uploadUrl, {
            method: "PUT",
            headers: { "content-type": spriteFile.type },
            body: spriteFile,
          });
          if (!putRes.ok) throw new Error("Spritesheet upload failed");
          const { width, height } = await readImageDims(spriteFile);
          extraBody.spritesheetUrl = ss.publicUrl;
          extraBody.spritesheetWidth = width;
          extraBody.spritesheetHeight = height;
        }

        if (metaFile) {
          const ms = slot("petjson");
          if (!ms) throw new Error("Missing petjson slot in presign response");
          const putRes = await fetch(ms.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: metaFile,
          });
          if (!putRes.ok) throw new Error("Metadata upload failed");
          extraBody.petJsonUrl = ms.publicUrl;
        }
      }

      const tags = parseTags(tagsInput);
      const res = await fetch(`/api/my-pets/${petId}/edit`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          description: description.trim(),
          tags,
          ...extraBody,
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        error?: string;
        status?: string;
        pending?: Pending;
      } | null;
      if (!res.ok) {
        setError(j?.error ?? res.statusText);
        return;
      }

      const status = j?.status === "auto_approved" ? "auto_approved" : "queued";
      setSubmitStatus(status);
      if (status === "auto_approved") {
        setPending(null);
      } else {
        setPending(j?.pending ?? null);
      }
      setRejection(null);
      setSpriteFile(null);
      setMetaFile(null);
      if (spritePreviewUrl) {
        URL.revokeObjectURL(spritePreviewUrl);
        setSpritePreviewUrl(null);
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!confirm(t("confirmWithdraw"))) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/my-pets/${petId}/edit`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setPending(null);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const hasPending = pending?.submittedAt;

  return (
    <>
      {hasPending ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-chip-warning-bg px-3 py-2 text-xs text-chip-warning-fg dark:border-amber-800/60">
          <span className="font-mono text-[10px] tracking-[0.12em] uppercase">
            {t("pendingReview")}
          </span>
          <span>
            {t("submittedPrefix")}{" "}
            {pending?.submittedAt
              ? new Date(pending.submittedAt).toLocaleDateString()
              : ""}
            {t("submittedSuffix")}
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex h-7 items-center rounded-full border border-amber-300 bg-surface px-2.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
          >
            {t("viewEdit")}
          </button>
          <button
            type="button"
            onClick={() => void withdraw()}
            disabled={busy}
            className="inline-flex h-7 items-center rounded-full border border-amber-300 bg-surface px-2.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-60 dark:text-amber-300 dark:hover:bg-amber-900/40"
          >
            {t("withdraw")}
          </button>
        </div>
      ) : rejection ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50/80 px-3 py-2 text-xs text-rose-900 dark:border-rose-800/60 dark:text-rose-300">
          <span className="font-mono text-[10px] tracking-[0.12em] uppercase">
            {t("rejected")}
          </span>
          <span>{rejection}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex h-7 items-center rounded-full border border-rose-300 bg-surface px-2.5 text-[11px] font-medium text-rose-900 transition hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-900/40"
          >
            {t("tryAgain")}
          </button>
        </div>
      ) : null}

      {submitStatus ? (
        <div
          className={`mb-4 rounded-2xl border px-3 py-2 text-xs ${
            submitStatus === "auto_approved"
              ? "border-emerald-200 bg-chip-success-bg text-chip-success-fg dark:border-emerald-800/60"
              : "border-amber-200 bg-chip-warning-bg text-chip-warning-fg dark:border-amber-800/60"
          }`}
        >
          {submitStatus === "auto_approved"
            ? t("autoApproved")
            : t("queuedForReview")}
        </div>
      ) : null}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-black/40 dark:hover:border-white/40"
        >
          <Pencil className="size-3.5" />
          {t("open")}
        </button>
      ) : null}

      {open ? (
        <div
          aria-modal
          role="dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          tabIndex={-1}
        >
          <div
            className="w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
            style={{ maxHeight: "calc(100vh - 2rem)" }}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-medium tracking-tight">
                  {t("modalTitle")}
                </h2>
                <p className="mt-1 text-xs text-muted-3">{t("modalBody")}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-muted-4 hover:bg-surface-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="edit-display-name"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.displayName")}
                </label>
                <input
                  id="edit-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={60}
                  className="mt-1 w-full rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {displayName.length}/60
                </p>
              </div>

              <div>
                <label
                  htmlFor="edit-description"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.description")}
                </label>
                <textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={280}
                  rows={4}
                  className="mt-1 w-full resize-none rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {description.length}/280
                </p>
              </div>

              <div>
                <label
                  htmlFor="edit-tags"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.tags")}
                </label>
                <input
                  id="edit-tags"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder={t("tagsPlaceholder")}
                  className="mt-1 w-full rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {t("tagsHelp")}
                </p>
              </div>

              <div className="border-t border-border-base pt-4">
                <label
                  htmlFor="edit-sprite"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("spritesheetLabel")}
                </label>
                <p className="mt-0.5 text-[11px] text-muted-4">
                  {t("spritesheetHelp")}
                </p>
                <input
                  ref={spriteInputRef}
                  id="edit-sprite"
                  type="file"
                  accept="image/webp,image/png"
                  onChange={(e) => void handleSpriteChange(e)}
                  className="mt-2 w-full cursor-pointer rounded-xl border border-border-base bg-surface px-3 py-2 text-xs text-muted-3 file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-foreground"
                />
                {spriteError ? (
                  <p className="mt-1 text-[11px] text-chip-danger-fg">
                    {spriteError}
                  </p>
                ) : null}
                {spritePreviewUrl ? (
                  <div className="mt-2 flex items-center gap-3">
                    {/* biome-ignore lint/performance/noImgElement: blob: URL from local file pick, next/image can't optimize it */}
                    <img
                      src={spritePreviewUrl}
                      alt="Sprite preview"
                      className="h-16 w-16 rounded-lg border border-border-base object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSpriteFile(null);
                        setSpriteError(null);
                        if (spritePreviewUrl) {
                          URL.revokeObjectURL(spritePreviewUrl);
                          setSpritePreviewUrl(null);
                        }
                        if (spriteInputRef.current) {
                          spriteInputRef.current.value = "";
                        }
                      }}
                      className="text-[11px] text-muted-4 hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              <div>
                <label
                  htmlFor="edit-meta"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("metaLabel")}
                </label>
                <p className="mt-0.5 text-[11px] text-muted-4">
                  {t("metaHelp")}
                </p>
                <input
                  ref={metaInputRef}
                  id="edit-meta"
                  type="file"
                  accept="application/json,.json"
                  onChange={handleMetaChange}
                  className="mt-2 w-full cursor-pointer rounded-xl border border-border-base bg-surface px-3 py-2 text-xs text-muted-3 file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-foreground"
                />
                {metaError ? (
                  <p className="mt-1 text-[11px] text-chip-danger-fg">
                    {metaError}
                  </p>
                ) : null}
                {metaFile && !metaError ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[11px] text-muted-3">
                      {metaFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setMetaFile(null);
                        setMetaError(null);
                        if (metaInputRef.current) {
                          metaInputRef.current.value = "";
                        }
                      }}
                      className="text-[11px] text-muted-4 hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>

              {error ? (
                <p className="rounded-xl bg-chip-danger-bg px-3 py-2 text-xs text-chip-danger-fg">
                  {error.replace(/_/g, " ")}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong"
                >
                  {t("actions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy || Boolean(spriteError) || Boolean(metaError)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-stone-800 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {busy ? t("uploading") : t("actions.submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
