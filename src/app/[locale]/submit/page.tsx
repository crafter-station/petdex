import Link from "next/link";

import { ArrowRight, Hammer } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { FullAuthProviders } from "@/components/auth/auth-providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { PetSubmitForm } from "@/components/submit/pet-submit-form";
import { buttonVariants } from "@/components/ui/button";

import { hasLocale } from "@/i18n/config";

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
    alternates: buildLocaleAlternates(
      "/submit",
      hasLocale(locale) ? locale : undefined,
    ),
  };
}

export default async function SubmitPage() {
  const t = await getTranslations("submit");

  return (
    <FullAuthProviders>
      <main className="min-h-dvh bg-background">
        <SiteHeader hideSubmitCta />
        <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
          <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 pb-12 md:px-8 md:pb-16">
            <header className="mt-6 max-w-3xl">
              <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
                {t("eyebrow")}
              </p>
              <h1 className="mt-4 font-heading text-5xl leading-tight font-semibold tracking-tight text-foreground md:text-7xl">
                {t("title")}
              </h1>
              <p className="mt-6 text-lg leading-8 text-muted-2">{t("body")}</p>
              <Link
                href="/create"
                className={cn(
                  buttonVariants({ variant: "pearl", size: "petdex-pill" }),
                  "mt-5 gap-2",
                )}
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
    </FullAuthProviders>
  );
}
