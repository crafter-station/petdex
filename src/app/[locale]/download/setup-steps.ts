/**
 * Setup-step list for the /download page.
 *
 * Extracted from page.tsx so the dynamic numbering and the pending-pet
 * insertion can be unit-tested without standing up a full RSC render.
 *
 * The order is the order the CLI actually wants:
 *   1. install desktop binary
 *   1.5 install <pendingPet>   (only when ?next=install/<slug>)
 *   2. hooks install
 *   3. desktop start
 *   4. update
 *
 * `installPet` slots BETWEEN binary install and hooks install on
 * purpose: petdex must already exist before `install <slug>` resolves
 * its asset path, but the new pet must be on disk before the desktop
 * boots in step 3 — otherwise the "Open in Petdex" CTA from /pets/<slug>
 * lands on a desktop that doesn't have the pet the user picked.
 */

export type SetupStep = {
  key: string;
  title: string;
  command: string;
  hint?: string;
  dimmed?: boolean;
};

type Translator = (key: string, values?: Record<string, string>) => string;

export function parsePendingPet(
  next: string | string[] | undefined,
): string | null {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value || !value.startsWith("install/")) return null;
  const slug = value.slice("install/".length);
  // Mirror the server slug regex so a malformed ?next= can't render anything.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
  return slug;
}

export function buildSetupSteps(
  t: Translator,
  pendingPet: string | null,
): SetupStep[] {
  const steps: SetupStep[] = [
    {
      key: "step1",
      title: t("setup.step1.title"),
      command: "npx petdex install desktop",
    },
  ];

  if (pendingPet) {
    steps.push({
      key: "installPet",
      title: t("setup.installPet.title", { slug: pendingPet }),
      command: `npx petdex install ${pendingPet}`,
      hint: t("setup.installPet.hint"),
    });
  }

  steps.push(
    {
      key: "step2",
      title: t("setup.step2.title"),
      command: "npx petdex hooks install",
      hint: t("setup.step2.hint"),
    },
    {
      // step3 is the wake step. `petdex up` is one-shot:
      // enables hooks + launches the desktop. Same end-state as
      // `desktop start`, but symmetric with `down` and matches
      // what /petdex toggles to from inside an agent.
      key: "step3",
      title: t("setup.step3.title"),
      command: "npx petdex up",
    },
    {
      key: "step4",
      title: t("setup.step4.title"),
      command: "npx petdex update",
      hint: t("setup.step4.hint"),
      dimmed: true,
    },
  );

  return steps;
}
