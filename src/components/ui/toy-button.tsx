"use client";

import type * as React from "react";

import {
  Button as ButtonPrimitive,
  type ButtonState,
} from "@ui-sdk/react/button";

import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";

export type ToyButtonVariant = "cobalt" | "pearl" | "volt";
export type ToyButtonSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<ToyButtonSize, string> = {
  sm: "h-9 px-3.5 text-xs",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

export type ToyButtonProps = React.ComponentProps<typeof ButtonPrimitive> & {
  variant?: ToyButtonVariant;
  size?: ToyButtonSize;
};

export function ToyButton({
  variant = "cobalt",
  size = "md",
  className,
  ...props
}: ToyButtonProps) {
  const baseClasses = cn(
    buttonVariants({ variant }),
    "data-[pending]:opacity-75",
    SIZE_CLASSES[size],
  );

  const resolvedClassName =
    typeof className === "function"
      ? (state: ButtonState) => cn(baseClasses, className(state))
      : cn(baseClasses, className);

  return (
    <ButtonPrimitive
      data-slot="button"
      {...props}
      className={resolvedClassName}
    />
  );
}
