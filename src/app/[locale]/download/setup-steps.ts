/**
 * Setup-step list for the /download page.
 *
 * Now that Petdex.app ships as a signed + notarized .dmg and the CLI
 * resolves the binary from /Applications automatically, the install
 * flow collapses to a single command:
 *
 *   1. (already done) Drag Petdex.app to /Applications via the .dmg
 *   2. `npx petdex@latest init`   ← wires hooks + wakes the mascot
 *   *. `npx petdex@latest install <slug>` (optional, when /pets/<slug>
 *       sent the user here with ?next=install/<slug>)
 *   *. `npx petdex@latest update` (dimmed, runs anytime)
 *
 * `init` is the canonical first command. It runs `hooks install` (the
 * agent picker wizard) and then `up` (toggles the killswitch off and
 * launches the desktop), so there's no install-binary / wire-hooks /
 * launch-mascot ceremony anymore.
 */

export type SetupStep = {
  key: string;
  title: string;
  command: string;
  hint?: string;
  dimmed?: boolean;
};

type Translator = (key: string, values?: Record<string, string>) => string;

const INSTALL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Parses `?next=install/<slug>` or `?next=install/a,b,c` for the download page. */
export function parsePendingInstallSlugs(
  next: string | string[] | undefined,
): string[] | null {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value?.startsWith("install/")) return null;
  const rest = value.slice("install/".length);
  if (!rest) return null;
  const slugs = rest
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (slugs.length === 0) return null;
  for (const slug of slugs) {
    if (!INSTALL_SLUG_RE.test(slug)) return null;
  }
  return slugs;
}

export function parsePendingPet(
  next: string | string[] | undefined,
): string | null {
  return parsePendingInstallSlugs(next)?.[0] ?? null;
}

export function buildSetupSteps(
  t: Translator,
  pendingInstallSlugs: string[] | null,
): SetupStep[] {
  const steps: SetupStep[] = [
    {
      key: "step1",
      title: t("setup.step1.title"),
      command: "npx petdex init",
      hint: t("setup.step1.hint"),
    },
  ];

  if (pendingInstallSlugs && pendingInstallSlugs.length > 0) {
    const installCommand = `npx petdex install ${pendingInstallSlugs.join(" ")}`;
    steps.push({
      key: "installPet",
      title:
        pendingInstallSlugs.length === 1
          ? t("setup.installPet.title", { slug: pendingInstallSlugs[0] })
          : t("setup.installPets.title", {
              count: String(pendingInstallSlugs.length),
            }),
      command: installCommand,
      hint:
        pendingInstallSlugs.length === 1
          ? t("setup.installPet.hint")
          : t("setup.installPets.hint"),
    });
  }

  steps.push({
    key: "stayUpdated",
    title: t("setup.stayUpdated.title"),
    command: "npx petdex update",
    hint: t("setup.stayUpdated.hint"),
    dimmed: true,
  });

  return steps;
}
