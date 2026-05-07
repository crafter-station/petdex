import Link from "next/link";

import { ArrowRight, Check } from "lucide-react";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { CommandLine } from "@/components/command-line";
import { GithubIcon } from "@/components/github-icon";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  title: "Docs · Petdex",
  description:
    "How to install, distribute, and automate Codex pets with the Petdex CLI.",
  alternates: buildLocaleAlternates("/docs"),
  openGraph: {
    title: "Petdex CLI · Docs",
    description:
      "How to install, distribute, and automate Codex pets with the Petdex CLI.",
    images: ["/og.png"],
  },
};

const NPM_URL = "https://www.npmjs.com/package/petdex";
const REPO_URL = "https://github.com/crafter-station/petdex";
const SKILL_URL = `${REPO_URL}/blob/main/.claude/skills/petdex/SKILL.md`;

export default function DocsPage() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto grid w-full max-w-6xl gap-12 px-5 pt-8 pb-12 md:grid-cols-[220px_1fr] md:px-8 md:pb-16">
        <aside className="hidden md:block">
          <nav className="sticky top-6 flex flex-col gap-1.5 text-sm">
            <NavHeader>Get started</NavHeader>
            <NavLink href="#quick-start">Quick start</NavLink>
            <NavLink href="#install">Install</NavLink>
            <NavLink href="#authenticate">Authenticate</NavLink>
            <NavHeader>CLI</NavHeader>
            <NavLink href="#commands">Commands</NavLink>
            <NavLink href="#distribute">Distribute pets</NavLink>
            <NavLink href="#validation">Validation</NavLink>
            <NavLink href="#failure">Failure modes</NavLink>
            <NavHeader>Agents</NavHeader>
            <NavLink href="#agents">Agent-first usage</NavLink>
            <NavHeader>Reference</NavHeader>
            <NavLink href="#config">Configuration</NavLink>
            <NavLink href="#contribute">Contribute</NavLink>
          </nav>
        </aside>

        <article className="min-w-0 space-y-14">
          <header className="space-y-3">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              Petdex CLI · v0.1
            </p>
            <h1 className="text-5xl font-medium tracking-tight md:text-6xl">
              Docs
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-2">
              The Petdex CLI lets you install, browse, and submit Codex pets
              from your terminal. Authentication is OAuth 2.0 + PKCE through
              Clerk. Tokens persist in your OS keychain. Same auth works across{" "}
              <code className="text-sm">npx</code> and global installs.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <a
                href={NPM_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium transition hover:border-border-strong"
              >
                npmjs.com/petdex
                <ArrowRight className="size-4" />
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium transition hover:border-border-strong"
              >
                <GithubIcon className="size-4" />
                Repo
              </a>
            </div>
          </header>

          <Section id="quick-start" title="Quick start">
            <p>
              Install a curated pet into your Codex setup with one command. No
              account required to install. Sign in only when you submit.
            </p>
            <CommandLine
              command="npx petdex install boba"
              source="docs-quickstart"
              className="w-full max-w-xl"
            />
            <p>
              The CLI fetches the pet pack and drops it into{" "}
              <code>~/.codex/pets/boba/</code>. To activate it inside Codex go
              to <strong>Settings → Appearance → Pets</strong> and click{" "}
              <strong>Select</strong>. Use <code>/pet</code> inside Codex to
              wake or tuck it away.
            </p>
            <Callout>
              Don't have a pet idea yet?{" "}
              <Link
                href="/create"
                className="font-medium underline underline-offset-4"
              >
                Hatch your own
              </Link>{" "}
              with the Codex Hatch Pet skill, then come back to{" "}
              <code>petdex submit</code>.
            </Callout>
          </Section>

          <Section id="install" title="Install">
            <p>
              The CLI runs on Node 18+ (or Bun). Pick the workflow that fits
              you. Both are equivalent in capability and persistence.
            </p>

            <h3 className="font-semibold">Casual / one-off</h3>
            <p>
              Use <code>npx</code>. No setup, package is cached after first run.
            </p>
            <CommandLine
              command="npx petdex install boba"
              source="docs-install-npx"
              className="w-full max-w-xl"
            />

            <h3 className="font-semibold">Power user</h3>
            <p>
              Install globally for instant invocation and easier muscle memory.
            </p>
            <CommandLine
              command="npm install -g petdex"
              source="docs-install-global"
              className="w-full max-w-xl"
            />

            <p>
              <strong>Auth persistence is identical in both.</strong> Tokens
              live in your OS keychain (macOS Keychain, Windows Credential
              Manager, Linux Secret Service) under the service name{" "}
              <code>petdex-cli</code>. Even if npx clears its package cache,
              your session survives.
            </p>
          </Section>

          <Section id="authenticate" title="Authenticate">
            <p>
              Sign in once, then any command that needs auth (e.g. submit) works
              seamlessly.
            </p>
            <CommandLine
              command="npx petdex login"
              source="docs-auth-login"
              className="w-full max-w-xl"
            />
            <p className="text-sm text-muted-2">
              The flow is OAuth 2.0 + PKCE: the CLI opens your browser, you sign
              in with Clerk on <code>accounts.petdex.crafter.run</code>, and the
              browser redirects to a one-shot localhost listener with the
              authorization code. The CLI exchanges it for a token set and
              stores it in the keychain. No secrets touch disk.
            </p>
            <p>Other auth commands:</p>
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

          <Section id="commands" title="Commands">
            <p>
              Six commands cover the full lifecycle, from discovery to
              publishing. All commands accept <code>--help</code>.
            </p>

            <h3 className="mt-6 font-semibold">
              <code>petdex list</code>
            </h3>
            <p>
              Print every approved pet with credit. Useful for discovery before
              installing.
            </p>
            <CommandLine
              command="npx petdex list"
              source="docs-cmd-list"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex install &lt;slug&gt;</code>
            </h3>
            <p>
              Drop a pet into <code>~/.codex/pets/&lt;slug&gt;/</code>.
              Equivalent to{" "}
              <code>
                curl -sSf https://petdex.crafter.run/install/&lt;slug&gt; | sh
              </code>
              .
            </p>
            <CommandLine
              command="npx petdex install kebo"
              source="docs-cmd-install"
              className="w-full max-w-xl"
            />

            <h3 className="mt-6 font-semibold">
              <code>petdex submit &lt;path&gt;</code>
            </h3>
            <p>
              Publish your pet(s) to the gallery. The CLI accepts three shapes:
            </p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>
                <strong>Single folder</strong>:{" "}
                <code>petdex submit ~/.codex/pets/boba</code>
              </li>
              <li>
                <strong>Single zip</strong>:{" "}
                <code>petdex submit ~/Downloads/boba.zip</code>
              </li>
              <li>
                <strong>Bulk</strong>: <code>petdex submit ~/.codex/pets</code>:
                every direct subfolder is treated as its own pet
              </li>
            </ul>
            <p>
              Bulk mode shows a progress spinner per pet and a final summary of
              failures. Slugs auto-deduplicate so you'll never get a "slug
              taken" rebote.
            </p>

            <h3 className="mt-6 font-semibold">
              <code>petdex login / logout / whoami</code>
            </h3>
            <p>See the Authenticate section above.</p>
          </Section>

          <Section id="distribute" title="Distribute your pets">
            <p>
              Once you've hatched a pet inside Codex, sharing it takes one
              command. Here's the full lifecycle:
            </p>

            <ol className="ml-6 list-decimal space-y-3 text-muted-2">
              <li>
                <strong>Create.</strong> In Codex Desktop, install the{" "}
                <strong>Hatch Pet</strong> skill and run <code>/pet</code>.
                Codex generates the spritesheet and pet.json into{" "}
                <code>~/.codex/pets/&lt;slug&gt;/</code>. Full tutorial at{" "}
                <Link
                  href="/create"
                  className="font-medium underline underline-offset-4"
                >
                  /create
                </Link>
                .
              </li>
              <li>
                <strong>Sign in.</strong> <code>npx petdex login</code> if you
                haven't.
              </li>
              <li>
                <strong>Submit.</strong>{" "}
                <code>npx petdex submit ~/.codex/pets/&lt;slug&gt;</code>. Or
                bulk all at once with the parent dir.
              </li>
              <li>
                <strong>Wait for review.</strong> Submissions land as "pending"
                in the admin queue. You'll receive a Resend email when approved
                or rejected (if rejected, the reason is included).
              </li>
              <li>
                <strong>Anyone can install your pet.</strong> Once approved,
                share <code>npx petdex install &lt;your-slug&gt;</code> with
                anyone . They get your pet in their <code>~/.codex/pets/</code>{" "}
                instantly.
              </li>
            </ol>

            <Callout>
              Pets are user-submitted fan art. Petdex doesn't claim rights to
              underlying IP. If you're a rights holder requesting a takedown,
              see{" "}
              <Link
                href="/legal/takedown"
                className="font-medium underline underline-offset-4"
              >
                /legal/takedown
              </Link>
              .
            </Callout>
          </Section>

          <Section id="validation" title="Validation rules">
            <p>The server enforces these rules; the CLI checks locally too.</p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>
                <code>pet.json</code> and <code>spritesheet.webp</code> (or{" "}
                <code>.png</code>) must be at the root of the folder/zip.
              </li>
              <li>
                Spritesheet ≥ 256×256. Recommended <strong>1536×1872</strong>{" "}
                (8×9 frame grid).
              </li>
              <li>
                Rate limit: <strong>10 submissions / 24h per user</strong>.
                Admins bypass.
              </li>
              <li>
                Slugs auto-deduplicate (<code>boba</code> → <code>boba-2</code>{" "}
                → <code>boba-3</code> → …). You always get a successful
                submission.
              </li>
              <li>
                Identity (userId, email, credit) comes from the verified OAuth
                token. Never trusted from request body.
              </li>
            </ul>
          </Section>

          <Section id="failure" title="Failure modes">
            <div className="overflow-x-auto rounded-2xl border border-border-base bg-surface">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-b border-border-base bg-surface-muted">
                  <tr>
                    <Th>Symptom</Th>
                    <Th>Cause</Th>
                    <Th>Fix</Th>
                  </tr>
                </thead>
                <tbody>
                  <Tr
                    sym="Not signed in"
                    cause="No tokens or session expired"
                    fix={<code>petdex login</code>}
                  />
                  <Tr
                    sym="presign 401"
                    cause="Bearer rejected by Clerk userinfo"
                    fix={
                      <>
                        <code>petdex logout</code> then{" "}
                        <code>petdex login</code>
                      </>
                    }
                  />
                  <Tr
                    sym="presign 429"
                    cause="10/24h rate limit hit"
                    fix={
                      <>
                        Wait 24h or open a{" "}
                        <a
                          href={`${REPO_URL}/issues/new?labels=submit-fallback`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-4"
                        >
                          submit-fallback issue
                        </a>
                      </>
                    }
                  />
                  <Tr
                    sym="register 400 invalid_spritesheet"
                    cause="Sprite < 256×256"
                    fix="Regenerate at 1536×1872"
                  />
                  <Tr
                    sym="register 400 missing_field"
                    cause="Folder missing pet.json or spritesheet"
                    fix="Inspect folder contents"
                  />
                  <Tr
                    sym="R2 PUT 403"
                    cause="Presigned URL expired (60s TTL)"
                    fix="Retry: CLI auto-presigns fresh URLs"
                  />
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="agents" title="Agent-first usage (Skill)">
            <p>
              Petdex ships a Claude Code / Codex / Cursor compatible{" "}
              <strong>skill</strong> at{" "}
              <code>.claude/skills/petdex/SKILL.md</code>. Compatible agents
              load it automatically and learn <em>when</em> and <em>how</em> to
              call the CLI on your behalf.
            </p>

            <h3 className="mt-6 font-semibold">What this enables</h3>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>
                Say <em>"install something cozy for my Codex"</em> in any agent
                tool. It runs <code>petdex list</code>, suggests Boba/Boxcat,
                installs your pick, and reminds you to activate via{" "}
                <strong>Settings → Appearance → Pets</strong>.
              </li>
              <li>
                Say <em>"share all my pets"</em>. Agent runs{" "}
                <code>petdex login</code> if needed, then{" "}
                <code>petdex submit ~/.codex/pets</code>, surfaces the bulk
                summary.
              </li>
              <li>
                Say <em>"how do I make my own?"</em>. Agent walks you through
                Codex Desktop → Hatch Pet skill → <code>/pet</code> →{" "}
                <code>petdex submit</code>.
              </li>
            </ul>

            <h3 className="mt-6 font-semibold">How to enable it</h3>
            <p>
              If you use Claude Code, save the skill globally so every project
              has it:
            </p>
            <CommandLine
              command={`mkdir -p ~/.claude/skills/petdex && curl -sSf ${SKILL_URL.replace("/blob/", "/raw/")} -o ~/.claude/skills/petdex/SKILL.md`}
              source="docs-agents-install"
              className="w-full max-w-xl"
            />
            <p>
              Other agent tools can load the same SKILL.md from the repo. The
              file is plain markdown with. No agent-specific syntax beyond{" "}
              <code>allowed-tools</code>.
            </p>

            <h3 className="mt-6 font-semibold">Build your own skill on top</h3>
            <p>
              The CLI is the executable surface; the skill is the cognitive one.
              If you build a derivative skill (e.g. one that auto-tags new pets
              or curates a daily digest), you can use the Petdex skill as a
              reference. Read it directly:
            </p>
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

          <Section id="config" title="Configuration">
            <p>
              The CLI ships with sensible defaults pointing at production. You
              only need to override env vars if you're testing against a
              non-production deployment.
            </p>
            <ul className="ml-6 list-disc space-y-1 text-muted-2">
              <li>
                <code>PETDEX_URL</code>: base URL, default{" "}
                <code>https://petdex.crafter.run</code>
              </li>
              <li>
                <code>CLERK_ISSUER</code>: OAuth issuer, default{" "}
                <code>https://clerk.petdex.crafter.run</code>
              </li>
              <li>
                <code>CLERK_OAUTH_CLIENT_ID</code>: public client id (baked into
                the CLI binary)
              </li>
            </ul>
          </Section>

          <Section id="contribute" title="Contribute">
            <ul className="space-y-3 text-muted-2">
              <li className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-3" />
                <span>
                  PRs welcome at{" "}
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
                  Bug reports and feature requests:{" "}
                  <a
                    href={`${REPO_URL}/issues`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    open an issue
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-muted-3" />
                <span>
                  Sponsor on{" "}
                  <a
                    href="https://github.com/sponsors/Railly"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    GitHub Sponsors
                  </a>{" "}
                  if Petdex saves you time.
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left font-mono text-[10px] tracking-[0.18em] text-muted-2 uppercase">
      {children}
    </th>
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
