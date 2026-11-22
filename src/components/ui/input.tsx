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
        "h-9 w-full min-w-0 rounded-xl border border-[#D4DCF4] bg-white px-3 py-1.5 text-xs text-foreground shadow-[inset_0_1.5px_2px_rgb(16_25_68/0.06)] transition-[border-color,box-shadow,background-color] duration-150 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[#F3F6FF] disabled:opacity-50 aria-invalid:border-[#E54269] aria-invalid:ring-2 aria-invalid:ring-[#E54269]/20 md:text-xs dark:border-white/14 dark:bg-[#141930] dark:shadow-[inset_0_1.5px_2px_rgb(0_0_0/0.35)] dark:focus-visible:border-[#5876FF] dark:focus-visible:ring-[#5876FF]/30 dark:disabled:bg-[#101428] dark:aria-invalid:border-[#E54269]/60 dark:aria-invalid:ring-[#E54269]/35",
        className,
      )}
      {...(props as Omit<InputProps, "value" | "defaultValue" | "onSelect">)}
    />
  );
}

export { Input };
