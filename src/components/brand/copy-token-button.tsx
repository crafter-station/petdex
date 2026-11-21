"use client";

import { useState } from "react";

import { Button } from "@ui-sdk/react/button";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

type CopyTokenButtonProps = {
  value: string;
  label: string;
  copiedLabel: string;
  className?: string;
};

export function CopyTokenButton({
  value,
  label,
  copiedLabel,
  className,
}: CopyTokenButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button
      onClick={handleCopy}
      className={cn(
        "toy-btn toy-btn-pearl rounded-full px-2.5 py-1 text-[11px] text-muted-2 hover:text-foreground data-[pending]:opacity-70",
        copied && "text-toy-ink",
        className,
      )}
      style={{ fontFamily: "var(--font-geist-mono), monospace" }}
      aria-label={`${label}: ${value}`}
    >
      {copied ? (
        <Check className="size-3 text-toy-mint" />
      ) : (
        <Copy className="size-3" />
      )}
      <span>{copied ? copiedLabel : label}</span>
    </Button>
  );
}
