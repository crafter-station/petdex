"use client";

import type * as React from "react";

import {
  SelectContent as SelectContentPrimitive,
  SelectGroupLabel as SelectGroupLabelPrimitive,
  SelectGroup as SelectGroupPrimitive,
  SelectItemIndicator as SelectItemIndicatorPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemText as SelectItemTextPrimitive,
  Select as SelectPrimitive,
  SelectSeparator as SelectSeparatorPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from "@ui-sdk/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

const Select = SelectPrimitive;

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectGroupPrimitive>) {
  const baseClassName = "scroll-my-1";

  return (
    <SelectGroupPrimitive
      data-slot="select-group"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SelectValue({
  className,
  ...props
}: React.ComponentProps<typeof SelectValuePrimitive>) {
  const baseClassName = "flex flex-1 text-left";

  return (
    <SelectValuePrimitive
      data-slot="select-value"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectTriggerPrimitive>, "children"> & {
  children?: React.ReactNode;
  size?: "sm" | "default";
}) {
  const baseClassName =
    "flex w-fit items-center justify-between gap-1.5 rounded-full border border-input bg-transparent px-4 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-11 data-[size=sm]:h-9 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

  return (
    <SelectTriggerPrimitive
      data-slot="select-trigger"
      data-size={size}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none size-4 text-muted-foreground"
      />
    </SelectTriggerPrimitive>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: Omit<React.ComponentProps<typeof SelectContentPrimitive>, "children"> & {
  children?: React.ReactNode;
}) {
  const baseClassName =
    "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

  return (
    <SelectContentPrimitive
      data-slot="select-content"
      data-align-trigger={alignItemWithTrigger}
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      alignItemWithTrigger={alignItemWithTrigger}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      {children}
    </SelectContentPrimitive>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectGroupLabelPrimitive>) {
  const baseClassName = "px-2 py-2 text-xs text-muted-foreground";

  return (
    <SelectGroupLabelPrimitive
      data-slot="select-label"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SelectItem<T = string>({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectItemPrimitive<T>>, "children"> & {
  children?: React.ReactNode;
}) {
  const baseClassName =
    "relative flex w-full cursor-default items-center gap-2 rounded-xl py-2 pr-8 pl-2 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2";

  return (
    <SelectItemPrimitive
      data-slot="select-item"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      <SelectItemTextPrimitive className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </SelectItemTextPrimitive>
      <SelectItemIndicatorPrimitive className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <Check className="pointer-events-none" />
      </SelectItemIndicatorPrimitive>
    </SelectItemPrimitive>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectSeparatorPrimitive>) {
  const baseClassName = "pointer-events-none -mx-1 h-px bg-border";

  return (
    <SelectSeparatorPrimitive
      data-slot="select-separator"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUp />
    </div>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDown />
    </div>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
