"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import type { PetStateId } from "@/lib/pet-states";

import { PetSprite } from "@/components/pet-sprite";

type PetFloaterProps = {
  src: string;
  petName: string;
};

const IDLE_CYCLE: PetStateId[] = [
  "idle",
  "idle",
  "idle",
  "idle",
  "waiting",
  "waving",
  "jumping",
  "review",
  "idle",
];

const IDLE_TICK_MIN_MS = 1700;
const IDLE_TICK_MAX_MS = 3000;
const REACTION_MS = 1100;
const RUN_TAIL_MS = 600;
const SAFE_MARGIN_PX = 12;
const DRAG_THRESHOLD_PX = 4;
const SPRITE_SIZE_PX = 110;
const THROW_MIN_VELOCITY = 0.05;
const THROW_FRICTION_PER_FRAME = 0.92;
const THROW_BOUNCE_DAMPING = -0.5;
const THROW_SAMPLE_WINDOW_MS = 80;
const THROW_SAMPLE_MAX = 4;

const HINT_DURATION_MS = 3500;
const HINT_STORAGE_KEY = "petdex_floater_hint_seen_v1";

type DragSample = {
  time: number;
  x: number;
  y: number;
};

// Interactive draggable pet that floats over the banner.
//
// Implementation: the visual sits in a React portal mounted on
// document.body so it isn't constrained by the banner's z-index or
// pointer-events stacking. We render an empty 0x0 anchor span where
// <PetFloater /> is placed in the tree; the portal reads that anchor's
// bounding box (and that of its parent banner) on every frame to know
// the visual bounds the pet should clamp to.
//
// Why portal: the banner has a max-w-6xl content wrapper that's a
// sibling/child stacking context for its descendants. Without a portal
// the pet either gets clipped by overflow:hidden or has its pointer
// events blocked by the content above it. The portal sidesteps both.
export function PetFloater({ src, petName }: PetFloaterProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [bounds, setBounds] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<PetStateId>("idle");
  const [dragging, setDragging] = useState(false);
  const [throwing, setThrowing] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const boundsRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const throwRef = useRef<{ vx: number; vy: number; rafId: number | null }>({
    vx: 0,
    vy: 0,
    rafId: null,
  });
  const tailTimeoutRef = useRef<number | null>(null);
  const reactionTimeoutRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);

  // Mount flag for the portal — createPortal needs a DOM target which
  // doesn't exist during SSR.
  useEffect(() => {
    function syncEnabled() {
      setEnabled(window.innerWidth >= 768);
    }

    syncEnabled();
    setMounted(true);
    window.addEventListener("resize", syncEnabled);
    return () => {
      window.removeEventListener("resize", syncEnabled);
    };
  }, []);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = mediaQuery.matches;
    };
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  const cancelTailTimeout = useCallback(() => {
    if (tailTimeoutRef.current !== null) {
      window.clearTimeout(tailTimeoutRef.current);
      tailTimeoutRef.current = null;
    }
  }, []);

  const cancelReactionTimeout = useCallback(() => {
    if (reactionTimeoutRef.current !== null) {
      window.clearTimeout(reactionTimeoutRef.current);
      reactionTimeoutRef.current = null;
    }
  }, []);

  const scheduleIdle = useCallback(() => {
    cancelTailTimeout();
    tailTimeoutRef.current = window.setTimeout(() => {
      tailTimeoutRef.current = null;
      setState("idle");
    }, RUN_TAIL_MS);
  }, [cancelTailTimeout]);

  const cancelThrow = useCallback(() => {
    if (throwRef.current.rafId !== null) {
      window.cancelAnimationFrame(throwRef.current.rafId);
      throwRef.current.rafId = null;
    }
    throwRef.current.vx = 0;
    throwRef.current.vy = 0;
    setThrowing(false);
  }, []);

  const updatePos = useCallback((nextPos: { x: number; y: number }) => {
    posRef.current = nextPos;
    setPos(nextPos);
  }, []);

  // Show the hint glow on first visit.
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(HINT_STORAGE_KEY);
    if (seen === "1") return;
    setShowHint(true);
    const fade = window.setTimeout(() => setShowHint(false), HINT_DURATION_MS);
    return () => window.clearTimeout(fade);
  }, [enabled]);

  function dismissHint() {
    if (!showHint) return;
    setShowHint(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(HINT_STORAGE_KEY, "1");
    }
  }

  // Measure the banner's bounding box. We track the anchor's *parent*
  // (the banner's max-w-6xl content div) because that's what the
  // designer wants the pet to live within. Re-measure on resize and
  // scroll so the pet stays aligned to the banner as the page shifts.
  useEffect(() => {
    if (!enabled) return;
    if (!mounted) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const banner = anchor.closest(".petdex-cloud") as HTMLElement | null;
    if (!banner) return;

    function measure() {
      // Re-query each tick: the banner exists, but its rect changes on
      // resize / scroll.
      if (!banner) return;
      const rect = banner.getBoundingClientRect();
      setBounds({
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      });
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    // ResizeObserver covers cases where the banner's content reflows
    // without a window resize (e.g. fonts loading later).
    const obs = new ResizeObserver(measure);
    obs.observe(banner);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      obs.disconnect();
    };
  }, [enabled, mounted]);

  // Initial position: roughly half-way across the banner, centered
  // vertically. Recomputed only the first time bounds become known.
  useEffect(() => {
    if (!enabled) return;
    if (pos !== null) return;
    if (!bounds) return;
    const initialX = Math.min(
      Math.max(bounds.width * 0.55, SAFE_MARGIN_PX),
      bounds.width - SPRITE_SIZE_PX - SAFE_MARGIN_PX,
    );
    const initialY = Math.min(
      Math.max(bounds.height * 0.4, SAFE_MARGIN_PX),
      bounds.height - SPRITE_SIZE_PX - SAFE_MARGIN_PX,
    );
    setPos({ x: initialX, y: initialY });
  }, [enabled, bounds, pos]);

  // Idle-cycle ticker — paused while dragging.
  useEffect(() => {
    if (!enabled) return;
    if (dragging || throwing) return;
    let cancelled = false;
    let i = 0;
    let timeoutId: number | null = null;

    function tick() {
      if (cancelled) return;
      i = (i + 1) % IDLE_CYCLE.length;
      setState(IDLE_CYCLE[i]);
      const wait =
        IDLE_TICK_MIN_MS +
        Math.random() * (IDLE_TICK_MAX_MS - IDLE_TICK_MIN_MS);
      timeoutId = window.setTimeout(tick, wait);
    }

    timeoutId = window.setTimeout(tick, IDLE_TICK_MIN_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [enabled, dragging, throwing]);

  useEffect(() => {
    if (!enabled) {
      setBounds(null);
      setPos(null);
      setDragging(false);
      setThrowing(false);
      setShowHint(false);
      setState("idle");
    }
  }, [enabled]);

  const triggerReaction = useCallback(() => {
    cancelReactionTimeout();
    cancelTailTimeout();
    cancelThrow();
    setState((prev) => (prev === "waving" ? "jumping" : "waving"));
    reactionTimeoutRef.current = window.setTimeout(() => {
      reactionTimeoutRef.current = null;
      setState("idle");
    }, REACTION_MS);
  }, [cancelReactionTimeout, cancelTailTimeout, cancelThrow]);

  useEffect(() => {
    return () => {
      cancelThrow();
      cancelTailTimeout();
      cancelReactionTimeout();
    };
  }, [cancelReactionTimeout, cancelTailTimeout, cancelThrow]);

  // Drag handler. Window-level listeners + each drag re-arms cleanly.
  // Coordinates are stored in banner-relative space (x, y inside the
  // banner) so re-renders / page scrolls don't shift the visual.
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startBounds = bounds;
      const startPos = pos;
      if (!startBounds || !startPos) return;

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const originX = startPos.x;
      const originY = startPos.y;

      let moved = false;
      let lastX = startClientX;
      const samples: DragSample[] = [
        { time: event.timeStamp, x: originX, y: originY },
      ];

      cancelThrow();
      cancelTailTimeout();
      cancelReactionTimeout();

      setDragging(true);
      dismissHint();

      function handleMove(ev: PointerEvent) {
        if (ev.pointerId !== event.pointerId) return;
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
          moved = true;
        }
        if (!startBounds) return;
        const w = SPRITE_SIZE_PX;
        const h = SPRITE_SIZE_PX;
        const nextX = Math.min(
          Math.max(originX + dx, SAFE_MARGIN_PX),
          startBounds.width - w - SAFE_MARGIN_PX,
        );
        const nextY = Math.min(
          Math.max(originY + dy, SAFE_MARGIN_PX),
          startBounds.height - h - SAFE_MARGIN_PX,
        );
        updatePos({ x: nextX, y: nextY });

        samples.push({ time: ev.timeStamp, x: nextX, y: nextY });
        const sampleCutoff = ev.timeStamp - THROW_SAMPLE_WINDOW_MS;
        while (
          samples.length > THROW_SAMPLE_MAX ||
          samples[1]?.time < sampleCutoff
        ) {
          samples.shift();
        }

        const horizontal = ev.clientX - lastX;
        lastX = ev.clientX;
        if (horizontal > 1) setState("running-right");
        else if (horizontal < -1) setState("running-left");
      }

      function handleUp(ev: PointerEvent) {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        setDragging(false);
        if (!moved) {
          triggerReaction();
          return;
        }
        if (reducedMotionRef.current) {
          scheduleIdle();
          return;
        }

        const endTime = ev.timeStamp;
        const recentSamples = samples.filter(
          (sample) => endTime - sample.time <= THROW_SAMPLE_WINDOW_MS,
        );
        const velocitySamples =
          recentSamples.length > 1 ? recentSamples : samples;
        const firstSample = velocitySamples[0];
        const lastSample = velocitySamples[velocitySamples.length - 1];
        const dt = lastSample.time - firstSample.time;
        const releaseVelocity =
          dt > 0
            ? {
                vx: (lastSample.x - firstSample.x) / dt,
                vy: (lastSample.y - firstSample.y) / dt,
              }
            : { vx: 0, vy: 0 };

        if (
          Math.abs(releaseVelocity.vx) < THROW_MIN_VELOCITY &&
          Math.abs(releaseVelocity.vy) < THROW_MIN_VELOCITY
        ) {
          scheduleIdle();
          return;
        }

        throwRef.current.vx = releaseVelocity.vx;
        throwRef.current.vy = releaseVelocity.vy;
        setThrowing(true);

        let previousTime = performance.now();

        const step = (now: number) => {
          const currentBounds = boundsRef.current;
          const currentPos = posRef.current;
          if (!currentBounds || !currentPos) {
            cancelThrow();
            scheduleIdle();
            return;
          }

          const dtMs = Math.max(now - previousTime, 1);
          previousTime = now;

          let nextVx = throwRef.current.vx;
          let nextVy = throwRef.current.vy;
          const maxX = currentBounds.width - SPRITE_SIZE_PX - SAFE_MARGIN_PX;
          const maxY = currentBounds.height - SPRITE_SIZE_PX - SAFE_MARGIN_PX;

          const unclampedX = currentPos.x + nextVx * dtMs;
          const unclampedY = currentPos.y + nextVy * dtMs;

          const nextX = Math.min(Math.max(unclampedX, SAFE_MARGIN_PX), maxX);
          const nextY = Math.min(Math.max(unclampedY, SAFE_MARGIN_PX), maxY);

          if (nextX !== unclampedX) {
            nextVx *= THROW_BOUNCE_DAMPING;
          }
          if (nextY !== unclampedY) {
            nextVy *= THROW_BOUNCE_DAMPING;
          }

          updatePos({ x: nextX, y: nextY });

          if (nextVx > 0.01) setState("running-right");
          else if (nextVx < -0.01) setState("running-left");

          const friction = THROW_FRICTION_PER_FRAME ** (dtMs / (1000 / 60));
          nextVx *= friction;
          nextVy *= friction;

          throwRef.current.vx = nextVx;
          throwRef.current.vy = nextVy;

          if (
            Math.abs(nextVx) < THROW_MIN_VELOCITY &&
            Math.abs(nextVy) < THROW_MIN_VELOCITY
          ) {
            cancelThrow();
            scheduleIdle();
            return;
          }

          throwRef.current.rafId = window.requestAnimationFrame(step);
        };

        throwRef.current.rafId = window.requestAnimationFrame(step);
      }

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [
      bounds,
      cancelReactionTimeout,
      cancelTailTimeout,
      cancelThrow,
      pos,
      scheduleIdle,
      triggerReaction,
      updatePos,
    ],
  );

  // The anchor span is what gets rendered in the React tree where
  // <PetFloater /> is placed. It's invisible (size 0) and only exists
  // so we can find the closest .petdex-cloud ancestor and observe its
  // size.
  const anchor = (
    <span
      ref={anchorRef}
      aria-hidden="true"
      className="pointer-events-none absolute size-0"
    />
  );

  // The actual visible pet, portaled onto document.body. Position uses
  // page coordinates (bounds.left/top + pet's banner-relative x/y).
  const portalled = (() => {
    if (!enabled || !mounted || !bounds || !pos) return null;
    return createPortal(
      <button
        type="button"
        aria-label={`${petName} — drag, click, or just watch`}
        title={`${petName} — drag me, click me`}
        onPointerDown={onPointerDown}
        className={`absolute z-30 select-none rounded-3xl p-2 transition-transform ${
          dragging
            ? "cursor-grabbing"
            : "cursor-grab hover:scale-105 active:scale-95"
        }`}
        style={{
          left: bounds.left + pos.x,
          top: bounds.top + pos.y,
          transitionDuration: dragging || throwing ? "0ms" : "180ms",
          touchAction: "none",
        }}
      >
        {showHint ? (
          <>
            <span
              aria-hidden="true"
              className="pet-floater-hint-ring pointer-events-none absolute inset-0 rounded-3xl"
            />
            <span
              aria-hidden="true"
              className="pet-floater-hint-ring pet-floater-hint-ring--late pointer-events-none absolute inset-0 rounded-3xl"
            />
          </>
        ) : null}
        <PetSprite
          src={src}
          state={state}
          scale={0.55}
          label={`${petName} interactive sprite`}
        />
      </button>,
      document.body,
    );
  })();

  return (
    <>
      {anchor}
      {portalled}
    </>
  );
}
