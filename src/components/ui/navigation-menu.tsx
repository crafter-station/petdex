"use client";

import type * as React from "react";

import {
  NavigationMenuContent as NavigationMenuContentPrimitive,
  NavigationMenuIndicator as NavigationMenuIndicatorPrimitive,
  NavigationMenuItem as NavigationMenuItemPrimitive,
  NavigationMenuLink as NavigationMenuLinkPrimitive,
  NavigationMenuList as NavigationMenuListPrimitive,
  NavigationMenu as NavigationMenuPrimitive,
  type NavigationMenuProps,
  NavigationMenuTrigger as NavigationMenuTriggerPrimitive,
  NavigationMenuViewport as NavigationMenuViewportPrimitive,
  type NavigationMenuViewportProps,
} from "@ui-sdk/react/navigation-menu";
import { cva } from "class-variance-authority";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

function NavigationMenu<T extends string = string>({
  align = "start",
  className,
  children,
  ...props
}: Omit<NavigationMenuProps<T>, "children"> & {
  children?: React.ReactNode;
  align?: NavigationMenuViewportProps["align"];
}) {
  const baseClassName =
    "group/navigation-menu relative flex max-w-max flex-1 items-center justify-center";

  return (
    <NavigationMenuPrimitive
      data-slot="navigation-menu"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      {children}
      <NavigationMenuPositioner align={align} />
    </NavigationMenuPrimitive>
  );
}

function NavigationMenuList({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuListPrimitive>) {
  const baseClassName =
    "group flex flex-1 list-none items-center justify-center gap-0";

  return (
    <NavigationMenuListPrimitive
      data-slot="navigation-menu-list"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function NavigationMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuItemPrimitive>) {
  const baseClassName = "relative";

  return (
    <NavigationMenuItemPrimitive
      data-slot="navigation-menu-item"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

const navigationMenuTriggerStyle = cva(
  "group/navigation-menu-trigger inline-flex h-9 w-max items-center justify-center rounded-none px-2.5 py-1.5 text-xs font-medium transition-all outline-none hover:bg-muted focus:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-muted/50 data-popup-open:hover:bg-muted data-open:bg-muted/50 data-open:hover:bg-muted data-open:focus:bg-muted",
);

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof NavigationMenuTriggerPrimitive>,
  "children"
> & {
  children?: React.ReactNode;
}) {
  const baseClassName = cn(navigationMenuTriggerStyle(), "group");

  return (
    <NavigationMenuTriggerPrimitive
      data-slot="navigation-menu-trigger"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      {children}{" "}
      <ChevronDown
        className="relative top-px ml-1 size-3 transition duration-300 group-data-popup-open/navigation-menu-trigger:rotate-180 group-data-open/navigation-menu-trigger:rotate-180"
        aria-hidden="true"
      />
    </NavigationMenuTriggerPrimitive>
  );
}

function NavigationMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuContentPrimitive>) {
  const baseClassName =
    "data-ending-style:data-activation-direction=left:translate-x-[50%] data-ending-style:data-activation-direction=right:translate-x-[-50%] data-starting-style:data-activation-direction=left:translate-x-[-50%] data-starting-style:data-activation-direction=right:translate-x-[50%] h-full w-auto p-1 transition-[opacity,transform,translate] duration-[0.35s] ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[viewport=false]/navigation-menu:rounded-none group-data-[viewport=false]/navigation-menu:bg-popover group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:shadow group-data-[viewport=false]/navigation-menu:ring-1 group-data-[viewport=false]/navigation-menu:ring-foreground/10 group-data-[viewport=false]/navigation-menu:duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 data-[motion^=from-]:animate-in data-[motion^=from-]:fade-in data-[motion^=to-]:animate-out data-[motion^=to-]:fade-out **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none group-data-[viewport=false]/navigation-menu:data-open:animate-in group-data-[viewport=false]/navigation-menu:data-open:fade-in-0 group-data-[viewport=false]/navigation-menu:data-open:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-closed:animate-out group-data-[viewport=false]/navigation-menu:data-closed:fade-out-0 group-data-[viewport=false]/navigation-menu:data-closed:zoom-out-95";

  return (
    <NavigationMenuContentPrimitive
      data-slot="navigation-menu-content"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function NavigationMenuPositioner({
  className,
  side = "bottom",
  sideOffset = 8,
  align = "start",
  alignOffset = 0,
  ...props
}: React.ComponentProps<typeof NavigationMenuViewportPrimitive>) {
  const baseClassName =
    "isolate z-50 h-(--viewport-height) w-(--viewport-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow ring-1 ring-foreground/10 transition-[opacity,transform,width,height,scale,translate,top,left,right,bottom] duration-[0.35s] ease-[cubic-bezier(0.22,1,0.36,1)] outline-none data-instant:transition-none data-ending-style:scale-90 data-ending-style:opacity-0 data-ending-style:duration-150 data-starting-style:scale-90 data-starting-style:opacity-0";

  return (
    <NavigationMenuViewportPrimitive
      data-slot="navigation-menu-positioner"
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function NavigationMenuLink({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuLinkPrimitive>) {
  const baseClassName =
    "flex items-center gap-2 rounded-none p-2 text-xs transition-all outline-none hover:bg-muted focus:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-1 in-data-[slot=navigation-menu-content]:rounded-none data-active:bg-muted/50 data-active:hover:bg-muted data-active:focus:bg-muted [&_svg:not([class*='size-'])]:size-4";

  return (
    <NavigationMenuLinkPrimitive
      data-slot="navigation-menu-link"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function NavigationMenuIndicator({
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof NavigationMenuIndicatorPrimitive>,
  "children"
>) {
  const baseClassName =
    "top-full z-1 flex h-1.5 items-end justify-center overflow-hidden data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:animate-in data-[state=visible]:fade-in";

  return (
    <NavigationMenuIndicatorPrimitive
      data-slot="navigation-menu-indicator"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      <div className="relative top-[60%] h-2 w-2 rotate-45 rounded-none bg-border shadow-md" />
    </NavigationMenuIndicatorPrimitive>
  );
}

export {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIndicator,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuPositioner,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
};
