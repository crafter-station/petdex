"use client";

import { useEffect, useState } from "react";

import { Check, Copy, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { CodexLogo } from "@/components/download/codex-logo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ThemeResponse = {
  slug: string;
  displayName: string;
  dominantColor: string;
  theme: {
    light: { theme: { surface: string; ink: string; accent: string } };
    dark: { theme: { surface: string; ink: string; accent: string } };
  };
  clipboardLight: string;
  clipboardDark: string;
};

type CopiedTarget = "light" | "dark" | null;

/**
 * A message key under `installCompact.themeDialog.errors`, never a raw string.
 *
 * The API answers `not_found` and `no_color`; anything else surfaces whatever
 * `error` or `message` the failing layer produced, which is English prose or an
 * internal code. Rendering those verbatim is how a Spanish user ends up
 * staring at `Pet has no extracted dominant color yet.`, so the two known
 * statuses get their own message and everything else degrades to one generic
 * message that carries the code, the shape
 * `submit.form.errors.submissionFailedWithCode` already uses.
 *
 * `clipboardBlocked` is not a fetch failure — it is the `navigator.clipboard`
 * rejection, which the browser reports in the page's own language or not at
 * all. It keeps the theme columns on screen and banners above them, because the
 * values are still there to copy by hand.
 */
type LoadFailure = {
  key: "notFound" | "noColor" | "loadFailed";
  code?: string;
};
type ThemeErrorKey = LoadFailure["key"] | "clipboardBlocked";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  petSlug: string;
  petDisplayName: string;
};

export function CodexThemeDialog({
  open,
  onOpenChange,
  petSlug,
  petDisplayName,
}: Props) {
  const t = useTranslations("installCompact.themeDialog");
  const [data, setData] = useState<ThemeResponse | null>(null);
  const [error, setError] = useState<ThemeErrorKey | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<CopiedTarget>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setData(null);
    fetch(`/api/pets/${petSlug}/codex-theme`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
          };
          const failure: LoadFailure = {
            key:
              res.status === 404
                ? "notFound"
                : res.status === 422
                  ? "noColor"
                  : "loadFailed",
          };
          // Only the generic message interpolates a code; the two named
          // statuses already say what happened.
          if (failure.key === "loadFailed") {
            failure.code = body.error ?? body.message ?? `http_${res.status}`;
          }
          throw failure;
        }
        return (await res.json()) as ThemeResponse;
      })
      .then((value) => {
        if (cancelled) return;
        setData(value);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure && typeof failure === "object" && "key" in failure) {
          const { key, code } = failure as LoadFailure;
          setError(key);
          setErrorCode(code ?? null);
          return;
        }
        // A network error rejects with a `TypeError`, not our object, and has
        // no code to show — the generic message is the whole story.
        setError("loadFailed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, petSlug]);

  async function copyVariant(target: "light" | "dark") {
    if (!data) return;
    const value = target === "light" ? data.clipboardLight : data.clipboardDark;
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("clipboardBlocked");
    }
  }

  // The fetch failed, so there is nothing to show in place of the columns.
  const loadFailed = error !== null && error !== "clipboardBlocked";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <CodexLogo className="size-5" />
            <span>{t("title", { name: petDisplayName })}</span>
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-2">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : loadFailed && error ? (
          <p
            role="alert"
            className="rounded-2xl bg-chip-danger-bg px-3 py-2 text-sm text-chip-danger-fg"
          >
            {errorCode
              ? t("errors.loadFailedWithCode", { code: errorCode })
              : t(`errors.${error}`)}
          </p>
        ) : data ? (
          <div className="space-y-4">
            {error === "clipboardBlocked" ? (
              <p className="rounded-2xl bg-chip-danger-bg px-3 py-2 text-sm text-chip-danger-fg">
                {t("errors.clipboardBlocked")}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <ThemeColumn
                label={t("light")}
                surface={data.theme.light.theme.surface}
                ink={data.theme.light.theme.ink}
                accent={data.theme.light.theme.accent}
                copied={copied === "light"}
                onCopy={() => copyVariant("light")}
              />
              <ThemeColumn
                label={t("dark")}
                surface={data.theme.dark.theme.surface}
                ink={data.theme.dark.theme.ink}
                accent={data.theme.dark.theme.accent}
                copied={copied === "dark"}
                onCopy={() => copyVariant("dark")}
              />
            </div>

            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-2">
              <li>{t("stepAppearance")}</li>
              <li>
                {t.rich("stepImport", {
                  import: (chunks) => (
                    <span className="font-medium">{chunks}</span>
                  ),
                })}
              </li>
              <li>{t("stepColor", { color: data.dominantColor })}</li>
            </ol>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ThemeColumn({
  label,
  surface,
  ink,
  accent,
  copied,
  onCopy,
}: {
  label: string;
  surface: string;
  ink: string;
  accent: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const t = useTranslations("installCompact.themeDialog");
  return (
    <div className="flex flex-col gap-2">
      <div
        className="overflow-hidden rounded-2xl border border-border-base"
        style={{ background: surface }}
      >
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span
            className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70"
            style={{ color: ink }}
          >
            {label}
          </span>
          <span
            aria-hidden
            className="size-3 rounded-full"
            style={{ background: accent }}
          />
        </div>
        <div className="px-3 pb-3">
          <p className="text-sm font-medium" style={{ color: ink }}>
            Aa
          </p>
          <p className="text-xs opacity-70" style={{ color: ink }}>
            const x = 1
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
      >
        {copied ? (
          <>
            <Check className="size-3.5" />
            {t("copied")}
          </>
        ) : (
          <>
            <Copy className="size-3.5" />
            {t("copy", { label })}
          </>
        )}
      </button>
    </div>
  );
}
