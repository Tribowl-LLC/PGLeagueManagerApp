import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  </div>
))
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const tableRowVariants = cva(
  "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
  {
    variants: {
      variant: {
        default: "",
        plain: "bg-transparent",
      },
      hover: {
        default: "",
        none: "hover:bg-transparent",
      },
      state: {
        default: "",
        muted: "opacity-60",
      },
    },
    defaultVariants: {
      variant: "default",
      hover: "default",
      state: "default",
    },
  },
)

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & VariantProps<typeof tableRowVariants>
>(({ className, variant, hover, state, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(tableRowVariants({ variant, hover, state }), className)}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & {
    columnWidth?: "weekday" | "name" | "date"
  }
>(({ className, columnWidth, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
      columnWidth === "weekday" && "w-[12%]",
      columnWidth === "name" && "w-[20%]",
      columnWidth === "date" && "w-[15%]",
      className
    )}
    {...props}
  />
))
TableHead.displayName = "TableHead"

const tableCellVariants = cva(
  "p-4 align-middle [&:has([role=checkbox])]:pr-0",
  {
    variants: {
      tone: {
        default: "",
        muted: "text-muted-foreground",
        destructive: "text-destructive",
        success: "text-positive-600",
        subtle: "bg-muted/20",
      },
      weight: {
        default: "",
        medium: "font-medium",
      },
      font: {
        default: "",
        mono: "font-mono",
      },
      size: {
        default: "",
        sm: "text-sm",
        xs: "text-xs",
      },
      density: {
        default: "",
        compact: "p-3",
        normal: "py-4",
        comfortable: "py-6",
        spacious: "py-8",
      },
    },
    defaultVariants: {
      tone: "default",
      weight: "default",
      font: "default",
      size: "default",
      density: "default",
    },
  },
)

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & VariantProps<typeof tableCellVariants>
>(({ className, tone, weight, font, size, density, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(tableCellVariants({ tone, weight, font, size, density }), className)}
    {...props}
  />
))
TableCell.displayName = "TableCell"

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  tableCellVariants,
  tableRowVariants,
}
