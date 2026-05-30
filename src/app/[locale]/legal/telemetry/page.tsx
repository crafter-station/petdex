import type React from "react";

import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

const FIELD_ROWS = [
  ["install_id", "UUID v4", "installId"],
  ["event", "enum", "event"],
  ["cli_version", "semver", "cliVersion"],
  ["binary_version", "semver", "binaryVersion"],
  ["os", "enum", "os"],
  ["arch", "enum", "arch"],
  ["agents", "string[]", "agents"],
  ["state", "enum", "state"],
  ["agent_source", "string", "agentSource"],
  ["country", "string", "country"],
] as const;
const NOT_COLLECT_KEYS = ["email", "files", "ip", "crashes", "pets"] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "telemetryPage",
  });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
    alternates: buildLocaleAlternates(
      "/legal/telemetry",
      hasLocale(locale) ? locale : undefined,
    ),
    robots: { index: true, follow: true },
  };
}

export default async function TelemetryPrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "telemetryPage",
  });
  const rich = {
    code: (chunks: React.ReactNode) => (
      <code className="font-mono text-xs">{chunks}</code>
    ),
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pt-8 pb-12 md:px-8 md:pb-16">
        <header>
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            {t("title")}
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-2">{t("intro")}</p>
        </header>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">{t("collectTitle")}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-base text-left font-mono text-xs text-muted-3">
                <th className="pb-2 pr-4">{t("table.field")}</th>
                <th className="pb-2 pr-4">{t("table.type")}</th>
                <th className="pb-2">{t("table.description")}</th>
              </tr>
            </thead>
            <tbody className="text-muted-2">
              {FIELD_ROWS.map(([field, type, key], index) => (
                <tr
                  key={field}
                  className={
                    index === FIELD_ROWS.length - 1
                      ? undefined
                      : "border-b border-border-base/50"
                  }
                >
                  <td className="py-2 pr-4 font-mono text-xs">{field}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{type}</td>
                  <td className="py-2">{t.rich(`fields.${key}`, rich)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">{t("notCollectTitle")}</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-2">
            {NOT_COLLECT_KEYS.map((key) => (
              <li key={key}>{t(`notCollect.${key}`)}</li>
            ))}
          </ul>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">{t("optOutTitle")}</h2>
          <p className="text-sm leading-6 text-muted-2">
            {t.rich("optOutIntro", rich)}
          </p>
          <div className="rounded-xl bg-background/60 px-4 py-3 font-mono text-sm">
            <p className="text-muted-3">{t("codeComments.disable")}</p>
            <p>petdex telemetry off</p>
            <p className="mt-2 text-muted-3">{t("codeComments.enable")}</p>
            <p>petdex telemetry on</p>
            <p className="mt-2 text-muted-3">{t("codeComments.status")}</p>
            <p>petdex telemetry status</p>
          </div>
          <p className="text-sm leading-6 text-muted-2">
            {t.rich("optOutEnv", rich)}
          </p>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">{t("retentionTitle")}</h2>
          <p className="text-sm leading-6 text-muted-2">{t("retentionBody")}</p>
        </section>
      </section>
      <SiteFooter />
    </main>
  );
}
