import { GithubIcon } from "@/components/brand/github-icon";
import type { HeaderNavItem } from "@/components/site-header/types";
import { buttonVariants } from "@/components/ui/button";

type GithubLinkProps = {
  item: HeaderNavItem;
};

export function GithubLink({ item }: GithubLinkProps) {
  return (
    <a
      href={item.href}
      target="_blank"
      rel="noreferrer"
      aria-label={item.ariaLabel}
      className={buttonVariants({
        variant: "petdex-pill",
        size: "icon-lg",
        className: "hidden xl:inline-flex",
      })}
    >
      <GithubIcon className="size-[18px]" />
    </a>
  );
}
