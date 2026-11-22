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
  "group/navigation-menu-trigger inline-flex h-9 w-max items-center justify-center rounded-xl border border-[#D4DCF4] dark:border-white/14 bg-gradient-to-b from-white to-[#F3F6FF] dark:from-[#1D2440] dark:to-[#141930] px-3 py-1.5 text-xs font-medium text-foreground shadow-[inset_0_1.5px_0_rgb(255_255_255/0.85),0_2.5px_0_#CBD4EE] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_2.5px_0_#080B1A] hover:border-[#3B59F2]/45 transition-[transform,box-shadow,border-color,background-color] duration-150 outline-none focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/25 disabled:pointer-events-none disabled:opacity-50 data-popup-open:border-[#3B59F2]/55 data-[open]:border-[#3B59F2]/55 data-open:border-[#3B59F2]/55",
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
    "data-ending-style:data-activation-direction=left:translate-x-[50%] data-ending-style:data-activation-direction=right:translate-x-[-50%] data-starting-style:data-activation-direction=left:translate-x-[-50%] data-starting-style:data-activation-direction=right:translate-x-[50%] h-full w-auto p-1.5 transition-[opacity,transform,translate] duration-[0.35s] ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[viewport=false]/navigation-menu:rounded-2xl group-data-[viewport=false]/navigation-menu:border group-data-[viewport=false]/navigation-menu:border-[#D6DEF5] dark:group-data-[viewport=false]/navigation-menu:border-white/14 group-data-[viewport=false]/navigation-menu:bg-gradient-to-b group-data-[viewport=false]/navigation-menu:from-white group-data-[viewport=false]/navigation-menu:to-[#F6F8FF] dark:group-data-[viewport=false]/navigation-menu:from-[#161C34] dark:group-data-[viewport=false]/navigation-menu:to-[#101528] group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:shadow-[0_4px_0_#D6DEF5,0_18px_40px_rgb(16_25_68/0.14)] dark:group-data-[viewport=false]/navigation-menu:shadow-[0_4px_0_#070B1A,0_18px_40px_rgb(0_0_0/0.48)] group-data-[viewport=false]/navigation-menu:duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 data-[motion^=from-]:animate-in data-[motion^=from-]:fade-in data-[motion^=to-]:animate-out data-[motion^=to-]:fade-out **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none group-data-[viewport=false]/navigation-menu:data-open:animate-in group-data-[viewport=false]/navigation-menu:data-open:fade-in-0 group-data-[viewport=false]/navigation-menu:data-open:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-closed:animate-out group-data-[viewport=false]/navigation-menu:data-closed:fade-out-0 group-data-[viewport=false]/navigation-menu:data-closed:zoom-out-95";

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
    "isolate z-50 h-(--viewport-height) w-(--viewport-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-2xl border border-[#D6DEF5] dark:border-white/14 bg-gradient-to-b from-white to-[#F6F8FF] dark:from-[#161C34] dark:to-[#101528] text-popover-foreground shadow-[0_4px_0_#D6DEF5,0_18px_40px_rgb(16_25_68/0.14)] dark:shadow-[0_4px_0_#070B1A,0_18px_40px_rgb(0_0_0/0.48)] transition-[opacity,transform,width,height,scale,translate,top,left,right,bottom] duration-[0.35s] ease-[cubic-bezier(0.22,1,0.36,1)] outline-none data-instant:transition-none data-ending-style:scale-90 data-ending-style:opacity-0 data-ending-style:duration-150 data-starting-style:scale-90 data-starting-style:opacity-0";

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
    "flex items-center gap-2 rounded-xl p-2 text-xs transition-colors duration-100 outline-none hover:bg-[#E8EEFF] hover:text-[#2943CC] focus:bg-[#E8EEFF] focus:text-[#2943CC] dark:hover:bg-[#3B59F2]/25 dark:hover:text-white dark:focus:bg-[#3B59F2]/25 dark:focus:text-white focus-visible:ring-2 focus-visible:ring-[#3B59F2]/25 in-data-[slot=navigation-menu-content]:rounded-xl data-active:bg-[#E8EEFF]/70 data-active:text-[#2943CC] data-active:hover:bg-[#E8EEFF] data-active:focus:bg-[#E8EEFF] dark:data-active:bg-[#3B59F2]/20 dark:data-active:text-white dark:data-active:hover:bg-[#3B59F2]/25 dark:data-active:focus:bg-[#3B59F2]/25 [&_svg:not([class*='size-'])]:size-4";

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
      <div className="relative top-[60%] h-2 w-2 rotate-45 rounded-xs border-t border-l border-[#D6DEF5] dark:border-white/14 bg-white dark:bg-[#161C34] shadow-md" />
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
