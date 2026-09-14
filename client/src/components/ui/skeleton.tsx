import { cn } from "@/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"

const skeletonVariants = cva("animate-pulse", {
  variants: {
    shape: {
      default: "rounded-md",
      circular: "rounded-full",
    },
  },
  defaultVariants: {
    shape: "default",
  },
})

function Skeleton({
  className,
  shape,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      className={cn(skeletonVariants({ shape }), "bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
