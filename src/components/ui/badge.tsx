import {
  mergeProps,
  type PartProps,
  renderElement,
} from "@ui-sdk/react/primitive";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const COBALT_BADGE =
  "border-[#2A42C2]/45 bg-gradient-to-b from-[#5876FF] to-[#3B59F2] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3)] [a]:hover:brightness-105";

const PEARL_BADGE =
  "border-[#D4DCF4] bg-gradient-to-b from-white to-[#F3F6FF] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.85)] dark:border-white/14 dark:from-[#1D2440] dark:to-[#141930] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] [a]:hover:border-[#3B59F2]/45 [a]:hover:text-[#2943CC] dark:[a]:hover:text-[#8CA3FF]";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,filter] duration-150 focus-visible:border-[#3B59F2] focus-visible:ring-2 focus-visible:ring-[#3B59F2]/30 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-[#E54269] aria-invalid:ring-[#E54269]/20 dark:aria-invalid:ring-[#E54269]/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: COBALT_BADGE,
        cobalt: COBALT_BADGE,
        secondary: PEARL_BADGE,
        pearl: PEARL_BADGE,
        volt: "border-[#D8B822] bg-gradient-to-b from-[#FFEA7A] to-[#FFE259] text-[#101944] shadow-[inset_0_1px_0_rgb(255_255_255/0.6)] [a]:hover:brightness-105",
        destructive:
          "border-[#C83558]/45 bg-gradient-to-b from-[#FF7597] to-[#E54269] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] focus-visible:ring-[#E54269]/30 [a]:hover:brightness-105",
        outline:
          "border-[#D4DCF4] bg-transparent text-foreground dark:border-white/14 [a]:hover:bg-[#EEF2FF] [a]:hover:text-[#2943CC] dark:[a]:hover:bg-white/10 dark:[a]:hover:text-white",
        ghost:
          "hover:bg-[#EEF2FF] hover:text-[#2943CC] dark:hover:bg-white/10 dark:hover:text-white",
        link: "text-[#3B59F2] dark:text-[#8CA3FF] underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: Omit<PartProps<"span">, "className"> &
  VariantProps<typeof badgeVariants> & {
    className?: string;
  }) {
  return renderElement(
    "span",
    mergeProps(
      {
        "data-slot": "badge",
        "data-variant": variant,
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    {
      slot: "badge",
      variant,
    },
  );
}

export { Badge, badgeVariants };
