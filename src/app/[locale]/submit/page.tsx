import Link from "next/link";

import { ArrowRight, Hammer } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { PetSubmitForm } from "@/components/pet-submit-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "submit.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/submit"),
  };
}

export default async function SubmitPage() {
  const t = await getTranslations("submit");

  return (
    <main className="min-h-dvh bg-background">
      <SiteHeader hideSubmitCta />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 pb-12 md:px-8 md:pb-16">
        <header className="max-w-3xl">
          <p className="text-sm font-medium text-brand-light">{t("eyebrow")}</p>
          <h1 className="mt-4 text-5xl leading-tight font-medium tracking-normal text-foreground md:text-7xl">
            {t("title")}
          </h1>
          <p className="mt-6 text-lg leading-8 text-muted-2">
            {t("body")}
          </p>
          <Link
            href="/create"
            className="mt-5 inline-flex items-center gap-2 rounded-full border border-border-base bg-surface/70 px-4 py-2 text-sm font-medium text-muted-2 backdrop-blur transition hover:bg-white hover:text-foreground dark:hover:bg-stone-800"
          >
            <Hammer className="size-4" />
            {t("createCta")}
            <ArrowRight className="size-4" />
          </Link>
        </header>

        <PetSubmitForm />

        <p className="max-w-3xl text-xs leading-5 text-muted-3">
          {t("legalPrefix")}{" "}
          <Link
            href="/legal/takedown"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {t("legalLink")}
          </Link>
          {t("legalSuffix")}
        </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
