import Link from "next/link";

import {
  ArrowRight,
  Hammer,
  Package,
  Palette,
  Settings,
  Sparkles,
  Upload,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "create.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    // robots.txt disallows /create, and a disallowed URL is never crawled —
    // so the `index, follow` this page inherited from the root layout was
    // never read, and contradicted the disallow for anyone auditing the two
    // by hand. Say the same thing in both places.
    robots: { index: false, follow: false },
    alternates: buildLocaleAlternates(
      "/create",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("title"),
      description: t("description"),
      images: ["/og.png"],
    },
  };
}

export default async function CreatePage() {
  const t = await getTranslations("create");

  return (
    <>
      <SiteHeader />
      <main id="main" className="min-h-dvh bg-background text-foreground">
        <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
          <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 pb-12 md:px-8 md:pb-16">
            <header className="mt-6 max-w-3xl">
              <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                {t("eyebrow")}
              </p>
              <h1 className="mt-3 text-5xl leading-tight font-medium tracking-tight md:text-7xl">
                {t("title")}
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-2">
                {t.rich("body", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </header>

            <ol className="grid gap-4 md:grid-cols-2">
              <Step
                n={1}
                icon={<Package className="size-4" />}
                title={t("steps.install.title")}
              >
                <p>
                  {t.rich("steps.install.body", {
                    skills: (chunks) => (
                      <span className="font-mono">{chunks}</span>
                    ),
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </Step>

              <Step
                n={2}
                icon={<Hammer className="size-4" />}
                title={t("steps.hatch.title")}
              >
                <p>
                  {t("steps.hatch.beforeCommand")}{" "}
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                    /pet
                  </code>
                  {t("steps.hatch.afterCommand")}
                </p>
                <p className="text-xs text-muted-3">{t("steps.hatch.tip")}</p>
              </Step>

              <Step
                n={3}
                icon={<Settings className="size-4" />}
                title={t("steps.activate.title")}
              >
                <p>
                  {t("steps.activate.beforeSettings")}{" "}
                  <span className="font-mono">
                    {t("steps.activate.settingsPath")}
                  </span>{" "}
                  {t("steps.activate.middle")}{" "}
                  <strong>{t("steps.activate.select")}</strong>{" "}
                  {t("steps.activate.afterSelect")}{" "}
                  <span className="font-mono">
                    {t("steps.activate.customPets")}
                  </span>
                  .
                </p>
                <p className="text-xs text-muted-3">
                  {t("steps.activate.tipBefore")}{" "}
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                    /pet
                  </code>{" "}
                  {t("steps.activate.tipAfter")}
                </p>
              </Step>

              <Step
                n={4}
                icon={<Upload className="size-4" />}
                title={t("steps.share.title")}
              >
                <p>
                  {t("steps.share.beforePath")}{" "}
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                    ~/.codex/pets/&lt;name&gt;
                  </code>
                  {t("steps.share.beforeLink")}{" "}
                  <Link
                    href="/submit"
                    className="font-medium underline underline-offset-4 hover:text-foreground"
                  >
                    /submit
                  </Link>{" "}
                  {t("steps.share.afterLink")}
                </p>
              </Step>
            </ol>

            <div className="rounded-2xl border border-border-base bg-surface/60 p-5 backdrop-blur md:p-6">
              <h2 className="text-lg font-semibold tracking-tight">
                {t("guide.title")}
              </h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-2">
                <li>
                  <strong>{t("guide.items.specific.label")}</strong>{" "}
                  {t("guide.items.specific.body")}
                </li>
                <li>
                  <strong>{t("guide.items.twist.label")}</strong>{" "}
                  {t("guide.items.twist.body")}
                </li>
                <li>
                  <strong>{t("guide.items.vibe.label")}</strong>{" "}
                  {t("guide.items.vibe.body")}
                </li>
                <li>
                  <strong>{t("guide.items.ip.label")}</strong>{" "}
                  {t("guide.items.ip.body")}
                </li>
              </ul>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-base bg-surface/60 p-5 backdrop-blur">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("cards.submit.title")}
                  </p>
                  <p className="mt-1 text-sm text-muted-2">
                    {t("cards.submit.body")}
                  </p>
                </div>
                <Link
                  href="/submit"
                  className="btn-3d-inverse inline-flex h-10 items-center justify-center gap-2 rounded-full bg-inverse px-4 text-[13px] font-medium text-on-inverse transition hover:bg-inverse-hover"
                >
                  {t("cards.submit.cta")}
                  <ArrowRight className="size-4" />
                </Link>
              </div>

              {/* Steers users without Codex tokens (or who prefer the queue
              path) toward /requests so the catalog grows even from
              folks who can't run Hatch Pet themselves. */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-base bg-surface/60 p-5 backdrop-blur">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("cards.request.title")}
                  </p>
                  <p className="mt-1 text-sm text-muted-2">
                    {t("cards.request.body")}
                  </p>
                </div>
                <Link
                  href="/requests"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-4 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground"
                >
                  {t("cards.request.cta")}
                  <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>

            {/* Spoiler banner — coming-soon teaser for the in-browser pet
            studio. Brand-tinted so it reads as forward-looking, not as
            another action card. Kept below the request queue so it
            doesn't compete with the primary path (Hatch Pet via Codex). */}
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-brand/30 bg-brand/10 p-5 backdrop-blur">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-brand">
                  <Palette className="size-4" />
                </span>
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">
                    {t("creator.title")}
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-brand uppercase ring-1 ring-brand/25">
                      <Sparkles className="size-3" />
                      {t("creator.soon")}
                    </span>
                  </p>
                  <p className="mt-1 max-w-2xl text-sm text-muted-2">
                    {t("creator.body")}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <SiteFooter />
      </main>
    </>
  );
}

function Step({
  n,
  icon,
  title,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-border-base bg-surface/60 p-5 backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-inverse font-mono text-[11px] text-on-inverse">
          {n}
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight text-foreground">
          {icon}
          {title}
        </span>
      </div>
      <div className="space-y-2 text-sm leading-6 text-muted-2">{children}</div>
    </li>
  );
}
