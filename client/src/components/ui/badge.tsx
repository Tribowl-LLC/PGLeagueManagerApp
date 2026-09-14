import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
      tone: {
        warning: "border-warning-200 bg-warning-100 text-warning-800",
        warningSubtle:
          "border-warning-500/50 bg-warning-500/10 text-warning-900 dark:text-warning-200",
        warningMuted: "border-warning-300 text-warning-600",
        success:
          "border-positive-500 text-positive-700 dark:text-positive-400",
        successSolid:
          "border-transparent bg-positive-500 text-primary-foreground hover:bg-positive-600",
        successMuted: "border-success-300 text-success-600",
        positive: "border-success-200 bg-success-100 text-success-700",
        danger: "border-danger-400 text-danger-700 dark:text-danger-400",
        pending: "border-caution-400 text-caution-700 dark:text-caution-400",
      },
      size: {
        default: "",
        compact: "px-1.5 py-0 text-[10px]",
      },
      spacing: {
        default: "",
        compact: "gap-1",
      },
      interactive: {
        none: "",
        accent: "transition-colors hover:bg-accent",
        success: "transition-colors hover:bg-positive-600",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      spacing: "default",
      interactive: "none",
    },
  }
)

interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, tone, size, spacing, interactive, ...props }: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant, tone, size, spacing, interactive }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
