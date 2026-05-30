"use client";

import { Fragment, useState } from "react";

import { track } from "@vercel/analytics";
import { Check, CircleAlert, Copy } from "lucide-react";
import { useTranslations } from "next-intl";

import { CodexLogo } from "@/components/codex-logo";

type CommandLineProps = {
  command: string;
  /** Lighter prefix prepended without being copied (eg. "$ "). Visual only. */
  prefix?: string;
  /** Tracking event payload key. */
  source?: string;
  className?: string;
  /**
   * If provided, render a Codex deep-link button next to the copy
   * affordance. The seed prompt is wrapped as
   * `Install this Petdex pet by running: <command>` so Codex Desktop
   * runs the install without the user needing a terminal.
   */
  codexPrompt?: string;
  wrap?: boolean;
};

/**
 * Display says `npx petdex install desktop`, clipboard says
 * `npx petdex@latest install desktop`. Pinning to @latest in the
 * copy keeps every paste resolving to the newest release without
 * cluttering the visual command. Also handles bare `petdex`
 * (without npx) so a user copying from a globally-installed
 * snippet still gets the latest tag.
 *
 * Rewrites each shell command segment so chained setup snippets keep
 * every Petdex invocation on the newest release.
 */
function pinToLatest(command: string): string {
  return command
    .split(/(\s*(?:&&|\|\||;|\|)\s*)/g)
    .map((segment) => {
      if (/^\s*(?:&&|\|\||;|\|)\s*$/.test(segment)) return segment;
      return segment
        .replace(/\bnpx\s+petdex(?!@)\b/g, "npx petdex@latest")
        .replace(/^(\s*)petdex(?!@)\b/, "$1npx petdex@latest");
    })
    .join("");
}

async function writeClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the textarea fallback for browsers that expose the API
    // but block it in the current permission context.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard write failed");
  }
}

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
  codexPrompt,
  wrap = false,
}: CommandLineProps) {
  const t = useTranslations("commandLine");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copied = copyState === "copied";
  const failed = copyState === "failed";
  const rootLayoutClass = wrap ? "items-start" : "items-center";
  const commandClass = wrap
    ? "flex-1 whitespace-normal break-words leading-5"
    : "flex-1 truncate";

  async function handleCopy() {
    // Display the natural `npx petdex` form, but copy the
    // version-pinned `petdex@latest` so every paste resolves to
    // the most recent release. Tracking still uses the visual
    // form so dashboards stay readable.
    const toCopy = pinToLatest(command);
    try {
      await writeClipboard(toCopy);
      setCopyState("copied");
      track("command_line_copied", {
        command: command.slice(0, 80),
        source: source ?? "unknown",
      });
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  // The whole row is the click target for copy. We split into div + inner
  // controls only when a Codex link is present so the second action is its
  // own anchor (button-in-button is invalid HTML and also defeats the copy).
  if (codexPrompt) {
    return (
      <div
        style={{
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        }}
        className={`group inline-flex ${rootLayoutClass} gap-2 rounded-xl border border-border-base bg-surface/80 px-3 py-2 text-left text-[12px] text-foreground backdrop-blur transition hover:border-brand-light/40 hover:bg-surface ${className}`}
      >
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={
            copied ? t("copiedAria") : failed ? t("failedAria") : t("copyAria")
          }
          className={`flex flex-1 ${rootLayoutClass} gap-2 text-left`}
        >
          <span className="select-none text-brand">{prefix}</span>
          <span className={commandClass}>{tokenize(command)}</span>
          <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-3 transition group-hover:bg-brand-tint group-hover:text-brand-deep">
            {copied ? (
              <Check className="size-3.5 text-brand-deep" />
            ) : failed ? (
              <CircleAlert className="size-3.5 text-rose-600" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </span>
        </button>
        <a
          href={`codex://new?prompt=${encodeURIComponent(`Install this Petdex pet by running: ${pinToLatest(command)}`)}`}
          aria-label={t("openInCodexAria")}
          onClick={() =>
            track("command_line_codex_clicked", {
              command: command.slice(0, 80),
              source: source ?? "unknown",
            })
          }
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-3 transition hover:bg-brand-tint"
        >
          <CodexLogo className="size-3.5" />
        </a>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={
        copied ? t("copiedAria") : failed ? t("failedAria") : t("copyAria")
      }
      style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
      className={`group inline-flex ${rootLayoutClass} gap-2 rounded-xl border border-border-base bg-surface/80 px-3 py-2 text-left text-[12px] text-foreground backdrop-blur transition hover:border-brand-light/40 hover:bg-surface ${className}`}
    >
      <span className="select-none text-brand">{prefix}</span>
      <span className={commandClass}>{tokenize(command)}</span>
      <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-3 transition group-hover:bg-brand-tint group-hover:text-brand-deep">
        {copied ? (
          <Check className="size-3.5 text-brand-deep" />
        ) : failed ? (
          <CircleAlert className="size-3.5 text-rose-600" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </span>
    </button>
  );
}
