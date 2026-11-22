"use client";

import type * as React from "react";

import {
  TabsList as TabsListPrimitive,
  TabsPanel as TabsPanelPrimitive,
  Tabs as TabsPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPrimitive
      data-slot="tabs"
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-xl p-1 text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default:
          "border border-[#D4DCF4] bg-[#EEF2FF]/80 shadow-[inset_0_1.5px_2px_rgb(16_25_68/0.06)] dark:border-white/12 dark:bg-[#11162B] dark:shadow-[inset_0_1.5px_2px_rgb(0_0_0/0.35)]",
        line: "gap-1 rounded-none border-transparent bg-transparent p-0 shadow-none",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: Omit<React.ComponentProps<typeof TabsListPrimitive>, "className"> &
  VariantProps<typeof tabsListVariants> & {
    className?: string;
  }) {
  return (
    <TabsListPrimitive
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsTabPrimitive>, "className"> & {
  className?: string;
}) {
  return (
    <TabsTabPrimitive
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1 text-xs font-medium whitespace-nowrap text-foreground/65 transition-[transform,box-shadow,background-color,border-color,color] duration-150 select-none group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:py-[calc(--spacing(1.25))] hover:text-[#2943CC] focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-[#8CA3FF] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:shadow-none group-data-[variant=line]/tabs-list:data-selected:border-transparent group-data-[variant=line]/tabs-list:data-selected:bg-transparent group-data-[variant=line]/tabs-list:data-selected:shadow-none dark:group-data-[variant=line]/tabs-list:data-selected:border-transparent dark:group-data-[variant=line]/tabs-list:data-selected:bg-transparent dark:group-data-[variant=line]/tabs-list:data-selected:shadow-none",
        "data-selected:border-[#D4DCF4] data-selected:bg-gradient-to-b data-selected:from-white data-selected:to-[#F3F6FF] data-selected:text-[#2943CC] data-selected:shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_1.5px_0_#CBD4EE] dark:data-selected:border-white/14 dark:data-selected:from-[#1D2440] dark:data-selected:to-[#141930] dark:data-selected:text-white dark:data-selected:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1.5px_0_#080B1A]",
        "after:absolute after:bg-[#3B59F2] after:opacity-0 after:transition-opacity dark:after:bg-[#8CA3FF] group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-selected:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsPanelPrimitive>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPanelPrimitive
      data-slot="tabs-content"
      className={cn("flex-1 text-xs/relaxed outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
