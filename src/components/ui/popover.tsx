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
    "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-2xl bg-popover p-2.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 transition-[opacity,transform] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

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
