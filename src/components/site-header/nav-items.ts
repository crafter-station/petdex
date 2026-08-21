import type { HeaderNavItem } from "@/components/site-header/types";

const GITHUB_REPO_URL = "https://github.com/crafter-station/petdex";

type HeaderNavLabels = {
  collections: string;
  reactions: string;
  creators: string;
  requests: string;
  download: string;
  docs: string;
  create: string;
  builtWith: string;
  community: string;
  github: string;
  githubRepoAria: string;
};

export function buildHeaderNav(
  href: (pathname: string) => string,
  labels: HeaderNavLabels,
  reactionsEnabled = false,
) {
  const primary: HeaderNavItem[] = [
    { href: href("/collections"), label: labels.collections },
    ...(reactionsEnabled
      ? [{ href: href("/stickers/claude"), label: labels.reactions }]
      : []),
    { href: href("/leaderboard"), label: labels.creators },
    { href: href("/requests"), label: labels.requests },
    { href: href("/download"), label: labels.download },
    { href: href("/docs"), label: labels.docs },
  ];

  const secondary: HeaderNavItem[] = [
    { href: href("/create"), label: labels.create },
    { href: href("/built-with"), label: labels.builtWith },
    ...(process.env.NEXT_PUBLIC_DISCORD_INVITE_URL
      ? [{ href: href("/community"), label: labels.community }]
      : []),
  ];

  const githubItem: HeaderNavItem = {
    href: GITHUB_REPO_URL,
    label: labels.github,
    external: true,
    ariaLabel: labels.githubRepoAria,
  };

  return {
    primary,
    secondary,
    allNav: [...primary, ...secondary] as HeaderNavItem[],
    githubItem,
  };
}
