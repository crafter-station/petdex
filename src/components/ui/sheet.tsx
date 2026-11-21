"use client";

import type * as React from "react";

import {
  type DialogProps,
  DialogBackdrop as SheetBackdropPrimitive,
  DialogClose as SheetClosePrimitive,
  DialogContent as SheetContentPrimitive,
  DialogDescription as SheetDescriptionPrimitive,
  Dialog as SheetPrimitive,
  DialogTitle as SheetTitlePrimitive,
  DialogTrigger as SheetTriggerPrimitive,
} from "@ui-sdk/react/dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

function Sheet({ ...props }: DialogProps) {
  return <SheetPrimitive {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetTriggerPrimitive>) {
  return <SheetTriggerPrimitive data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetClosePrimitive>) {
  return <SheetClosePrimitive data-slot="sheet-close" {...props} />;
}

function SheetPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetBackdropPrimitive>) {
  const baseClassName =
    "fixed inset-0 z-50 bg-black/10 text-xs/relaxed transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs";

  return (
    <SheetBackdropPrimitive
      data-slot="sheet-overlay"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: Omit<React.ComponentProps<typeof SheetContentPrimitive>, "children"> & {
  children?: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  const baseClassName =
    "fixed z-50 flex flex-col bg-popover bg-clip-padding text-xs/relaxed text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm";

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetContentPrimitive
        data-slot="sheet-content"
        data-side={side}
        className={
          typeof className === "function"
            ? (state) => cn(baseClassName, className(state))
            : cn(baseClassName, className)
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetClosePrimitive
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <X />
            <span className="sr-only">Close</span>
          </SheetClosePrimitive>
        )}
      </SheetContentPrimitive>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetTitlePrimitive>) {
  const baseClassName = "text-sm font-medium text-foreground";

  return (
    <SheetTitlePrimitive
      data-slot="sheet-title"
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetDescriptionPrimitive>) {
  const baseClassName = "text-xs/relaxed text-muted-foreground";

  return (
    <SheetDescriptionPrimitive
      data-slot="sheet-description"
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
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
