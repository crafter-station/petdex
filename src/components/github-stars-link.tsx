"use client";

import { useEffect, useState } from "react";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";

import { GithubIcon } from "@/components/github-icon";

const REPO_API = "https://api.github.com/repos/crafter-station/petdex";
const CACHE_KEY = "petdex_gh_stars_v1";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

type Cache = { count: number; ts: number };

function compact(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function GithubStarsLink({
  className = "",
  size = "nav",
}: {
  className?: string;
  size?: "nav" | "mobile";
}) {
  const [stars, setStars] = useState<number | null>(null);
  const t = useTranslations("header");

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Hydrate from cache so the count flickers in immediately on a
    // returning visitor; then refresh in the background if stale.
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Cache;
        if (Date.now() - parsed.ts < CACHE_TTL) {
          setStars(parsed.count);
          return;
        }
        // Stale: still surface old value, then refresh.
        setStars(parsed.count);
      }
    } catch {
      /* ignore corrupt cache */
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(REPO_API, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { stargazers_count?: number };
        if (cancelled || typeof data.stargazers_count !== "number") return;
        setStars(data.stargazers_count);
        try {
          window.localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ count: data.stargazers_count, ts: Date.now() }),
          );
        } catch {
          /* storage full */
        }
      } catch {
        /* ignore network */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const iconSize = size === "mobile" ? "size-5" : "size-4";

  return (
    <a
      href="https://github.com/crafter-station/petdex"
      target="_blank"
      rel="noreferrer"
      aria-label={
        stars !== null
          ? t("githubRepoAriaWithStars", { stars })
          : t("githubRepoAria")
      }
      className={`inline-flex items-center gap-1.5 transition hover:text-foreground ${className}`}
    >
      <GithubIcon className={iconSize} />
      <span className="inline-flex min-w-[3ch] items-center gap-0.5 font-mono text-[11px] text-muted-2">
        <Star className="size-3" fill="currentColor" />
        {stars !== null ? (
          compact(stars)
        ) : (
          <span
            aria-hidden
            className="inline-block h-2 w-6 animate-pulse rounded-full bg-surface-muted"
          />
        )}
      </span>
    </a>
  );
}
