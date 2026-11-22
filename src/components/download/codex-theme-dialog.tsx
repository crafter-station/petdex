"use client";

import { useEffect, useState } from "react";

import { Check, Copy, Loader2 } from "lucide-react";

import { CodexLogo } from "@/components/download/codex-logo";
import { Button } from "@/components/ui/button";
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
  const [data, setData] = useState<ThemeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<CopiedTarget>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/pets/${petSlug}/codex-theme`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
          };
          throw new Error(
            body.message ?? body.error ?? `request failed (${res.status})`,
          );
        }
        return (await res.json()) as ThemeResponse;
      })
      .then((value) => {
        if (cancelled) return;
        setData(value);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
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
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Clipboard write blocked. Try again or copy from devtools.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <CodexLogo className="size-5" />
            <span>Codex theme from {petDisplayName}</span>
          </DialogTitle>
          <DialogDescription>
            Generated from the pet's dominant color. Codex Desktop has no deep
            link for theme install yet, so paste this into Settings to apply.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-2">
            <Loader2 className="size-4 animate-spin" />
            Building theme…
          </div>
        ) : error ? (
          <p className="rounded-2xl bg-chip-danger-bg px-3 py-2 text-sm text-chip-danger-fg">
            {error}
          </p>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <ThemeColumn
                label="Light"
                surface={data.theme.light.theme.surface}
                ink={data.theme.light.theme.ink}
                accent={data.theme.light.theme.accent}
                copied={copied === "light"}
                onCopy={() => copyVariant("light")}
              />
              <ThemeColumn
                label="Dark"
                surface={data.theme.dark.theme.surface}
                ink={data.theme.dark.theme.ink}
                accent={data.theme.dark.theme.accent}
                copied={copied === "dark"}
                onCopy={() => copyVariant("dark")}
              />
            </div>

            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-2">
              <li>Codex Desktop → Settings → Appearance.</li>
              <li>
                Click <span className="font-medium">Import</span> on Light
                theme, paste, repeat for Dark theme.
              </li>
              <li>Both repaint from {data.dominantColor}.</li>
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
      <Button
        type="button"
        variant="petdex-inverse"
        size="lg"
        onClick={onCopy}
        className="w-full"
      >
        {copied ? (
          <>
            <Check className="size-3.5" />
            Copied
          </>
        ) : (
          <>
            <Copy className="size-3.5" />
            Copy {label}
          </>
        )}
      </Button>
    </div>
  );
}
