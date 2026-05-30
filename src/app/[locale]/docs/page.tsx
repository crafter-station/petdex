import Link from "next/link";
import type React from "react";

import { ArrowRight, Check } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { CommandLine } from "@/components/command-line";
import { GithubIcon } from "@/components/github-icon";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

const NPM_URL = "https://www.npmjs.com/package/petdex";
const REPO_URL = "https://github.com/crafter-station/petdex";
const SKILL_URL = `${REPO_URL}/blob/main/.claude/skills/petdex/SKILL.md`;
const DOC_SECTIONS = [
  ["quick-start", "quickStart"],
  ["install", "install"],
  ["authenticate", "authenticate"],
  ["commands", "commands"],
  ["desktop", "desktop"],
  ["distribute", "distribute"],
  ["validation", "validation"],
  ["failure", "failure"],
  ["agents", "agentUsage"],
  ["config", "config"],
  ["contribute", "contribute"],
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "docsPage",
  });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
    alternates: buildLocaleAlternates(
      "/docs",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("metadata.ogTitle"),
      description: t("metadata.description"),
      images: ["/og.png"],
    },
  };
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const t = await getTranslations({
    locale: localeValue,
    namespace: "docsPage",
  });
  const placeholder = {
    desktopAction: "<start | stop | status>",
    path: t("placeholders.path"),
    petName: t("placeholders.petName"),
    yourPetName: t("placeholders.yourPetName"),
  };
  const rich = {
    code: (chunks: React.ReactNode) => <code>{chunks}</code>,
    em: (chunks: React.ReactNode) => <em>{chunks}</em>,
    strong: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
    ...placeholder,
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto grid w-full max-w-6xl gap-12 px-5 pt-8 pb-12 md:grid-cols-[220px_1fr] md:px-8 md:pb-16">
        <aside className="hidden md:block">
          <nav className="sticky top-24 flex flex-col gap-1.5 text-sm">
            <NavHeader>{t("nav.getStarted")}</NavHeader>
            {DOC_SECTIONS.slice(0, 3).map(([id, label]) => (
              <NavLink key={id} href={`#${id}`}>
                {t(`nav.${label}`)}
              </NavLink>
            ))}
            <NavHeader>{t("nav.cli")}</NavHeader>
            {DOC_SECTIONS.slice(3, 8).map(([id, label]) => (
              <NavLink key={id} href={`#${id}`}>
                {t(`nav.${label}`)}
              </NavLink>
            ))}
            <NavHeader>{t("nav.agents")}</NavHeader>
            <NavLink href="#agents">{t("nav.agentUsage")}</NavLink>
            <NavHeader>{t("nav.reference")}</NavHeader>
            {DOC_SECTIONS.slice(9).map(([id, label]) => (
              <NavLink key={id} href={`#${id}`}>
                {t(`nav.${label}`)}
              </NavLink>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 space-y-14">
          <header className="space-y-3">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("hero.eyebrow")}
            </p>
            <h1 className="text-5xl font-medium tracking-tight md:text-6xl">
              {t("hero.title")}
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-2">
              {t("hero.description")}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <a
                href={NPM_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium transition hover:border-border-strong"
              >
                {t("hero.npmCta")}
                <ArrowRight className="size-4" />
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium transition hover:border-border-strong"
              >
                <GithubIcon className="size-4" />
                {t("hero.repoCta")}
              </a>
            </div>
          </header>

          <Section id="quick-start" title={t("sections.quickStart.title")}>
            <p>{t("sections.quickStart.intro")}</p>
            <CommandLine
              command="npx petdex install boba"
              source="docs-quickstart"
              className="w-full max-w-xl"
            />
            <p>
              {t.rich("sections.quickStart.afterCommand", {
                code: (chunks) => <code>{chunks}</code>,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <Callout>
              {t.rich("sections.quickStart.callout", {
                code: (chunks) => <code>{chunks}</code>,
                link: (chunks) => (
                  <Link
                    href={withLocale("/create", localeValue)}
                    className="font-medium underline underline-offset-4"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </Callout>
          </Section>

          <Section id="install" title={t("sections.install.title")}>
            <p>{t("sections.install.intro")}</p>

            <h3 className="font-semibold">
              {t("sections.install.casualTitle")}
            </h3>
            <p>
              {t.rich("sections.install.casualBody", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
            <CommandLine
              command="npx petdex install boba"
              source="docs-install-npx"
              className="w-full max-w-xl"
            />

            <h3 className="font-semibold">
              {t("sections.install.powerTitle")}
            </h3>
            <p>{t("sections.install.powerBody")}</p>
            <CommandLine
              command="npm install -g petdex"
              source="docs-install-global"
              className="w-full max-w-xl"
            />

            <p>
              {t.rich("sections.install.persistence", {
                code: (chunks) => <code>{chunks}</code>,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </Section>

          <Section id="authenticate" title={t("sections.authenticate.title")}>
            <p>{t("sections.authenticate.intro")}</p>
            <CommandLine
              command="npx petdex login"
              source="docs-auth-login"
              className="w-full max-w-xl"
            />
            <p className="text-sm text-muted-2">
              {t.rich("sections.authenticate.flow", rich)}
            </p>
            <p>{t("sections.authenticate.otherCommands")}</p>
            <CommandLine
              command="npx petdex whoami"
              source="docs-auth-whoami"
              className="w-full max-w-xl"
            />
            <CommandLine
              command="npx petdex logout"
              source="docs-auth-logout"
              className="w-full max-w-xl"
            />
          </Section>

          <Section id="commands" title={t("sections.commands.title")}>
            <p>{t.rich("sections.commands.intro", rich)}</p>

            <h3 className="mt-6 font-semibold">
              <code>petdex list</code>
            </h3>
            <p>{t("sections.commands.listBody")}</p>
            <CommandLine
              command="npx petdex list"
              source="docs-cmd-list"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>{t("sections.commands.installSyntax", placeholder)}</code>
            </h3>
            <p>{t.rich("sections.commands.installBody", rich)}</p>
            <CommandLine
              command="npx petdex install kebo"
              source="docs-cmd-install"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>{t("sections.commands.submitSyntax", placeholder)}</code>
            </h3>
            <p>{t("sections.commands.submitIntro")}</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>{t.rich("sections.commands.submitSingle", rich)}</li>
              <li>{t.rich("sections.commands.submitZip", rich)}</li>
              <li>{t.rich("sections.commands.submitBulk", rich)}</li>
            </ul>
            <p>{t("sections.commands.bulkNote")}</p>

            <h3 className="mt-6 font-semibold">
              <code>petdex login / logout / whoami</code>
            </h3>
            <p>{t("sections.commands.authBody")}</p>
          </Section>

          <Section id="desktop" title={t("sections.desktop.title")}>
            <p>
              {t.rich("sections.desktop.intro", {
                ...rich,
                download: (chunks) => (
                  <Link
                    href={withLocale("/download", localeValue)}
                    className="font-medium underline underline-offset-4"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>

            <h3 className="mt-6 font-semibold">
              <code>petdex install desktop</code>
            </h3>
            <p>{t.rich("sections.desktop.installDesktopBody", rich)}</p>
            <CommandLine
              command="npx petdex install desktop"
              source="docs-desktop-install"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex hooks install</code>
            </h3>
            <p>{t("sections.desktop.hooksInstallBody")}</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>
                <strong>Claude Code</strong>:{" "}
                <code>~/.claude/settings.json</code>
              </li>
              <li>
                <strong>Codex CLI</strong>: <code>~/.codex/hooks.json</code>
              </li>
              <li>
                <strong>Gemini CLI</strong>:{" "}
                <code>~/.gemini/settings.json</code>
              </li>
              <li>
                <strong>OpenCode</strong>:{" "}
                <code>~/.config/opencode/plugins/petdex.js</code>
              </li>
            </ul>
            <p>{t.rich("sections.desktop.hookEvents", rich)}</p>
            <CommandLine
              command="npx petdex hooks install"
              source="docs-desktop-hooks"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex desktop &lt;start | stop | status&gt;</code>
            </h3>
            <p>{t.rich("sections.desktop.desktopManageBody", rich)}</p>
            <CommandLine
              command="npx petdex desktop start"
              source="docs-desktop-start"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex up / down / toggle</code>
            </h3>
            <p>{t.rich("sections.desktop.toggleBody", rich)}</p>
            <CommandLine
              command="npx petdex toggle"
              source="docs-desktop-toggle"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>/petdex</code> {t("sections.desktop.slashTitleSuffix")}
            </h3>
            <p>{t.rich("sections.desktop.slashBody", rich)}</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>{t.rich("sections.desktop.slashToggle", rich)}</li>
              <li>{t.rich("sections.desktop.slashUp", rich)}</li>
              <li>{t.rich("sections.desktop.slashDown", rich)}</li>
              <li>{t.rich("sections.desktop.slashStatus", rich)}</li>
              <li>{t.rich("sections.desktop.slashDoctor", rich)}</li>
            </ul>

            <h3 className="mt-6 font-semibold">
              <code>petdex hooks</code> {t("sections.desktop.killSwitchSuffix")}
            </h3>
            <p>{t.rich("sections.desktop.hooksKillBody", rich)}</p>
            <CommandLine
              command="npx petdex hooks toggle"
              source="docs-hooks-toggle"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex hooks uninstall</code>
            </h3>
            <p>{t.rich("sections.desktop.uninstallBody", rich)}</p>
            <CommandLine
              command="npx petdex hooks uninstall"
              source="docs-hooks-uninstall"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex doctor</code>
            </h3>
            <p>{t.rich("sections.desktop.doctorBody", rich)}</p>
            <CommandLine
              command="npx petdex doctor"
              source="docs-doctor"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex update</code>
            </h3>
            <p>{t.rich("sections.desktop.updateBody", rich)}</p>
            <CommandLine
              command="npx petdex update"
              source="docs-desktop-update"
              className="w-full max-w-xl"
            />

            <Callout>
              {t.rich("sections.desktop.sidecarCallout", rich)}
              <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-muted p-3 font-mono text-xs leading-relaxed">
                {[
                  `T="$(cat "$HOME/.petdex/runtime/update-token")"`,
                  `curl -X POST http://127.0.0.1:7777/state \\`,
                  `  -H "Content-Type: application/json" \\`,
                  `  -H "X-Petdex-Update-Token: $T" \\`,
                  `  --data-raw '{"state":"waving"}'`,
                ].join("\n")}
              </pre>
            </Callout>
          </Section>

          <Section id="distribute" title={t("sections.distribute.title")}>
            <p>{t("sections.distribute.intro")}</p>

            <ol className="ml-6 list-decimal space-y-3 text-muted-2">
              <li>
                {t.rich("sections.distribute.create", {
                  ...rich,
                  create: (chunks) => (
                    <Link
                      href={withLocale("/create", localeValue)}
                      className="font-medium underline underline-offset-4"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </li>
              <li>{t.rich("sections.distribute.signIn", rich)}</li>
              <li>{t.rich("sections.distribute.submit", rich)}</li>
              <li>{t.rich("sections.distribute.review", rich)}</li>
              <li>{t.rich("sections.distribute.install", rich)}</li>
            </ol>

            <Callout>
              {t.rich("sections.distribute.callout", {
                ...rich,
                takedown: (chunks) => (
                  <Link
                    href={withLocale("/legal/takedown", localeValue)}
                    className="font-medium underline underline-offset-4"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </Callout>
          </Section>

          <Section id="validation" title={t("sections.validation.title")}>
            <p>{t("sections.validation.intro")}</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>{t.rich("sections.validation.files", rich)}</li>
              <li>{t.rich("sections.validation.spritesheet", rich)}</li>
              <li>{t.rich("sections.validation.rateLimit", rich)}</li>
              <li>{t.rich("sections.validation.slugs", rich)}</li>
              <li>{t.rich("sections.validation.identity", rich)}</li>
            </ul>
          </Section>

          <Section id="failure" title={t("sections.failure.title")}>
            <div className="overflow-x-auto rounded-2xl border border-border-base bg-surface">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-b border-border-base bg-surface-muted">
                  <tr>
                    <Th>{t("sections.failure.headers.symptom")}</Th>
                    <Th>{t("sections.failure.headers.cause")}</Th>
                    <Th>{t("sections.failure.headers.fix")}</Th>
                  </tr>
                </thead>
                <tbody>
                  <Tr
                    sym={t("sections.failure.rows.notSignedIn.symptom")}
                    cause={t("sections.failure.rows.notSignedIn.cause")}
                    fix={<code>petdex login</code>}
                  />
                  <Tr
                    sym="presign 401"
                    cause={t("sections.failure.rows.presign401.cause")}
                    fix={
                      <>
                        <code>petdex logout</code> {t("sections.failure.then")}{" "}
                        <code>petdex login</code>
                      </>
                    }
                  />
                  <Tr
                    sym="presign 429"
                    cause={t("sections.failure.rows.presign429.cause")}
                    fix={
                      <>
                        {t("sections.failure.rows.presign429.fixBefore")}{" "}
                        <a
                          href={`${REPO_URL}/issues/new?labels=submit-fallback`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-4"
                        >
                          {t("sections.failure.rows.presign429.fixLink")}
                        </a>
                      </>
                    }
                  />
                  <Tr
                    sym="register 400 invalid_spritesheet"
                    cause={t("sections.failure.rows.invalidSpritesheet.cause")}
                    fix={t("sections.failure.rows.invalidSpritesheet.fix")}
                  />
                  <Tr
                    sym="register 400 missing_field"
                    cause={t("sections.failure.rows.missingField.cause")}
                    fix={t("sections.failure.rows.missingField.fix")}
                  />
                  <Tr
                    sym="R2 PUT 403"
                    cause={t("sections.failure.rows.r2Put403.cause")}
                    fix={t("sections.failure.rows.r2Put403.fix")}
                  />
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="agents" title={t("sections.agents.title")}>
            <p>{t.rich("sections.agents.intro", rich)}</p>

            <h3 className="mt-6 font-semibold">
              {t("sections.agents.enablesTitle")}
            </h3>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>{t.rich("sections.agents.enableCozy", rich)}</li>
              <li>{t.rich("sections.agents.enableShare", rich)}</li>
              <li>{t.rich("sections.agents.enableMake", rich)}</li>
            </ul>

            <h3 className="mt-6 font-semibold">
              {t("sections.agents.enableTitle")}
            </h3>
            <p>{t("sections.agents.enableIntro")}</p>
            <CommandLine
              command={`mkdir -p ~/.claude/skills/petdex && curl -sSf ${SKILL_URL.replace("/blob/", "/raw/")} -o ~/.claude/skills/petdex/SKILL.md`}
              source="docs-agents-install"
              className="w-full max-w-xl"
            />
            <p>{t.rich("sections.agents.enableOther", rich)}</p>

            <h3 className="mt-6 font-semibold">
              {t("sections.agents.buildTitle")}
            </h3>
            <p>{t("sections.agents.buildBody")}</p>
            <p>
              <a
                href={SKILL_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-medium underline underline-offset-4"
              >
                <GithubIcon className="size-4" />
                .claude/skills/petdex/SKILL.md
              </a>
            </p>
          </Section>

          <Section id="config" title={t("sections.config.title")}>
            <p>{t("sections.config.intro")}</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>{t.rich("sections.config.petdexUrl", rich)}</li>
              <li>{t.rich("sections.config.clerkIssuer", rich)}</li>
              <li>{t.rich("sections.config.clerkClientId", rich)}</li>
            </ul>
          </Section>

          <Section id="contribute" title={t("sections.contribute.title")}>
            <ul className="space-y-3 text-muted-2">
              <li className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-3" />
                <span>
                  {t("sections.contribute.prBefore")}{" "}
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    crafter-station/petdex
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-3" />
                <span>
                  {t("sections.contribute.issuesBefore")}{" "}
                  <a
                    href={`${REPO_URL}/issues`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {t("sections.contribute.issueLink")}
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-3" />
                <span>
                  {t("sections.contribute.sponsorBefore")}{" "}
                  <a
                    href="https://github.com/sponsors/Railly"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    GitHub Sponsors
                  </a>{" "}
                  {t("sections.contribute.sponsorAfter")}
                </span>
              </li>
            </ul>
          </Section>
        </article>
      </section>

      <SiteFooter />
    </main>
  );
}

function Tr({
  sym,
  cause,
  fix,
}: {
  sym: string;
  cause: string;
  fix: React.ReactNode;
}) {
  return (
    <tr className="border-b border-black/[0.06] last:border-b-0 dark:border-white/[0.06]">
      <td className="px-4 py-3 align-top font-mono text-xs text-rose-700 dark:text-rose-300">
        {sym}
      </td>
      <td className="px-4 py-3 align-top text-muted-2">{cause}</td>
      <td className="px-4 py-3 align-top text-foreground">{fix}</td>
    </tr>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-4 scroll-mt-24">
      <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
        {title}
      </h2>
      <div className="space-y-4 text-base leading-7 text-muted-2">
        {children}
      </div>
    </section>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-brand-light/40 bg-brand-tint p-4 text-sm leading-6 text-muted-2 dark:bg-brand-tint-dark">
      {children}
    </div>
  );
}

function NavHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase first:mt-0">
      {children}
    </p>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="rounded px-2 py-1 text-muted-2 transition hover:bg-white hover:text-foreground dark:hover:bg-stone-800"
    >
      {children}
    </a>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left font-mono text-[10px] tracking-[0.18em] text-muted-2 uppercase">
      {children}
    </th>
  );
}
