"use client";

import { type RefObject, useEffect } from "react";

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) =>
      !el.hasAttribute("inert") &&
      el.getAttribute("aria-hidden") !== "true" &&
      // offsetParent is null for `display: none` — and, importantly, for
      // anything inside a closed <details>, which is how the reorder grids
      // hide their controls.
      el.offsetParent !== null,
  );
}

/**
 * Keyboard containment for a hand-written modal.
 *
 * `role="dialog"` + `aria-modal` promises assistive tech that the rest of
 * the page is inert, but that is a promise the DOM does not enforce: without
 * this, Tab from the last control in the dialog walks into the page behind
 * it, which the user cannot see. The three modals that predate the base-ui
 * `Dialog` primitive each reimplemented the overlay, the Escape handler and
 * the backdrop click, and each missed this part.
 *
 * Moves focus into the container on open, wraps Tab and Shift+Tab at the
 * ends, and returns focus to whatever was focused before on close — the
 * button that opened the dialog, in practice.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = tabbable(container)[0];
    // The container itself carries tabIndex={-1} in every caller, so this
    // is a real focus target when the dialog has no controls yet (a form
    // whose only button is disabled, say).
    (first ?? container).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const items = tabbable(container as HTMLElement);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === firstItem || !container?.contains(current)) {
          event.preventDefault();
          lastItem.focus();
        }
      } else if (current === lastItem || !container?.contains(current)) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Only restore when focus is still inside (or lost to) the dialog —
      // if the user clicked something else, that is where focus belongs.
      const activeEl = document.activeElement;
      if (
        !activeEl ||
        activeEl === document.body ||
        container.contains(activeEl)
      ) {
        previouslyFocused?.focus?.();
      }
    };
  }, [active, containerRef]);
}
