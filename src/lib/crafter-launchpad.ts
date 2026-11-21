export interface CrafterLaunchpadApp {
  id: string;
  name: string;
  tagline: string;
  url: string;
  badge: string;
  active: boolean;
  crossPetSlug?: string;
}

export const LAUNCHPAD_DISMISS_PREFIX = "petdex:launchpad:dismissed:";

export const CRAFTER_LAUNCHPAD_APPS: readonly CrafterLaunchpadApp[] = [
  {
    id: "crafter-run",
    name: "Crafter Station",
    tagline:
      "Open-source developer tools, AI apps, and playful software crafted in Peru.",
    url: "https://crafter.run",
    badge: "Ecosystem",
    active: true,
    crossPetSlug: "boba",
  },
  {
    id: "ojito",
    name: "Ojito",
    tagline: "Visual craft and developer tooling by Crafter Station.",
    url: "https://ojito.dev",
    badge: "Crafter App",
    active: true,
    crossPetSlug: "mallow",
  },
  {
    id: "muelle",
    name: "Muelle",
    tagline: "Workspace and creative studio tooling built at Crafter Station.",
    url: "https://muelle.crafter.run",
    badge: "Crafter App",
    active: true,
  },
  {
    id: "maca",
    name: "Maca",
    tagline: "Fast developer shell workflows by Crafter Station.",
    url: "https://maca.sh",
    badge: "CLI",
    active: true,
  },
  {
    id: "hack0",
    name: "hack0",
    tagline:
      "Discover, organize, and ship at hackathons across Latin America and beyond.",
    url: "https://hack0.dev",
    badge: "Hackathons",
    active: true,
  },
] as const;

export function getActiveLaunchpadDrops(
  apps: readonly CrafterLaunchpadApp[] = CRAFTER_LAUNCHPAD_APPS,
): CrafterLaunchpadApp[] {
  return apps.filter((app) => app.active);
}

export function getFeaturedLaunchpadDrop(
  apps: readonly CrafterLaunchpadApp[] = CRAFTER_LAUNCHPAD_APPS,
): CrafterLaunchpadApp | null {
  return getActiveLaunchpadDrops(apps)[0] ?? null;
}

export function getLaunchpadDismissKey(id: string): string {
  return `${LAUNCHPAD_DISMISS_PREFIX}${id}`;
}
