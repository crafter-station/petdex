"use client";

import type * as React from "react";

import {
  PopoverContent as PopoverContentPrimitive,
  PopoverDescription as PopoverDescriptionPrimitive,
  Popover as PopoverPrimitive,
  type PopoverProps,
  PopoverTitle as PopoverTitlePrimitive,
  PopoverTrigger as PopoverTriggerPrimitive,
} from "@ui-sdk/react/popover";

import { cn } from "@/lib/utils";

function Popover({ ...props }: PopoverProps) {
  return <PopoverPrimitive {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverTriggerPrimitive>) {
  return <PopoverTriggerPrimitive data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverContentPrimitive>) {
  const baseClassName =
    "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-2xl border border-[#D6DEF5] dark:border-white/14 bg-gradient-to-b from-white to-[#F6F8FF] dark:from-[#161C34] dark:to-[#101528] p-1.5 text-xs text-popover-foreground shadow-[0_4px_0_#D6DEF5,0_18px_40px_rgb(16_25_68/0.14)] dark:shadow-[0_4px_0_#070B1A,0_18px_40px_rgb(0_0_0/0.48)] outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 transition-[opacity,transform] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

  return (
    <PopoverContentPrimitive
      data-slot="popover-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-xs", className)}
      {...props}
    />
  );
}

function PopoverTitle({
  className,
  ...props
}: React.ComponentProps<typeof PopoverTitlePrimitive>) {
  const baseClassName = "text-sm font-medium";

  return (
    <PopoverTitlePrimitive
      data-slot="popover-title"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<typeof PopoverDescriptionPrimitive>) {
  const baseClassName = "text-xs/relaxed text-muted-foreground";

  return (
    <PopoverDescriptionPrimitive
      data-slot="popover-description"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
