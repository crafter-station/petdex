"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

type PetKeyboardNavProps = {
  /** Where ArrowLeft should send the visitor. Null disables that key. */
  prevSlug: string | null;
  /** Where ArrowRight should send the visitor. Null disables that key. */
  nextSlug: string | null;
  /** Where Space should send the visitor (random pet). Null disables. */
  shuffleHref: string | null;
};

// Keyboard shortcuts for the Pokedex-style detail page.
// ArrowLeft  -> previous dex slug
// ArrowRight -> next dex slug
// Space      -> shuffle to a random approved pet
//
// Scroll preservation: by default Next's router scrolls to the top on
// every push, which yanks the visitor away from whatever they were
// looking at (radar, variants, install). We pass `scroll: false` so
// the navigator stays put — the new page's content swaps in around
// them. The dex eyebrow + h1 still update so the URL change is
// obvious. If you want the visitor to land back at the banner, scroll
// to it manually before pushing.
//
// Ignores keystrokes when the user is typing in an input/textarea or
// has a contentEditable focused — we don't want to hijack form fields.
export function PetKeyboardNav({
  prevSlug,
  nextSlug,
  shuffleHref,
}: PetKeyboardNavProps) {
  const router = useRouter();

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      if (!target) return false;
      const el = target as HTMLElement;
      const tag = el.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      if (event.key === "ArrowLeft" && prevSlug) {
        event.preventDefault();
        router.push(`/pets/${prevSlug}`, { scroll: false });
        return;
      }
      if (event.key === "ArrowRight" && nextSlug) {
        event.preventDefault();
        router.push(`/pets/${nextSlug}`, { scroll: false });
        return;
      }
      if (event.key === " " && shuffleHref) {
        event.preventDefault();
        // The shuffle endpoint returns JSON `{ slug, href }` when
        // requested with Accept: application/json (and 302s otherwise
        // for the plain <a href> case). We ask for JSON, parse the
        // href, and router.push it with scroll:false so the visitor
        // keeps their scroll offset.
        void (async () => {
          try {
            const res = await fetch(shuffleHref, {
              headers: { accept: "application/json" },
            });
            if (!res.ok) {
              window.location.assign(shuffleHref);
              return;
            }
            const data = (await res.json()) as { href?: string };
            if (data.href) {
              router.push(data.href, { scroll: false });
            }
          } catch {
            window.location.assign(shuffleHref);
          }
        })();
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, prevSlug, nextSlug, shuffleHref]);

  return null;
}
