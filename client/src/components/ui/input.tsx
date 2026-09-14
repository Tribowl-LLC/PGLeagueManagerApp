import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      tone: {
        default: "",
        muted: "bg-muted/50",
      },
      leading: {
        default: "",
        sm: "pl-8",
        md: "pl-10",
      },
      trailing: {
        default: "",
        sm: "pr-8",
        md: "pr-10",
      },
      padding: {
        default: "",
        compact: "px-1",
      },
    },
    defaultVariants: {
      tone: "default",
      leading: "default",
      trailing: "default",
      padding: "default",
    },
  },
)

interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, tone, leading, trailing, padding, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(inputVariants({ tone, leading, trailing, padding }), className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
