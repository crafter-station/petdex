"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import {
  Bug,
  Check,
  Heart,
  Lightbulb,
  MessageCircle,
  MessageSquare,
  Send,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";

export type FeedbackKind = "suggestion" | "bug" | "praise" | "other";

export type FeedbackSubmitState =
  | { tag: "idle" }
  | { tag: "submitting" }
  | { tag: "ok" }
  | { tag: "error"; reason: string };

type Props = {
  email: string;
  kind: FeedbackKind;
  message: string;
  onClose: () => void;
  setEmail: (next: string) => void;
  setKind: (next: FeedbackKind) => void;
  setMessage: (next: string) => void;
  setState: Dispatch<SetStateAction<FeedbackSubmitState>>;
  state: FeedbackSubmitState;
};

export function FeedbackPopover({
  email,
  kind,
  message,
  onClose,
  setEmail,
  setKind,
  setMessage,
  setState,
  state,
}: Props) {
  const t = useTranslations("feedback");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const kinds = useMemo(
    () => [
      {
        id: "suggestion" as const,
        label: t("kinds.suggestion"),
        icon: <Lightbulb className="size-3.5" />,
      },
      {
        id: "bug" as const,
        label: t("kinds.bug"),
        icon: <Bug className="size-3.5" />,
      },
      {
        id: "praise" as const,
        label: t("kinds.praise"),
        icon: <Heart className="size-3.5" />,
      },
      {
        id: "other" as const,
        label: t("kinds.other"),
        icon: <MessageSquare className="size-3.5" />,
      },
    ],
    [t],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    const focusTimer = window.setTimeout(
      () => textareaRef.current?.focus(),
      50,
    );
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (state.tag === "submitting") return;
      if (message.trim().length < 4) {
        setState({ tag: "error", reason: t("errors.moreDetail") });
        return;
      }
      setState({ tag: "submitting" });
      try {
        const res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            message,
            email,
            pageUrl:
              typeof window !== "undefined" ? window.location.href : null,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          setState({
            tag: "error",
            reason:
              data.message ??
              data.error ??
              t("errors.submitFailed", { status: res.status }),
          });
          return;
        }
        setState({ tag: "ok" });
      } catch {
        setState({ tag: "error", reason: t("errors.network") });
      }
    },
    [state.tag, message, email, kind, t, setState],
  );

  return (
    <div
      ref={popoverRef}
      className="w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-border-base bg-surface shadow-2xl shadow-blue-950/20"
    >
      <div className="flex items-center justify-between border-b border-border-base px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full bg-brand-tint text-brand dark:bg-brand-tint-dark">
            <MessageCircle className="size-3.5" />
          </span>
          <span className="text-sm font-semibold text-foreground">
            {t("title")}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("close")}
          onClick={onClose}
          className="grid size-7 place-items-center rounded-full text-muted-3 transition hover:bg-surface-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {state.tag === "ok" ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-chip-success-bg text-chip-success-fg ring-1 ring-chip-success-fg/20">
            <Check className="size-5" />
          </span>
          <p className="text-base font-medium text-foreground">
            {t("success.title")}
          </p>
          <p className="text-xs text-muted-3">{t("success.body")}</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap gap-1.5">
            {kinds.map((k) => {
              const active = k.id === kind;
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setKind(k.id)}
                  aria-pressed={active}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${
                    active
                      ? "border-inverse bg-inverse text-on-inverse"
                      : "border-border-base bg-surface text-muted-2 hover:border-border-strong"
                  }`}
                >
                  {k.icon}
                  {k.label}
                </button>
              );
            })}
          </div>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              if (state.tag === "error") setState({ tag: "idle" });
            }}
            placeholder={
              kind === "bug"
                ? t("placeholders.bug")
                : kind === "suggestion"
                  ? t("placeholders.suggestion")
                  : kind === "praise"
                    ? t("placeholders.praise")
                    : t("placeholders.other")
            }
            rows={4}
            maxLength={4000}
            className="w-full resize-none rounded-2xl border border-border-base bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-4 focus:border-border-strong"
          />

          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("emailPlaceholder")}
            className="h-10 w-full rounded-full border border-border-base bg-surface px-3.5 text-sm text-foreground outline-none transition placeholder:text-muted-4 focus:border-border-strong"
          />

          {state.tag === "error" ? (
            <p className="text-xs text-chip-danger-fg">{state.reason}</p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[10px] tracking-tight text-muted-4">
              {message.length}/4000
            </p>
            <button
              type="submit"
              disabled={state.tag === "submitting" || message.length < 4}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
            >
              <Send className="size-3.5" />
              {state.tag === "submitting" ? t("sending") : t("send")}
            </button>
          </div>

          <p className="border-t border-border-base pt-3 text-[11px] leading-5 text-muted-3">
            {t("githubPrompt")}{" "}
            <a
              href={githubIssueUrlFor(kind, message)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand underline-offset-2 hover:underline"
            >
              {t("openIssue")}
            </a>
          </p>
        </form>
      )}
    </div>
  );
}

function githubIssueUrlFor(kind: string, message: string): string {
  const repo = "crafter-station/petdex";
  const labelMap: Record<string, string> = {
    bug: "bug",
    suggestion: "enhancement",
    praise: "good first issue",
    other: "question",
  };
  const titleByKind: Record<string, string> = {
    bug: "Bug: ",
    suggestion: "Suggestion: ",
    praise: "Note: ",
    other: "",
  };
  const titleSeed = (message.split("\n")[0] ?? "").slice(0, 70);
  const title = `${titleByKind[kind] ?? ""}${titleSeed}`.trim() || "Feedback";
  const body = message.slice(0, 6000);
  const params = new URLSearchParams();
  params.set("title", title);
  params.set("labels", labelMap[kind] ?? "");
  if (body) params.set("body", body);
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}
