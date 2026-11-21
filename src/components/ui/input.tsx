import type * as React from "react";

import { Input as InputPrimitive } from "@ui-sdk/react/input";

import { cn } from "@/lib/utils";

type InputProps = React.ComponentProps<"input"> &
  Pick<
    React.ComponentProps<typeof InputPrimitive>,
    "onValueChange" | "controller" | "render"
  >;

function Input({ className, type, value, defaultValue, ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      value={value === undefined ? undefined : String(value)}
      defaultValue={
        defaultValue === undefined ? undefined : String(defaultValue)
      }
      className={cn(
        "h-8 w-full min-w-0 rounded-full border border-input bg-transparent px-2.5 py-1 text-xs transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 md:text-xs dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...(props as Omit<InputProps, "value" | "defaultValue" | "onSelect">)}
    />
  );
}

export { Input };
