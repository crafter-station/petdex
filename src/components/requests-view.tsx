"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { track } from "@vercel/analytics";
import {
  ArrowUp,
  Check,
  ExternalLink,
  Flame,
  Image as ImageIcon,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { ClaimRequestButton } from "@/components/claim-request-button";

type ClerkInfo = {
  handle: string;
  displayName: string | null;
  username: string | null;
  imageUrl: string | null;
};

type FulfilledPet = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
};

export type RequestRow = {
  id: string;
  query: string;
  upvoteCount: number;
  status: string;
  fulfilledPetSlug: string | null;
  imageUrl: string | null;
  imageReviewStatus: string;
  hasPendingImage: boolean;
  createdAt: string | Date;
  voted?: boolean;
  requester: ClerkInfo | null;
  voters: ClerkInfo[];
  fulfilledPet: FulfilledPet | null;
};

const MIN_LEN = 4;
const MAX_LEN = 200;
const COLLECTION_PREFIX = "Collection:";

type Sort = "top" | "new" | "fulfilled";
type RequestKind = "pet" | "collection";

export function RequestsView({ initial }: { initial: RequestRow[] }) {
  const t = useTranslations("requests.view");
  const [requests, setRequests] = useState<RequestRow[]>(initial);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("top");
  const [search, setSearch] = useState("");
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const previousRects = useRef(new Map<string, DOMRect>());

  // Form state
  const [requestKind, setRequestKind] = useState<RequestKind>("pet");
  const [draft, setDraft] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    mode: "created" | "upvoted";
    query: string;
    count: number;
  } | null>(null);

  // Re-fetch with credentials so the user's own votes light up.
  // We always pull status=all so all three sort tabs work without
  // another roundtrip when the user toggles them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/pet-requests?status=all&limit=80");
        if (!res.ok) return;
        const data = (await res.json()) as { requests: RequestRow[] };
        if (cancelled) return;
        setRequests(data.requests);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    return {
      open: requests.filter((r) => r.status === "open").length,
      fulfilled: requests.filter((r) => r.status === "fulfilled").length,
      total: requests.length,
    };
  }, [requests]);

  const visible = useMemo(() => {
    const trimmed = search.trim().toLowerCase();
    let list = requests;
    if (sort === "fulfilled") {
      list = list.filter((r) => r.status === "fulfilled");
    } else if (sort === "new") {
      list = list
        .filter((r) => r.status === "open")
        .slice()
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
    } else {
      list = list
        .filter((r) => r.status === "open")
        .slice()
        .sort(sortByTop);
    }
    if (trimmed) {
      list = list.filter((r) => r.query.toLowerCase().includes(trimmed));
    }
    return list;
  }, [requests, sort, search]);

  const setItemRef = useCallback(
    (id: string) => (node: HTMLLIElement | null) => {
      if (node) {
        itemRefs.current.set(id, node);
      } else {
        itemRefs.current.delete(id);
      }
    },
    [],
  );

  const capturePositions = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const next = new Map<string, DOMRect>();
    itemRefs.current.forEach((node, id) => {
      next.set(id, node.getBoundingClientRect());
    });
    previousRects.current = next;
  }, []);

  useLayoutEffect(() => {
    const before = previousRects.current;
    if (before.size === 0) return;

    itemRefs.current.forEach((node, id) => {
      const previous = before.get(id);
      if (!previous) return;
      const current = node.getBoundingClientRect();
      const dx = previous.left - current.left;
      const dy = previous.top - current.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
    });
    previousRects.current = new Map();
  });

  async function uploadImage(file: File): Promise<string> {
    if (!["image/png", "image/webp", "image/jpeg"].includes(file.type)) {
      throw new Error(t("errors.imageType"));
    }
    if (file.size > 4 * 1024 * 1024) {
      throw new Error(t("errors.imageTooLarge"));
    }
    const presign = await fetch("/api/pet-requests/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type, size: file.size }),
    });
    if (!presign.ok) {
      throw new Error(t("errors.imageUpload"));
    }
    const data = (await presign.json()) as {
      uploadUrl: string;
      publicUrl: string;
    };
    const upload = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!upload.ok) {
      throw new Error(t("errors.imageUpload"));
    }
    return data.publicUrl;
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = draft.trim();
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
      setFormError(t("errors.moreDetail", { min: MIN_LEN, max: MAX_LEN }));
      return;
    }
    const requestQuery = toStoredRequestQuery(requestKind, trimmed);
    track("pet_request_clicked", { from: "requests_form" });
    setFormError(null);
    setSubmitting(true);
    try {
      const imageUrl = imageFile ? await uploadImage(imageFile) : null;
      const res = await fetch("/api/pet-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: requestQuery, imageUrl }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          track("pet_request_blocked", { reason: "unauthorized" });
          setFormError(t("errors.signInRequest"));
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        track("pet_request_failed", { status: res.status });
        setFormError(
          data.message ??
            data.error ??
            t("errors.submitFailed", { status: res.status }),
        );
        return;
      }
      const data = (await res.json()) as {
        mode: "created" | "upvoted";
        upvoteCount: number;
        id: string;
      };
      track("pet_request_succeeded", {
        mode: data.mode,
        upvotes: data.upvoteCount,
      });
      setLastResult({
        mode: data.mode,
        query: requestQuery,
        count: data.upvoteCount,
      });
      setDraft("");
      setImageFile(null);
      setFileInputKey((key) => key + 1);
      try {
        const r2 = await fetch("/api/pet-requests?status=all&limit=80");
        if (r2.ok) {
          const d2 = (await r2.json()) as { requests: RequestRow[] };
          capturePositions();
          setRequests(d2.requests);
        }
      } catch {
        /* ignore */
      }
    } catch (err) {
      track("pet_request_failed", { reason: "network" });
      setFormError(
        err instanceof Error ? err.message : t("errors.networkRetry"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function upvote(req: RequestRow) {
    if (pending.has(req.id) || req.voted || req.status === "fulfilled") return;
    track("pet_request_upvote_clicked", { id: req.id });
    setPending((s) => new Set(s).add(req.id));
    setError(null);
    try {
      const res = await fetch("/api/pet-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: req.query }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError(t("errors.signInUpvote"));
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setError(
          data.message ??
            data.error ??
            t("errors.voteFailed", { status: res.status }),
        );
        return;
      }
      const data = (await res.json()) as { upvoteCount: number };
      capturePositions();
      setRequests((rs) =>
        rs.map((r) =>
          r.id === req.id
            ? { ...r, voted: true, upvoteCount: data.upvoteCount }
            : r,
        ),
      );
    } catch {
      setError(t("errors.network"));
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(req.id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* Always-visible request form */}
      <form
        onSubmit={submitForm}
        className="space-y-4 rounded-3xl border border-border-base bg-surface/90 px-4 py-4 shadow-[0_8px_24px_-12px_rgba(56,71,245,0.18)] backdrop-blur dark:shadow-black/30"
      >
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full bg-brand text-white">
            <Sparkles className="size-3.5" />
          </span>
          <p className="text-sm font-semibold text-foreground">
            {requestKind === "collection"
              ? t("form.titleCollection")
              : t("form.titlePet")}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <RequestKindButton
            active={requestKind === "pet"}
            onClick={() => setRequestKind("pet")}
            title={t("form.type.pet")}
            body={t("form.type.petBody")}
          />
          <RequestKindButton
            active={requestKind === "collection"}
            onClick={() => setRequestKind("collection")}
            title={t("form.type.collection")}
            body={t("form.type.collectionBody")}
          />
        </div>
        <p className="text-xs text-muted-3">
          {requestKind === "collection"
            ? t("form.bodyCollection")
            : t("form.bodyPet")}
        </p>
        <p className="rounded-2xl border border-brand/20 bg-brand/10 px-3 py-2 text-xs leading-5 text-muted-1 dark:border-brand-light/30 dark:bg-brand/15 dark:text-brand-light">
          {requestKind === "collection"
            ? t("form.collectionHint")
            : t("form.petHint")}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <label className="relative block w-full flex-1">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (formError) setFormError(null);
                if (lastResult) setLastResult(null);
              }}
              placeholder={
                requestKind === "collection"
                  ? t("form.placeholderCollection")
                  : t("form.placeholderPet")
              }
              maxLength={MAX_LEN}
              className="h-11 w-full rounded-full border border-border-base bg-background px-4 text-sm text-foreground outline-none transition placeholder:text-muted-4 focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
            />
            <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 font-mono text-[10px] text-stone-300 dark:text-stone-600">
              {draft.length}/{MAX_LEN}
            </span>
          </label>
          <button
            type="submit"
            disabled={submitting || draft.trim().length < MIN_LEN}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-full bg-brand px-5 text-sm font-medium text-white transition hover:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-4" />
            {submitting
              ? t("form.sending")
              : requestKind === "collection"
                ? t("form.submitCollection")
                : t("form.submitPet")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:bg-surface-muted hover:text-foreground">
            <ImageIcon className="size-3.5" />
            {t("form.imageLabel")}
            <input
              key={fileInputKey}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setImageFile(file);
                setFormError(null);
                setLastResult(null);
              }}
            />
          </label>
          <span className="text-xs text-muted-3">{t("form.imageBody")}</span>
          {imageFile ? (
            <button
              type="button"
              onClick={() => {
                setImageFile(null);
                setFileInputKey((key) => key + 1);
              }}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-surface-muted px-2.5 text-xs text-muted-2 transition hover:text-foreground"
            >
              <X className="size-3.5" />
              {imageFile.name}
            </button>
          ) : null}
        </div>
        {formError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
            {formError}
          </p>
        ) : null}
        {lastResult ? (
          <p className="rounded-xl border border-emerald-200 bg-chip-success-bg px-3 py-2 text-xs font-medium text-chip-success-fg dark:border-emerald-800/60">
            <Check className="-mt-0.5 mr-1 inline-block size-3.5" />
            {lastResult.mode === "created"
              ? t("success.created", { query: lastResult.query })
              : t("success.upvoted", {
                  query: lastResult.query,
                  count: lastResult.count,
                })}
          </p>
        ) : null}
      </form>

      {/* Sort tabs + search */}
      {requests.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <SortTab
            active={sort === "top"}
            onClick={() => setSort("top")}
            icon={<Flame className="size-3.5" />}
            label={t("sort.top")}
            count={counts.open}
          />
          <SortTab
            active={sort === "new"}
            onClick={() => setSort("new")}
            icon={<Sparkles className="size-3.5" />}
            label={t("sort.new")}
            count={counts.open}
          />
          <SortTab
            active={sort === "fulfilled"}
            onClick={() => setSort("fulfilled")}
            icon={<Check className="size-3.5" />}
            label={t("sort.fulfilled")}
            count={counts.fulfilled}
          />
          <label className="relative ml-auto block w-48">
            <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-3.5 text-muted-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sort.searchPlaceholder")}
              className="h-9 w-full rounded-full border border-border-base bg-surface pr-3 pl-8 text-xs text-stone-900 outline-none placeholder:text-muted-4 focus:border-brand/60 dark:text-stone-100"
            />
          </label>
        </div>
      ) : null}

      {/* List */}
      {error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {requests.length === 0 ? (
        <EmptyState />
      ) : visible.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border-base bg-surface/70 p-8 text-center text-sm text-muted-2">
          {search ? t("empty.noMatches", { search }) : t("empty.nothingInView")}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              upvote={() => void upvote(r)}
              busy={pending.has(r.id)}
              t={t}
              itemRef={setItemRef(r.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SortTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${
        active
          ? "border-inverse bg-inverse text-on-inverse"
          : "border-black/10 bg-surface text-muted-2 hover:border-black/30 dark:border-white/10 dark:hover:border-white/30"
      }`}
    >
      {icon}
      {label}
      <span
        className={`font-mono text-[10px] ${
          active ? "text-white/70" : "text-stone-400"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function RequestKindButton({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border px-3 py-2 text-left transition ${
        active
          ? "border-brand bg-brand text-white shadow-sm shadow-brand/20"
          : "border-border-base bg-background text-muted-2 hover:bg-surface-muted hover:text-foreground"
      }`}
    >
      <span className="block text-xs font-semibold">{title}</span>
      <span
        className={`mt-1 block text-[11px] leading-4 ${
          active ? "text-white/75" : "text-muted-3"
        }`}
      >
        {body}
      </span>
    </button>
  );
}

function RequestCard({
  request,
  upvote,
  busy,
  t,
  itemRef,
}: {
  request: RequestRow;
  upvote: () => void;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
  itemRef: (node: HTMLLIElement | null) => void;
}) {
  const fulfilled = request.status === "fulfilled";
  const top3 = request.voters.slice(0, 3);
  const moreVoters = Math.max(0, request.upvoteCount - top3.length);
  const parsedRequest = parseRequestQuery(request.query);

  return (
    <li
      ref={itemRef}
      className={`group rounded-2xl border bg-surface px-4 py-3.5 backdrop-blur transition ${
        fulfilled
          ? "border-emerald-200 hover:border-emerald-300 dark:border-emerald-900/50 dark:hover:border-emerald-800"
          : "border-border-base hover:border-brand/40 hover:shadow-[0_18px_45px_-26px_rgba(82,102,234,0.4)] dark:hover:shadow-[0_18px_45px_-28px_rgba(132,156,255,0.45)]"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Vote button */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            upvote();
          }}
          disabled={busy || request.voted || fulfilled}
          aria-label={t("upvoteAria", { query: parsedRequest.label })}
          className={`flex shrink-0 flex-col items-center gap-0.5 rounded-xl border px-3 py-2 transition ${
            request.voted
              ? "border-brand bg-brand text-white"
              : "border-border-base bg-background text-muted-2 hover:border-brand/40 hover:bg-brand-tint dark:hover:bg-brand/15"
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {request.voted ? (
            <Check className="size-4" />
          ) : (
            <ArrowUp className="size-4" />
          )}
          <span className="font-mono text-sm font-semibold leading-none">
            {request.upvoteCount}
          </span>
        </button>

        {/* Body */}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm leading-6 font-medium text-stone-900 dark:text-stone-100">
              {parsedRequest.label}
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ring-1 ${
                parsedRequest.kind === "collection"
                  ? "bg-brand-tint text-brand-deep ring-brand/20 dark:bg-brand/15 dark:text-brand-light dark:ring-brand-light/25"
                  : "bg-surface-muted text-muted-2 ring-border-base"
              }`}
            >
              {parsedRequest.kind === "collection"
                ? t("badges.collection")
                : t("badges.pet")}
            </span>
            {fulfilled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-chip-success-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-chip-success-fg uppercase ring-1 ring-chip-success-fg/20">
                <Check className="size-3" />
                {t("badges.fulfilled")}
              </span>
            ) : null}
            {request.hasPendingImage ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-chip-warning-fg uppercase ring-1 ring-chip-warning-fg/20">
                <ImageIcon className="size-3" />
                {t("badges.imagePending")}
              </span>
            ) : null}
            <span className="ml-auto font-mono text-[10px] tracking-[0.12em] text-muted-4 uppercase">
              {new Date(request.createdAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>

          {request.imageUrl ? (
            <div className="overflow-hidden rounded-2xl border border-border-base bg-surface-muted">
              {/* biome-ignore lint/performance/noImgElement: R2 request reference */}
              <img
                src={request.imageUrl}
                alt=""
                className="max-h-48 w-full object-cover"
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {/* Requester */}
            {request.requester ? (
              <Link
                href={`/u/${request.requester.handle}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-0.5 text-muted-2 transition hover:bg-surface-muted hover:text-stone-900 dark:hover:text-stone-100"
              >
                {request.requester.imageUrl ? (
                  // biome-ignore lint/performance/noImgElement: Clerk avatar
                  <img
                    src={request.requester.imageUrl}
                    alt=""
                    className="size-4 rounded-full ring-1 ring-black/10"
                  />
                ) : (
                  <span className="grid size-4 place-items-center rounded-full bg-stone-200 font-mono text-[8px] font-semibold text-muted-2 dark:bg-stone-700">
                    {(request.requester.displayName ?? request.requester.handle)
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}
                <span>
                  {request.requester.displayName ??
                    `@${request.requester.handle}`}
                </span>
              </Link>
            ) : null}

            {/* Voter avatar stack */}
            {top3.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-muted-3">
                <span className="flex -space-x-1.5">
                  {top3.map((v) =>
                    v.imageUrl ? (
                      // biome-ignore lint/performance/noImgElement: Clerk avatar
                      <img
                        key={v.handle}
                        src={v.imageUrl}
                        alt=""
                        title={v.displayName ?? `@${v.handle}`}
                        className="size-5 rounded-full ring-2 ring-white"
                      />
                    ) : (
                      <span
                        key={v.handle}
                        title={v.displayName ?? `@${v.handle}`}
                        className="grid size-5 place-items-center rounded-full bg-stone-200 font-mono text-[8px] font-semibold text-muted-2 ring-2 ring-white dark:bg-stone-700"
                      >
                        {(v.displayName ?? v.handle).slice(0, 1).toUpperCase()}
                      </span>
                    ),
                  )}
                </span>
                {moreVoters > 0 ? (
                  <span className="font-mono text-[10px]">
                    {t("moreVoters", { count: moreVoters })}
                  </span>
                ) : null}
              </span>
            ) : null}

            {/* Fulfilled pet CTA */}
            {fulfilled && request.fulfilledPet ? (
              <Link
                href={`/pets/${request.fulfilledPet.slug}`}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-chip-success-bg px-2.5 py-1 font-mono text-[11px] tracking-[0.04em] text-chip-success-fg transition hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-800/60 dark:hover:border-emerald-700 dark:hover:bg-emerald-900/40"
              >
                <Sparkles className="size-3" />
                {request.fulfilledPet.displayName}
                <ExternalLink className="size-3" />
              </Link>
            ) : null}

            {/* Claim CTA — shown only on open requests */}
            {!fulfilled ? (
              <ClaimRequestButton
                requestId={request.id}
                requestQuery={parsedRequest.label}
              />
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function sortByTop(a: RequestRow, b: RequestRow): number {
  if (b.upvoteCount !== a.upvoteCount) return b.upvoteCount - a.upvoteCount;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function toStoredRequestQuery(kind: RequestKind, value: string): string {
  const stripped = stripCollectionPrefix(value);
  return kind === "collection" ? `${COLLECTION_PREFIX} ${stripped}` : stripped;
}

function parseRequestQuery(query: string): {
  kind: RequestKind;
  label: string;
} {
  if (query.trim().toLowerCase().startsWith(COLLECTION_PREFIX.toLowerCase())) {
    return {
      kind: "collection",
      label: stripCollectionPrefix(query),
    };
  }

  return { kind: "pet", label: query };
}

function stripCollectionPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith(COLLECTION_PREFIX.toLowerCase())) {
    return trimmed.slice(COLLECTION_PREFIX.length).trim();
  }

  return trimmed;
}

function EmptyState() {
  const t = useTranslations("requests.view");

  return (
    <div className="space-y-3 rounded-3xl border border-dashed border-border-base bg-surface/70 p-8 text-center">
      <span className="mx-auto grid size-10 place-items-center rounded-full bg-brand-tint text-brand dark:bg-brand-tint-dark">
        <Sparkles className="size-4" />
      </span>
      <p className="text-sm font-medium text-foreground">{t("empty.title")}</p>
      <p className="text-xs text-muted-3">
        {t("empty.beforeLink")}{" "}
        <a
          href="/#gallery"
          className="text-brand underline-offset-4 hover:underline"
        >
          {t("empty.link")}
        </a>{" "}
        {t("empty.afterLink")}
      </p>
    </div>
  );
}
