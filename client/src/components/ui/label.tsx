import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
  {
    variants: {
      size: {
        default: "",
        sm: "text-sm",
        xs: "text-xs",
      },
      weight: {
        medium: "",
        normal: "font-normal",
        semibold: "font-semibold",
      },
      tone: {
        default: "",
        muted: "text-muted-foreground",
      },
      spacing: {
        default: "",
        offset: "pt-2",
      },
      iconSpacing: {
        false: "",
        true: "flex items-center gap-2",
      },
    },
    defaultVariants: {
      size: "default",
      weight: "medium",
      tone: "default",
      spacing: "default",
      iconSpacing: false,
    },
  },
)

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, size, weight, tone, spacing, iconSpacing, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants({ size, weight, tone, spacing, iconSpacing }), className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
