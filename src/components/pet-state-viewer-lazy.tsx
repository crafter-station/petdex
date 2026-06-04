"use client";

import dynamic from "next/dynamic";

type PetStateViewerLazyProps = {
  src: string;
  petName: string;
};

const STATE_SKELETON_KEYS = [
  "idle",
  "walk",
  "run",
  "jump",
  "sleep",
  "happy",
  "sad",
  "attack",
  "special",
];

const PetStateViewerClient = dynamic(
  () =>
    import("@/components/pet-state-viewer").then((mod) => mod.PetStateViewer),
  {
    ssr: false,
    loading: PetStateViewerFallback,
  },
);

export function PetStateViewerLazy(props: PetStateViewerLazyProps) {
  return <PetStateViewerClient {...props} />;
}

function PetStateViewerFallback() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(280px,420px)_1fr]"
      aria-hidden="true"
    >
      <section className="rounded-lg border border-border-base bg-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-3">
            <div className="h-3 w-24 rounded bg-surface-muted" />
            <div className="h-7 w-36 rounded bg-surface-muted" />
          </div>
          <div className="h-9 w-24 rounded-md bg-surface-muted" />
        </div>
        <div className="pet-checkerboard mt-6 flex min-h-80 items-center justify-center rounded-lg border border-border-base">
          <div className="h-48 w-44 rounded-lg bg-surface-muted/70" />
        </div>
        <div className="mt-4 h-5 w-3/4 rounded bg-surface-muted" />
      </section>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {STATE_SKELETON_KEYS.map((key) => (
          <div
            key={key}
            className="h-[104px] rounded-lg border border-border-base bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="h-4 w-20 rounded bg-surface-muted" />
                <div className="h-3 w-24 rounded bg-surface-muted" />
              </div>
              <div className="size-14 rounded-md bg-surface-muted" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
