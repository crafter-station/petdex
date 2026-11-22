"use client";

import Link from "next/link";

import type { HeaderNavItem } from "@/components/site-header/types";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";

type DesktopNavProps = {
  primary: HeaderNavItem[];
  secondary: HeaderNavItem[];
  moreLabel: string;
};

/**
 * Three top-level entries instead of eight: Explore folds every
 * browsing destination into one Base UI navigation menu, while the
 * two action paths (Download, Docs) stay direct.
 */
export function DesktopNav({ primary, secondary, moreLabel }: DesktopNavProps) {
  const direct = primary.filter(
    (item) => item.href.endsWith("/download") || item.href.endsWith("/docs"),
  );
  const explore = [
    ...primary.filter((item) => !direct.includes(item)),
    ...secondary,
  ];

  return (
    <NavigationMenu className="hidden xl:flex">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="h-8 rounded-xl bg-transparent px-2.5 text-[13px] font-medium text-muted-2 hover:text-foreground data-[popup-open]:text-foreground">
            {moreLabel}
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-52 gap-0.5 p-1">
              {explore.map((item) => (
                <li key={item.href}>
                  <NavigationMenuLink
                    render={<Link href={item.href} prefetch={false} />}
                    className="flex rounded-xl px-3 py-2 text-[13px] font-medium text-foreground transition hover:bg-brand/10 hover:text-brand"
                  >
                    {item.label}
                  </NavigationMenuLink>
                </li>
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
        {direct.map((item) => (
          <NavigationMenuItem key={item.href}>
            <NavigationMenuLink
              render={<Link href={item.href} prefetch={false} />}
              className={navigationMenuTriggerStyle({
                className:
                  "h-8 rounded-xl bg-transparent px-2.5 text-[13px] font-medium text-muted-2 hover:text-foreground",
              })}
            >
              {item.label}
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  );
}
