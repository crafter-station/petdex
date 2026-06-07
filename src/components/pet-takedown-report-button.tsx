"use client";

import { useState } from "react";

import { X as CloseIcon, Flag } from "lucide-react";
import { useTranslations } from "next-intl";

import { GithubIcon } from "@/components/github-icon";
import type { PetActionMenuPet } from "@/components/pet-action-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const TAKEDOWN_ISSUE_URL =
  "https://github.com/crafter-station/petdex/issues/new";

export function buildPetTakedownIssueUrl(pet: Pick<PetActionMenuPet, "slug">) {
  const params = new URLSearchParams({
    template: "takedown.yml",
    title: `[Takedown] ${pet.slug}`,
    "pet-slug": pet.slug,
  });

  return `${TAKEDOWN_ISSUE_URL}?${params.toString()}`;
}

export function PetTakedownReportButton({
  pet,
}: {
  pet: Pick<PetActionMenuPet, "slug" | "displayName">;
}) {
  const t = useTranslations("petActions");
  const [reportOpen, setReportOpen] = useState(false);
  const href = buildPetTakedownIssueUrl(pet);

  return (
    <Dialog open={reportOpen} onOpenChange={setReportOpen}>
      <button
        type="button"
        aria-label={t("reportTakedownAria", { name: pet.displayName })}
        onClick={() => {
          setReportOpen(true);
        }}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-chip-danger-fg/40 hover:text-chip-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chip-danger-fg/45"
      >
        <Flag className="size-4" />
        {t("reportTakedown")}
      </button>

      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(88dvh,44rem)] flex-col gap-4 overflow-y-auto rounded-2xl border border-border-base bg-popover p-4 text-popover-foreground shadow-2xl shadow-blue-950/20 sm:max-w-xl sm:gap-5 sm:p-5 lg:max-w-2xl"
      >
        <DialogClose
          render={
            <button
              type="button"
              aria-label={t("closeMenu")}
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-full text-muted-3 transition hover:bg-surface-muted hover:text-foreground"
            >
              <CloseIcon className="size-4" />
            </button>
          }
        />

        <header className="flex flex-col gap-3 pr-8">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("takedownDialog.eyebrow")}
          </p>
          <DialogTitle className="text-2xl leading-none font-semibold tracking-tight text-foreground sm:text-3xl">
            {t("takedownDialog.title")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-muted-2">
            {t("takedownDialog.body")}
          </DialogDescription>
        </header>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-4">
          <h3 className="text-base font-semibold text-foreground">
            {t("takedownDialog.howItWorks")}
          </h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-2">
            <li>{t("takedownDialog.step1")}</li>
            <li>{t("takedownDialog.step2")}</li>
            <li>{t("takedownDialog.step3")}</li>
            <li>{t("takedownDialog.step4")}</li>
          </ol>
          <p className="pt-1 text-xs leading-5 text-muted-3">
            {t("takedownDialog.nonIp")}
          </p>
        </section>

        <div className="rounded-xl bg-surface-muted px-3 py-2 text-xs text-muted-2">
          <span className="font-medium text-foreground">
            {t("takedownDialog.prefillLabel")}
          </span>{" "}
          <span className="font-mono">{pet.slug}</span>
        </div>

        <p className="border-t border-border-base pt-4 text-xs leading-5 text-muted-3">
          {t("takedownDialog.confirmation")}
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose
            render={
              <button
                type="button"
                className="inline-flex h-10 w-full items-center justify-center rounded-full px-4 text-sm font-medium text-muted-2 transition hover:bg-surface-muted hover:text-foreground sm:w-auto"
              >
                {t("takedownDialog.cancel")}
              </button>
            }
          />
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              setReportOpen(false);
            }}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover sm:w-auto"
          >
            <GithubIcon className="size-4" />
            {t("takedownDialog.openRequest")}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
