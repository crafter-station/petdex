import { buildLocaleAlternates } from "@/lib/locale-routing";

import { GithubIcon } from "@/components/github-icon";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  title: "Takedown — Petdex",
  description: "How to report a pet that infringes your rights.",
  alternates: buildLocaleAlternates("/legal/takedown"),
  robots: { index: true, follow: true },
};

const REPO = "crafter-station/petdex";

export default function TakedownPage() {
  const issueUrl = `https://github.com/${REPO}/issues/new?template=takedown.yml`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pt-8 pb-12 md:px-8 md:pb-16">
        <header>
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            Legal · Takedown
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            Report a pet
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-2">
            Petdex hosts user-submitted fan-art pixel pets. We don't claim
            rights to the underlying IP of any character a community member
            chose to interpret. If you're a rights holder (or authorized
            representative) and want a pet removed, the fastest path is a GitHub
            issue.
          </p>
        </header>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">How it works</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-2">
            <li>Open a takedown request via the link below.</li>
            <li>
              Tell us which pet (slug from the URL) and your relationship to the
              IP.
            </li>
            <li>
              We review manually. Typical response under 48 hours. Filings stay
              public on GitHub for transparency.
            </li>
            <li>
              Approved takedowns remove the pet from the gallery and installer
              endpoints.
            </li>
          </ol>
          <p className="pt-2 text-xs text-muted-3">
            Non-IP issues (broken sprite, wrong description, etc.) — please open
            a regular issue or contact us via{" "}
            <a
              href="mailto:railly@clerk.dev"
              className="underline underline-offset-4"
            >
              email
            </a>
            .
          </p>
        </section>

        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-12 w-fit items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          <GithubIcon className="size-4" />
          Open takedown request
        </a>

        <p className="border-t border-border-base pt-6 text-xs text-muted-3">
          By submitting to Petdex you confirm you have rights to the artwork or
          are creating fan content. Petdex acts on good-faith takedown requests.
        </p>
      </section>
      <SiteFooter />
    </main>
  );
}
