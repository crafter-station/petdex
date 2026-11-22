"use client";

import type * as React from "react";

import { Toggle as TogglePrimitive } from "@ui-sdk/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const toggleVariants = cva(
  "group/toggle inline-flex cursor-pointer items-center justify-center gap-1 rounded-xl border border-transparent text-xs font-medium whitespace-nowrap transition-[transform,box-shadow,background-color,border-color,color] duration-150 outline-none select-none focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/30 active:translate-y-[1.5px] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-[#E54269] aria-invalid:ring-[#E54269]/20 dark:aria-invalid:ring-[#E54269]/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-transparent hover:bg-[#EEF2FF] hover:text-[#2943CC] dark:hover:bg-white/10 dark:hover:text-white aria-pressed:border-[#2A42C2] aria-pressed:bg-gradient-to-b aria-pressed:from-[#5876FF] aria-pressed:to-[#2943CC] aria-pressed:text-white aria-pressed:shadow-[inset_0_1.5px_0_rgb(255_255_255/0.3),0_2px_0_#1A2C8A] data-pressed:border-[#2A42C2] data-pressed:bg-gradient-to-b data-pressed:from-[#5876FF] data-pressed:to-[#2943CC] data-pressed:text-white data-pressed:shadow-[inset_0_1.5px_0_rgb(255_255_255/0.3),0_2px_0_#1A2C8A]",
        outline:
          "border-[#D4DCF4] bg-gradient-to-b from-white to-[#F3F6FF] text-foreground shadow-[inset_0_1.5px_0_rgb(255_255_255/0.85),0_2px_0_#CBD4EE] hover:border-[#3B59F2]/45 hover:text-[#2943CC] dark:border-white/14 dark:from-[#1D2440] dark:to-[#141930] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_2px_0_#080B1A] dark:hover:text-[#8CA3FF] aria-pressed:border-[#2A42C2] aria-pressed:bg-gradient-to-b aria-pressed:from-[#5876FF] aria-pressed:to-[#2943CC] aria-pressed:text-white aria-pressed:shadow-[inset_0_1.5px_0_rgb(255_255_255/0.3),0_2px_0_#1A2C8A] data-pressed:border-[#2A42C2] data-pressed:bg-gradient-to-b data-pressed:from-[#5876FF] data-pressed:to-[#2943CC] data-pressed:text-white data-pressed:shadow-[inset_0_1.5px_0_rgb(255_255_255/0.3),0_2px_0_#1A2C8A]",
        chip: "rounded-full border-[#D4DCF4] bg-gradient-to-b from-white to-[#F3F6FF] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.85),0_1.5px_0_#CBD4EE] hover:border-[#3B59F2]/45 hover:text-[#2943CC] dark:border-white/14 dark:from-[#1D2440] dark:to-[#141930] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1.5px_0_#080B1A] dark:hover:text-[#8CA3FF] aria-pressed:border-[#2A42C2] aria-pressed:bg-gradient-to-b aria-pressed:from-[#5876FF] aria-pressed:to-[#2943CC] aria-pressed:text-white aria-pressed:shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_1.5px_0_#1A2C8A] data-pressed:border-[#2A42C2] data-pressed:bg-gradient-to-b data-pressed:from-[#5876FF] data-pressed:to-[#2943CC] data-pressed:text-white data-pressed:shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_1.5px_0_#1A2C8A]",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-9 min-w-9 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        chip: "h-7 px-2.5 text-[11px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof TogglePrimitive>, "className"> &
  VariantProps<typeof toggleVariants> & {
    className?: string;
  }) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
