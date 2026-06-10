"use client";

import dynamic from "next/dynamic";

type InstallCommandLazyProps = {
  slug: string;
  displayName: string;
};

const InstallCommandClient = dynamic(
  () =>
    import("@/components/install-command").then((mod) => mod.InstallCommand),
  {
    ssr: false,
    loading: InstallCommandFallback,
  },
);

export function InstallCommandLazy(props: InstallCommandLazyProps) {
  return <InstallCommandClient {...props} />;
}

function InstallCommandFallback() {
  return (
    <div className="rounded-2xl border border-border-base bg-surface/80 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="h-5 w-32 rounded bg-surface-muted" />
        <div className="h-8 w-28 rounded-full bg-surface-muted" />
      </div>
      <div className="mt-3 h-4 w-3/4 rounded bg-surface-muted" />
      <div className="mt-3 h-8 w-36 rounded-full bg-surface-muted" />
      <div className="mt-2 h-12 w-full rounded-2xl bg-surface-muted" />
      <div className="mt-3 rounded-2xl border border-border-base bg-surface-muted/70 px-4 py-3">
        <div className="h-4 w-28 rounded bg-surface" />
        <div className="mt-3 space-y-2">
          <div className="h-3 w-full rounded bg-surface" />
          <div className="h-3 w-5/6 rounded bg-surface" />
          <div className="h-3 w-2/3 rounded bg-surface" />
        </div>
      </div>
      <div className="mt-5 h-5 w-36 rounded bg-surface-muted" />
      <div className="mt-3 space-y-2">
        <div className="h-3 w-full rounded bg-surface-muted" />
        <div className="h-3 w-11/12 rounded bg-surface-muted" />
        <div className="h-3 w-3/4 rounded bg-surface-muted" />
      </div>
    </div>
  );
}
