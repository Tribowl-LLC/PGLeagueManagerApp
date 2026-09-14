import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const cardVariants = cva(
  "rounded-lg border bg-card text-card-foreground shadow-sm",
  {
    variants: {
      tone: {
        default: "",
        success: "border-success-500/50 bg-success-500/5",
        positive: "border-positive-500/50 bg-positive-500/5",
        danger: "border-destructive/30 bg-destructive/5",
      },
      interaction: {
        none: "",
        accent: "transition-colors hover:bg-accent",
        subtle: "transition-colors hover:bg-accent/50",
        primary: "transition-colors hover:bg-primary/5 hover:border-primary/50",
        danger: "transition-colors hover:bg-destructive/5 hover:border-destructive/50",
        shadow: "transition-shadow",
      },
      selected: {
        false: "",
        true: "ring-2 ring-offset-2 ring-primary",
      },
    },
    defaultVariants: {
      tone: "default",
      interaction: "none",
      selected: false,
    },
  },
)

interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /**
   * If true, removes padding from the card
   */
  noPadding?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, noPadding, tone, interaction, selected, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        cardVariants({ tone, interaction, selected }),
        !noPadding && "p-6",
        className
      )}
      {...props}
    />
  )
)
Card.displayName = "Card"

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  spacing?: "default" | "tight" | "relaxed";
  padding?: "default" | "compact" | "normal" | "standard" | "comfortable";
  loading?: boolean;
}

const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, spacing, padding, loading, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-y-1.5",
        spacing === "tight" && "space-y-1",
        spacing === "relaxed" && "space-y-2",
        padding === "compact" && "pb-2",
        padding === "normal" && "pb-3",
        padding === "standard" && "pb-4",
        padding === "comfortable" && "pb-4 sm:pb-6",
        loading && "animate-pulse",
        className,
      )}
      {...props}
    />
  )
)
CardHeader.displayName = "CardHeader"

interface CardTitleProps
  extends React.HTMLAttributes<HTMLHeadingElement> {
  /**
   * Level of the heading element (h1-h6)
   */
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  size?: "default" | "base" | "lg" | "xl" | "2xl";
  weight?: "semibold" | "bold";
  tone?: "default" | "positive";
  iconSpacing?: boolean | "tight";
}

const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, as: Comp = 'h3', size, weight, tone, iconSpacing, ...props }, ref) => {
    const Component = Comp
    return (
      <Component
        ref={ref}
        className={cn(
          "text-2xl font-semibold leading-none tracking-tight",
          size === "base" && "text-base",
          size === "lg" && "text-lg",
          size === "xl" && "text-xl",
          size === "2xl" && "text-2xl",
          weight === "bold" && "font-bold",
          tone === "positive" && "text-positive-700 dark:text-positive-400",
          iconSpacing && "flex items-center",
          iconSpacing === true && "gap-2",
          iconSpacing === "tight" && "gap-1.5",
          className
        )}
        {...props}
      />
    )
  }
)
CardTitle.displayName = "CardTitle"

interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /**
   * Optional CSS class for additional styling
   */
  className?: string;
}

const CardDescription = React.forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
)
CardDescription.displayName = "CardDescription"

interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  spacing?: "default" | "tight" | "normal" | "relaxed" | "loose";
  padding?:
    | "default"
    | "top"
    | "topComfortable"
    | "bottomTight"
    | "bottom"
    | "responsive"
    | "none"
    | "compact"
    | "vertical"
    | "horizontalResponsive";
  size?: "default" | "sm";
  tone?: "default" | "muted";
  gap?: "3" | "4";
  typography?: "default" | "prose";
}

const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
  ({ className, spacing, padding, size, tone, gap, typography, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "pt-0",
        spacing === "tight" && "space-y-3",
        spacing === "normal" && "space-y-4",
        spacing === "relaxed" && "space-y-5",
        spacing === "loose" && "space-y-6",
        gap === "3" && "gap-3",
        gap === "4" && "gap-4",
        padding === "top" && "pt-4",
        padding === "topComfortable" && "pt-6",
        padding === "bottomTight" && "pb-2",
        padding === "bottom" && "pb-4",
        padding === "responsive" && "pb-4 sm:pb-6",
        padding === "none" && "px-0",
        padding === "compact" && "p-4",
        padding === "vertical" && "py-4",
        padding === "horizontalResponsive" && "px-0 sm:px-6",
        size === "sm" && "text-sm",
        tone === "muted" && "text-muted-foreground",
        typography === "prose" && "prose prose-sm dark:prose-invert",
        className,
      )}
      {...props}
    />
  )
)
CardContent.displayName = "CardContent"

interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  spacing?: "default" | "tight" | "normal";
}

const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className, spacing, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center pt-0",
        spacing === "tight" && "gap-2",
        spacing === "normal" && "gap-3",
        className,
      )}
      {...props}
    />
  )
)
CardFooter.displayName = "CardFooter"

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  cardVariants,
}
