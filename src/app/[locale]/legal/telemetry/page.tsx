import { buildLocaleAlternates } from "@/lib/locale-routing";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  title: "Telemetry — Petdex",
  description: "What petdex CLI telemetry collects and how to opt out.",
  alternates: buildLocaleAlternates("/legal/telemetry"),
  robots: { index: true, follow: true },
};

export default function TelemetryPrivacyPage() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pt-8 pb-12 md:px-8 md:pb-16">
        <header>
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            Legal · Telemetry
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            CLI telemetry
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-2">
            The petdex CLI collects anonymous usage statistics to help us
            understand install volume, supported platforms, and which coding
            agents people wire up. This page explains exactly what is collected
            and how to opt out.
          </p>
        </header>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">What we collect</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-base text-left font-mono text-xs text-muted-3">
                <th className="pb-2 pr-4">Field</th>
                <th className="pb-2 pr-4">Type</th>
                <th className="pb-2">Description</th>
              </tr>
            </thead>
            <tbody className="text-muted-2">
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">install_id</td>
                <td className="py-2 pr-4 font-mono text-xs">UUID v4</td>
                <td className="py-2">
                  Random ID generated on first run and stored at{" "}
                  <code className="font-mono text-xs">
                    ~/.petdex/telemetry.json
                  </code>
                  . Never linked to your account, email, or any other identity.
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">event</td>
                <td className="py-2 pr-4 font-mono text-xs">enum</td>
                <td className="py-2">
                  Which lifecycle step fired:{" "}
                  <code className="font-mono text-xs">
                    cli_install_desktop_success
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs">
                    cli_hooks_install_success
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs">
                    cli_desktop_start_success
                  </code>
                  , or{" "}
                  <code className="font-mono text-xs">
                    desktop_first_state_received
                  </code>{" "}
                  (the desktop sidecar emits this once per session when a hook
                  first reaches the mascot — it lets us measure how many
                  installs go all the way through the install, configure, and
                  run flow).
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">cli_version</td>
                <td className="py-2 pr-4 font-mono text-xs">semver</td>
                <td className="py-2">
                  Version of the petdex CLI package (e.g.{" "}
                  <code className="font-mono text-xs">0.1.4</code>).
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">binary_version</td>
                <td className="py-2 pr-4 font-mono text-xs">semver</td>
                <td className="py-2">
                  Version of the desktop binary that was installed (e.g.{" "}
                  <code className="font-mono text-xs">0.1.4</code>). Only sent
                  on{" "}
                  <code className="font-mono text-xs">
                    cli_install_desktop_success
                  </code>
                  .
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">os</td>
                <td className="py-2 pr-4 font-mono text-xs">enum</td>
                <td className="py-2">
                  Operating system:{" "}
                  <code className="font-mono text-xs">darwin</code>,{" "}
                  <code className="font-mono text-xs">linux</code>, or{" "}
                  <code className="font-mono text-xs">win32</code>.
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">arch</td>
                <td className="py-2 pr-4 font-mono text-xs">enum</td>
                <td className="py-2">
                  CPU architecture:{" "}
                  <code className="font-mono text-xs">arm64</code> or{" "}
                  <code className="font-mono text-xs">x64</code>.
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">agents</td>
                <td className="py-2 pr-4 font-mono text-xs">string[]</td>
                <td className="py-2">
                  Which coding agents were wired up during{" "}
                  <code className="font-mono text-xs">
                    petdex hooks install
                  </code>{" "}
                  (e.g.{" "}
                  <code className="font-mono text-xs">
                    ["claude-code", "codex"]
                  </code>
                  ). Only sent on the{" "}
                  <code className="font-mono text-xs">
                    cli_hooks_install_success
                  </code>{" "}
                  event.
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">state</td>
                <td className="py-2 pr-4 font-mono text-xs">enum</td>
                <td className="py-2">
                  Sprite animation state the first hook triggered (e.g.{" "}
                  <code className="font-mono text-xs">running</code>,{" "}
                  <code className="font-mono text-xs">idle</code>,{" "}
                  <code className="font-mono text-xs">waving</code>). Only sent
                  on{" "}
                  <code className="font-mono text-xs">
                    desktop_first_state_received
                  </code>
                  .
                </td>
              </tr>
              <tr className="border-b border-border-base/50">
                <td className="py-2 pr-4 font-mono text-xs">agent_source</td>
                <td className="py-2 pr-4 font-mono text-xs">string</td>
                <td className="py-2">
                  Optional self-reported label of the agent that fired the first
                  hook (e.g.{" "}
                  <code className="font-mono text-xs">claude-code</code>).
                  Capped at 64 characters and only sent on{" "}
                  <code className="font-mono text-xs">
                    desktop_first_state_received
                  </code>{" "}
                  if the hook command included it.
                </td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">country</td>
                <td className="py-2 pr-4 font-mono text-xs">string</td>
                <td className="py-2">
                  Two-letter ISO country code inferred from your IP by Vercel
                  edge infrastructure. The raw IP is never stored.
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">What we do not collect</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-2">
            <li>Email address, username, or any account identifier.</li>
            <li>
              File names, file contents, or any data from your project
              directory.
            </li>
            <li>
              Raw IP addresses. Only the country code inferred at the edge is
              stored.
            </li>
            <li>
              Crash reports, stack traces, or error messages from your local
              environment.
            </li>
            <li>Any data from the pets you install or submit.</li>
          </ul>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">How to opt out</h2>
          <p className="text-sm leading-6 text-muted-2">
            Telemetry is on by default but can be turned off at any time.
            Settings are stored at{" "}
            <code className="font-mono text-xs">~/.petdex/telemetry.json</code>{" "}
            and persist across CLI updates.
          </p>
          <div className="rounded-xl bg-background/60 px-4 py-3 font-mono text-sm">
            <p className="text-muted-3"># Disable telemetry</p>
            <p>petdex telemetry off</p>
            <p className="mt-2 text-muted-3"># Re-enable</p>
            <p>petdex telemetry on</p>
            <p className="mt-2 text-muted-3"># Check current status</p>
            <p>petdex telemetry status</p>
          </div>
          <p className="text-sm leading-6 text-muted-2">
            You can also set the environment variable{" "}
            <code className="font-mono text-xs">PETDEX_TELEMETRY=0</code> to
            disable telemetry for a single invocation or permanently in your
            shell profile.
          </p>
        </section>

        <section className="space-y-3 rounded-2xl border border-border-base bg-surface/76 p-6 backdrop-blur">
          <h2 className="text-lg font-semibold">Data retention</h2>
          <p className="text-sm leading-6 text-muted-2">
            Telemetry events are stored in a Postgres database hosted by Neon.
            Events older than 12 months may be deleted. No data is sold or
            shared with third parties.
          </p>
        </section>
      </section>
      <SiteFooter />
    </main>
  );
}
