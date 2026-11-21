"use client";

import type * as React from "react";

import { Button, type ButtonState } from "@ui-sdk/react/button";

import { cn } from "@/lib/utils";

export type ToyButtonVariant = "cobalt" | "pearl" | "volt";
export type ToyButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ToyButtonVariant, string> = {
  cobalt: "toy-btn-cobalt",
  pearl: "toy-btn-pearl",
  volt: "bg-toy-volt text-[#101944] shadow-[inset_0_2px_0_rgb(255_255_255/0.55),0_6px_0_#C9A91F] active:shadow-[inset_0_2px_0_rgb(255_255_255/0.4),0_1px_0_#C9A91F] data-[pressed]:shadow-[inset_0_2px_0_rgb(255_255_255/0.4),0_1px_0_#C9A91F]",
};

const SIZE_CLASSES: Record<ToyButtonSize, string> = {
  sm: "h-9 px-3.5 text-xs",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

export type ToyButtonProps = React.ComponentProps<typeof Button> & {
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
    "toy-btn cursor-pointer select-none justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-toy-cobalt disabled:pointer-events-none disabled:opacity-50 data-[pending]:opacity-75",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
  );

  const resolvedClassName =
    typeof className === "function"
      ? (state: ButtonState) => cn(baseClasses, className(state))
      : cn(baseClasses, className);

  return <Button {...props} className={resolvedClassName} />;
}
