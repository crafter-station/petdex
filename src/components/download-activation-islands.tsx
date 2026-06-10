"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Sparkles } from "lucide-react";

import { CommandLine } from "@/components/command-line";
import { DownloadCTA } from "@/components/download-cta";

import {
  buildSetupSteps,
  parsePendingInstallSlugs,
} from "@/app/[locale]/download/setup-steps";

type HeroLabels = {
  primaryLabel: string;
  cliSubtext: string;
  manualLabel: string;
  manualSubtext: string;
  comingSoonLabel: string;
  desktopOnlyLabel: string;
  pendingBefore: string;
  pendingAfter: string;
};

type SetupLabels = {
  step1Title: string;
  step1Hint: string;
  installPetTitle: string;
  installPetHint: string;
  installPetsTitle: string;
  installPetsHint: string;
  stayUpdatedTitle: string;
  stayUpdatedHint: string;
};

export function DownloadHeroActions({ labels }: { labels: HeroLabels }) {
  return (
    <Suspense fallback={<DownloadHeroActionsContent labels={labels} />}>
      <DownloadHeroActionsInner labels={labels} />
    </Suspense>
  );
}

function DownloadHeroActionsInner({ labels }: { labels: HeroLabels }) {
  return (
    <DownloadHeroActionsContent
      labels={labels}
      pendingInstallSlugs={usePendingInstallSlugs()}
    />
  );
}

function DownloadHeroActionsContent({
  labels,
  pendingInstallSlugs,
}: {
  labels: HeroLabels;
  pendingInstallSlugs?: string[] | null;
}) {
  const pendingLabel = formatPendingLabel(pendingInstallSlugs);
  const activationCommand = pendingInstallSlugs?.length
    ? `npx petdex init && npx petdex install ${pendingInstallSlugs.join(" ")}`
    : "npx petdex init";

  return (
    <>
      {pendingLabel ? (
        <div className="mt-6 inline-flex max-w-full items-center gap-2 rounded-lg border border-brand/20 bg-brand-tint px-3 py-2 text-sm text-brand-deep dark:bg-brand-tint-dark dark:text-brand-light">
          <Sparkles className="size-4 shrink-0" />
          <span className="min-w-0">
            {labels.pendingBefore}{" "}
            <code className="rounded bg-surface/80 px-1.5 py-0.5 font-mono text-xs">
              {pendingLabel}
            </code>{" "}
            {labels.pendingAfter}
          </span>
        </div>
      ) : null}

      <DownloadCTA
        primaryLabel={labels.primaryLabel}
        cliCommand={activationCommand}
        cliSubtext={labels.cliSubtext}
        manualLabel={labels.manualLabel}
        manualSubtext={labels.manualSubtext}
        comingSoonLabel={labels.comingSoonLabel}
        desktopOnlyLabel={labels.desktopOnlyLabel}
      />
    </>
  );
}

export function DownloadSetupSteps({ labels }: { labels: SetupLabels }) {
  return (
    <Suspense fallback={<DownloadSetupStepsContent labels={labels} />}>
      <DownloadSetupStepsInner labels={labels} />
    </Suspense>
  );
}

function DownloadSetupStepsInner({ labels }: { labels: SetupLabels }) {
  return (
    <DownloadSetupStepsContent
      labels={labels}
      pendingInstallSlugs={usePendingInstallSlugs()}
    />
  );
}

function DownloadSetupStepsContent({
  labels,
  pendingInstallSlugs,
}: {
  labels: SetupLabels;
  pendingInstallSlugs?: string[] | null;
}) {
  return (
    <ol className="mt-10 flex flex-col gap-8">
      {buildSetupSteps(
        makeSetupTranslator(labels),
        pendingInstallSlugs ?? null,
      ).map((step, idx) => {
        const number = idx + 1;
        const dotClass = step.dimmed
          ? "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface font-mono text-xs font-semibold text-muted-2 ring-1 ring-border-base"
          : "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand font-mono text-xs font-semibold text-on-inverse";
        return (
          <li key={step.key} className="flex gap-5">
            <span className={dotClass}>{number}</span>
            <div className="flex flex-col gap-2">
              <p className="font-semibold text-foreground">{step.title}</p>
              <CommandLine
                command={step.command}
                source={`download-${step.key}`}
                className="w-full max-w-sm"
              />
              {step.hint ? (
                <p className="text-xs text-muted-3">{step.hint}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function usePendingInstallSlugs() {
  const searchParams = useSearchParams();
  const all = searchParams.getAll("next");
  return parsePendingInstallSlugs(
    all.length > 1 ? all : (searchParams.get("next") ?? undefined),
  );
}

function formatPendingLabel(pendingInstallSlugs?: string[] | null) {
  if (!pendingInstallSlugs?.length) return null;
  return pendingInstallSlugs.length === 1
    ? pendingInstallSlugs[0]
    : pendingInstallSlugs.join(", ");
}

function makeSetupTranslator(labels: SetupLabels) {
  return (key: string, values?: Record<string, string>) => {
    const text =
      key === "setup.step1.title"
        ? labels.step1Title
        : key === "setup.step1.hint"
          ? labels.step1Hint
          : key === "setup.installPet.title"
            ? labels.installPetTitle
            : key === "setup.installPet.hint"
              ? labels.installPetHint
              : key === "setup.installPets.title"
                ? labels.installPetsTitle
                : key === "setup.installPets.hint"
                  ? labels.installPetsHint
                  : key === "setup.stayUpdated.title"
                    ? labels.stayUpdatedTitle
                    : key === "setup.stayUpdated.hint"
                      ? labels.stayUpdatedHint
                      : key;
    return formatTemplate(text, values);
  };
}

function formatTemplate(text: string, values?: Record<string, string>) {
  if (!values) return text;
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{${key}}`, value),
    text,
  );
}
