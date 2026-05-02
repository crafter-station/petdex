"use client";

import { useEffect, useState } from "react";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

type CliAuthStatus =
  | { kind: "loading"; message: string }
  | { kind: "success"; email: string | null }
  | { kind: "error"; message: string };

export function CliAuthComplete({
  callback,
  state,
}: {
  callback: string | null;
  state: string | null;
}) {
  const [status, setStatus] = useState<CliAuthStatus>({
    kind: "loading",
    message: "Connecting Petdex CLI...",
  });

  useEffect(() => {
    if (!callback || !state) {
      setStatus({
        kind: "error",
        message: "This CLI login link is missing its callback details.",
      });
      return;
    }

    let cancelled = false;
    const loginState = state;

    async function completeLogin() {
      try {
        const callbackUrl = new URL(callback as string);
        if (!isLoopbackCallback(callbackUrl)) {
          throw new Error("CLI login callback must point to localhost.");
        }

        const response = await fetch("/api/cli/token", { method: "POST" });
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          expiresAt?: string;
          ownerEmail?: string | null;
          token?: string;
        };

        if (!response.ok || !data.token) {
          throw new Error(data.error ?? "Unable to create a CLI login token.");
        }

        const fragment = new URLSearchParams({
          state: loginState,
          token: data.token,
          expiresAt: data.expiresAt ?? "",
          ownerEmail: data.ownerEmail ?? "",
          siteUrl: window.location.origin,
        });
        callbackUrl.hash = fragment.toString();

        if (!cancelled) {
          setStatus({
            kind: "loading",
            message: "Finishing login in your terminal...",
          });
          window.location.replace(callbackUrl.toString());
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message:
              error instanceof Error ? error.message : "CLI login failed.",
          });
        }
      }
    }

    void completeLogin();

    return () => {
      cancelled = true;
    };
  }, [callback, state]);

  const Icon =
    status.kind === "success"
      ? CheckCircle2
      : status.kind === "error"
        ? AlertTriangle
        : Loader2;

  return (
    <section className="w-full rounded-3xl border border-black/10 bg-white/80 p-8 text-center shadow-sm shadow-blue-950/5 backdrop-blur">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-black text-white">
        <Icon
          className={`size-6 ${status.kind === "loading" ? "animate-spin" : ""}`}
        />
      </span>
      <h1 className="mt-6 text-2xl font-medium">
        {status.kind === "error" ? "CLI login failed" : "Petdex CLI login"}
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#5d5d66]">
        {status.kind === "success"
          ? `Signed in${status.email ? ` as ${status.email}` : ""}.`
          : status.message}
      </p>
    </section>
  );
}

function isLoopbackCallback(url: URL) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.pathname === "/callback"
  );
}
