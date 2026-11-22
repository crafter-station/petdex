import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { GithubIcon } from "@/components/brand/github-icon";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";

import { hasLocale } from "@/i18n/config";

const STEP_KEYS = ["open", "identify", "review", "remove"] as const;
const REPO = "crafter-station/petdex";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "takedownPage",
  });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
    alternates: buildLocaleAlternates(
      "/legal/takedown",
      hasLocale(locale) ? locale : undefined,
    ),
    robots: { index: true, follow: true },
  };
}

export default async function TakedownPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "takedownPage",
  });
  const issueUrl = `https://github.com/${REPO}/issues/new?template=takedown.yml`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pt-8 pb-12 md:px-8 md:pb-16">
        <header>
          <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
            {t("eyebrow")}
          </p>
          <h1 className="mt-4 font-heading text-4xl font-semibold tracking-tight md:text-5xl">
            {t("title")}
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-2">{t("intro")}</p>
        </header>

        <section className="toy-shell space-y-3 rounded-3xl p-6 md:p-8">
          <h2 className="font-heading text-lg font-semibold">
            {t("howItWorks")}
          </h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-2">
            {STEP_KEYS.map((key) => (
              <li key={key}>{t(`steps.${key}`)}</li>
            ))}
          </ol>
          <p className="pt-2 text-xs text-muted-3">
            {t("nonIpBefore")}{" "}
            <a
              href="mailto:railly@clerk.dev"
              className="underline underline-offset-4"
            >
              {t("emailLink")}
            </a>
            {t("nonIpAfter")}
          </p>
        </section>

        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(
            buttonVariants({ variant: "cobalt", size: "petdex-pill" }),
            "h-11 w-fit gap-2 px-5 text-sm",
          )}
        >
          <GithubIcon className="size-4" />
          {t("openRequest")}
        </a>

        <p className="border-t border-border-base pt-6 text-xs text-muted-3">
          {t("confirmation")}
        </p>
      </section>
      <SiteFooter />
    </main>
  );
}
