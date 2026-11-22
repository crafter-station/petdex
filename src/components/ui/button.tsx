import type * as React from "react";

import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const COBALT_TACTILE =
  "bg-gradient-to-b from-[#5876FF] via-[#3B59F2] to-[#2943CC] text-white border border-[#2A42C2] shadow-[inset_0_1.5px_0_rgb(255_255_255/0.32),0_3px_0_#1A2C8A] hover:brightness-[1.04] active:shadow-[inset_0_1.5px_0_rgb(255_255_255/0.25),0_1px_0_#1A2C8A]";

const PEARL_TACTILE =
  "border border-[#D4DCF4] dark:border-white/14 bg-gradient-to-b from-white to-[#F3F6FF] dark:from-[#1D2440] dark:to-[#141930] text-foreground shadow-[inset_0_1.5px_0_rgb(255_255_255/0.85),0_2.5px_0_#CBD4EE] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_2.5px_0_#080B1A] hover:border-[#3B59F2]/45 hover:text-[#2943CC] dark:hover:text-[#8CA3FF] active:shadow-[0_1px_0_#CBD4EE] aria-expanded:border-[#3B59F2]/50 aria-expanded:bg-[#EEF2FF] dark:aria-expanded:bg-[#222B4D]";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-xl border border-transparent bg-clip-padding text-xs font-medium whitespace-nowrap transition-[transform,box-shadow,background-color,border-color] duration-150 outline-none select-none focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/30 active:not-aria-[haspopup]:translate-y-[1.5px] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-[#E54269] aria-invalid:ring-2 aria-invalid:ring-[#E54269]/20 dark:aria-invalid:border-[#E54269]/60 dark:aria-invalid:ring-[#E54269]/35 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: COBALT_TACTILE,
        cobalt: COBALT_TACTILE,
        "petdex-cta": COBALT_TACTILE,
        outline: PEARL_TACTILE,
        secondary: PEARL_TACTILE,
        pearl: PEARL_TACTILE,
        "petdex-secondary": PEARL_TACTILE,
        "petdex-pill": PEARL_TACTILE,
        volt: "border border-[#D8B822] bg-gradient-to-b from-[#FFEA7A] to-[#FFE259] text-[#101944] shadow-[inset_0_1.5px_0_rgb(255_255_255/0.6),0_3px_0_#C2A114] hover:brightness-[1.03] active:shadow-[0_1px_0_#C2A114]",
        "petdex-inverse":
          "border border-[#0C1336] bg-gradient-to-b from-[#253166] to-[#101944] text-white shadow-[inset_0_1.5px_0_rgb(255_255_255/0.18),0_3px_0_#060A1E] hover:brightness-110 active:shadow-[0_1px_0_#060A1E]",
        destructive:
          "border border-[#C83558] bg-gradient-to-b from-[#FF7597] to-[#E54269] text-white shadow-[inset_0_1.5px_0_rgb(255_255_255/0.3),0_3px_0_#A12041] hover:brightness-105 active:shadow-[0_1px_0_#A12041]",
        ghost:
          "hover:bg-[#EEF2FF] hover:text-[#2943CC] dark:hover:bg-white/10 dark:hover:text-white aria-expanded:bg-[#EEF2FF] dark:aria-expanded:bg-white/10",
        link: "text-[#3B59F2] dark:text-[#8CA3FF] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 rounded-xl px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-xl px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-xl px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 rounded-xl px-3.5 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8 rounded-xl",
        "icon-xs": "size-6 rounded-xl [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-xl",
        "icon-lg": "size-9 rounded-xl",
        "petdex-pill": "h-10 rounded-2xl px-4 text-[13px]",
        "petdex-icon": "size-11 rounded-2xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  nativeButton: _nativeButton,
  ...props
}: Omit<
  React.ComponentProps<typeof ButtonPrimitive>,
  "className" | "children"
> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    children?: React.ReactNode;
    nativeButton?: boolean;
  }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
