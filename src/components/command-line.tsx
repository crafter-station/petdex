"use client";

import { Fragment, useState } from "react";

import { track } from "@vercel/analytics";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";

type CommandLineProps = {
  command: string;
  /** Lighter prefix prepended without being copied (eg. "$ "). Visual only. */
  prefix?: string;
  /** Tracking event payload key. */
  source?: string;
  className?: string;
};

// Soft, light-on-light syntax: command word in brand blue, subcommands darker,
// flags accent-violet, paths/strings stone, pipes/redirects muted.
function tokenize(command: string): React.ReactNode {
  const parts = command.split(/(\s+|\||&&|\|\||;)/g).filter((s) => s !== "");
  let cmdSeen = false;
  let firstWordSeen = false;
  let offset = 0;

  return parts.map((p) => {
    const key = `${offset}:${p}`;
    offset += p.length;
    if (/^\s+$/.test(p)) {
      return <Fragment key={key}>{p}</Fragment>;
    }
    if (p === "|" || p === "&&" || p === "||" || p === ";") {
      return (
        <span key={key} className="text-muted-4">
          {p}
        </span>
      );
    }
    if (!firstWordSeen) {
      firstWordSeen = true;
      cmdSeen = true;
      return (
        <span key={key} className="font-medium text-brand-deep">
          {p}
        </span>
      );
    }
    if (p.startsWith("-")) {
      return (
        <span key={key} className="text-brand">
          {p}
        </span>
      );
    }
    if (cmdSeen && /^[a-z][a-z0-9-]*$/.test(p)) {
      cmdSeen = false;
      return (
        <span key={key} className="font-medium text-foreground">
          {p}
        </span>
      );
    }
    return (
      <span key={key} className="text-muted-2">
        {p}
      </span>
    );
  });
}

export function CommandLine({
  command,
  prefix = "$ ",
  source,
  className = "",
}: CommandLineProps) {
  const t = useTranslations("commandLine");
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      track("command_line_copied", {
        command: command.slice(0, 80),
        source: source ?? "unknown",
      });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={t("copyAria")}
      style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
      className={`group inline-flex items-center gap-2 rounded-xl border border-border-base bg-surface/80 px-3 py-2 text-left text-[12px] text-foreground backdrop-blur transition hover:border-brand-light/40 hover:bg-surface ${className}`}
    >
      <span className="select-none text-brand">{prefix}</span>
      <span className="flex-1 truncate">{tokenize(command)}</span>
      <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-3 transition group-hover:bg-brand-tint group-hover:text-brand-deep">
        {copied ? (
          <Check className="size-3.5 text-brand-deep" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </span>
    </button>
  );
}
