"use client";

import * as React from "react";

import {
  MenuCheckboxItem as MenuCheckboxItemPrimitive,
  MenuContent as MenuContentPrimitive,
  MenuGroupLabel as MenuGroupLabelPrimitive,
  MenuGroup as MenuGroupPrimitive,
  MenuItemIndicator as MenuItemIndicatorPrimitive,
  MenuItem as MenuItemPrimitive,
  Menu as MenuPrimitive,
  type MenuProps,
  MenuRadioGroup as MenuRadioGroupPrimitive,
  MenuRadioItem as MenuRadioItemPrimitive,
  MenuSeparator as MenuSeparatorPrimitive,
  MenuSubContent as MenuSubContentPrimitive,
  MenuSub as MenuSubPrimitive,
  type MenuSubProps,
  MenuSubTrigger as MenuSubTriggerPrimitive,
  MenuTrigger as MenuTriggerPrimitive,
} from "@ui-sdk/react/menu";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

function DropdownMenu({ ...props }: MenuProps) {
  return <MenuPrimitive {...props} />;
}

function DropdownMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function DropdownMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof MenuTriggerPrimitive>) {
  const baseClassName =
    "outline-none focus-visible:ring-2 focus-visible:ring-[#3B59F2]/25";

  return (
    <MenuTriggerPrimitive
      data-slot="dropdown-menu-trigger"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: React.ComponentProps<typeof MenuContentPrimitive>) {
  const baseClassName =
    "z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl border border-[#D6DEF5] dark:border-white/14 bg-gradient-to-b from-white to-[#F6F8FF] dark:from-[#161C34] dark:to-[#101528] text-popover-foreground shadow-[0_4px_0_#D6DEF5,0_18px_40px_rgb(16_25_68/0.14)] dark:shadow-[0_4px_0_#070B1A,0_18px_40px_rgb(0_0_0/0.48)] p-1.5 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95 transition-[opacity,transform] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

  return (
    <MenuContentPrimitive
      data-slot="dropdown-menu-content"
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

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof MenuGroupPrimitive>) {
  return <MenuGroupPrimitive data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuGroupLabelPrimitive> & {
  inset?: boolean;
}) {
  const baseClassName =
    "px-2 py-2 text-xs text-muted-foreground data-inset:pl-7";

  return (
    <MenuGroupLabelPrimitive
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  closeOnClick,
  closeOnSelect,
  destructive,
  ...props
}: React.ComponentProps<typeof MenuItemPrimitive> & {
  inset?: boolean;
  variant?: "default" | "destructive";
  closeOnClick?: boolean;
}) {
  const baseClassName =
    "group/dropdown-menu-item relative flex cursor-default items-center gap-2 rounded-xl px-3 py-1.5 text-[13px] outline-hidden select-none transition-colors duration-100 focus:bg-[#E8EEFF] focus:text-[#2943CC] data-[highlighted]:bg-[#E8EEFF] data-[highlighted]:text-[#2943CC] dark:focus:bg-[#3B59F2]/25 dark:focus:text-white dark:data-[highlighted]:bg-[#3B59F2]/25 dark:data-[highlighted]:text-white not-data-[variant=destructive]:focus:**:text-[#2943CC] dark:not-data-[variant=destructive]:focus:**:text-white data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive/10 data-[variant=destructive]:data-[highlighted]:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 dark:data-[variant=destructive]:data-[highlighted]:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive";

  return (
    <MenuItemPrimitive
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      closeOnSelect={closeOnSelect ?? closeOnClick}
      destructive={destructive ?? variant === "destructive"}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuSubProps) {
  return <MenuSubPrimitive {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: Omit<React.ComponentProps<typeof MenuSubTriggerPrimitive>, "children"> & {
  children?: React.ReactNode;
  inset?: boolean;
}) {
  const baseClassName =
    "flex cursor-default items-center gap-2 rounded-xl px-2 py-2 text-xs outline-hidden select-none transition-colors duration-100 focus:bg-[#E8EEFF] focus:text-[#2943CC] data-[highlighted]:bg-[#E8EEFF] data-[highlighted]:text-[#2943CC] dark:focus:bg-[#3B59F2]/25 dark:focus:text-white dark:data-[highlighted]:bg-[#3B59F2]/25 dark:data-[highlighted]:text-white not-data-[variant=destructive]:focus:**:text-[#2943CC] dark:not-data-[variant=destructive]:focus:**:text-white data-inset:pl-7 data-popup-open:bg-[#E8EEFF] data-popup-open:text-[#2943CC] dark:data-popup-open:bg-[#3B59F2]/25 dark:data-popup-open:text-white data-open:bg-[#E8EEFF] data-open:text-[#2943CC] dark:data-open:bg-[#3B59F2]/25 dark:data-open:text-white [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

  return (
    <MenuSubTriggerPrimitive
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </MenuSubTriggerPrimitive>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof MenuSubContentPrimitive>) {
  const baseClassName =
    "z-50 max-h-(--available-height) w-auto min-w-[96px] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl border border-[#D6DEF5] dark:border-white/14 bg-gradient-to-b from-white to-[#F6F8FF] dark:from-[#161C34] dark:to-[#101528] text-popover-foreground shadow-[0_4px_0_#D6DEF5,0_18px_40px_rgb(16_25_68/0.14)] dark:shadow-[0_4px_0_#070B1A,0_18px_40px_rgb(0_0_0/0.48)] p-1.5 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

  return (
    <MenuSubContentPrimitive
      data-slot="dropdown-menu-sub-content"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  value,
  ...props
}: Omit<
  React.ComponentProps<typeof MenuCheckboxItemPrimitive>,
  "children" | "value"
> & {
  children?: React.ReactNode;
  inset?: boolean;
  value?: string;
}) {
  const fallbackValue = React.useId();
  const baseClassName =
    "relative flex cursor-default items-center gap-2 rounded-xl py-2 pr-8 pl-2 text-xs outline-hidden select-none transition-colors duration-100 focus:bg-[#E8EEFF] focus:text-[#2943CC] data-[highlighted]:bg-[#E8EEFF] data-[highlighted]:text-[#2943CC] dark:focus:bg-[#3B59F2]/25 dark:focus:text-white dark:data-[highlighted]:bg-[#3B59F2]/25 dark:data-[highlighted]:text-white focus:**:text-[#2943CC] dark:focus:**:text-white data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

  return (
    <MenuCheckboxItemPrimitive
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      value={value ?? fallbackValue}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuItemIndicatorPrimitive>
          <Check />
        </MenuItemIndicatorPrimitive>
      </span>
      {children}
    </MenuCheckboxItemPrimitive>
  );
}

function DropdownMenuRadioGroup<T extends string = string>({
  ...props
}: React.ComponentProps<typeof MenuRadioGroupPrimitive<T>>) {
  return (
    <MenuRadioGroupPrimitive data-slot="dropdown-menu-radio-group" {...props} />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: Omit<React.ComponentProps<typeof MenuRadioItemPrimitive>, "children"> & {
  children?: React.ReactNode;
  inset?: boolean;
}) {
  const baseClassName =
    "relative flex cursor-default items-center gap-2 rounded-xl py-2 pr-8 pl-2 text-xs outline-hidden select-none transition-colors duration-100 focus:bg-[#E8EEFF] focus:text-[#2943CC] data-[highlighted]:bg-[#E8EEFF] data-[highlighted]:text-[#2943CC] dark:focus:bg-[#3B59F2]/25 dark:focus:text-white dark:data-[highlighted]:bg-[#3B59F2]/25 dark:data-[highlighted]:text-white focus:**:text-[#2943CC] dark:focus:**:text-white data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

  return (
    <MenuRadioItemPrimitive
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuItemIndicatorPrimitive>
          <Check />
        </MenuItemIndicatorPrimitive>
      </span>
      {children}
    </MenuRadioItemPrimitive>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuSeparatorPrimitive>) {
  const baseClassName = "-mx-1 my-1 h-px bg-[#D6DEF5]/70 dark:bg-white/10";

  return (
    <MenuSeparatorPrimitive
      data-slot="dropdown-menu-separator"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-[#2943CC] dark:group-focus/dropdown-menu-item:text-white",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
