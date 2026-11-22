import { getTranslations } from "next-intl/server";

import { findByToken } from "@/lib/email-preferences";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";
import { UnsubscribeForm } from "./unsubscribe-form";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "unsubscribePage",
  });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
    alternates: buildLocaleAlternates(
      "/unsubscribe",
      hasLocale(locale) ? locale : undefined,
    ),
    robots: { index: false, follow: false },
  };
}

type SearchParams = Promise<{ token?: string }>;

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "unsubscribePage",
  });
  const { token } = await searchParams;
  const pref = token ? await findByToken(token) : null;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 pt-8 pb-12 md:px-8 md:pb-16">
        <header>
          <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
            {t("eyebrow")}
          </p>
          <h1 className="mt-4 font-heading text-3xl font-semibold tracking-tight md:text-4xl">
            {t("title")}
          </h1>
        </header>

        {pref ? (
          <UnsubscribeForm
            token={pref.unsubscribeToken}
            email={pref.email}
            initiallyUnsubscribed={pref.unsubscribedMarketing}
          />
        ) : (
          <div className="toy-shell space-y-3 rounded-3xl p-6 md:p-8">
            <p className="font-heading text-base font-semibold">
              {t("invalidTitle")}
            </p>
            <p className="text-sm leading-6 text-muted-2">{t("invalidBody")}</p>
          </div>
        )}
      </section>
    </main>
  );
}
