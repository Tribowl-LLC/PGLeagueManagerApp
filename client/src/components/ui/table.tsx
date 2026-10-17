import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { appearance?: "default" | "managePayments" }
>(({ className, appearance = "default", ...props }, ref) => (
  <div className={cn(
    "relative w-full",
    appearance === "managePayments" ? "manage-payments-table-scroll" : "overflow-auto",
  )}>
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", appearance === "managePayments" && "manage-payments-table", className)}
      {...props}
    />
  </div>
))
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & { appearance?: "default" | "managePayments" }
>(({ className, appearance = "default", ...props }, ref) => (
  <thead ref={ref} className={cn(
    "[&_tr]:border-b",
    appearance === "managePayments" && "manage-payments-table-header",
    className,
  )} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement> & { appearance?: "default" | "managePayments" }
>(({ className, appearance = "default", ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn(
      "[&_tr:last-child]:border-0",
      appearance === "managePayments" && "manage-payments-table-body",
      className,
    )}
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
      appearance: {
        default: "",
        managePayments: "manage-payments-table-row",
      },
    },
    defaultVariants: {
      variant: "default",
      hover: "default",
      state: "default",
      appearance: "default",
    },
  },
)

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & VariantProps<typeof tableRowVariants>
>(({ className, variant, hover, state, appearance, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(tableRowVariants({ variant, hover, state, appearance }), className)}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const tableHeadVariants = cva(
  "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
  {
    variants: {
      appearance: {
        default: "",
        managePayments: "manage-payments-table-head text-familiar-muted font-semibold",
      },
    },
    defaultVariants: { appearance: "default" },
  },
)

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & {
    columnWidth?: "weekday" | "name" | "date"
    appearance?: "default" | "managePayments"
  }
>(({ className, columnWidth, appearance = "default", ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      tableHeadVariants({ appearance }),
      columnWidth === "weekday" && "w-[12%]",
      columnWidth === "name" && "w-[20%]",
      columnWidth === "date" && "w-[15%]",
      className,
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
      appearance: {
        default: "",
        managePayments: "manage-payments-table-cell p-1 text-sm text-familiar-ink",
        managePaymentsResponsible: "manage-payments-table-cell manage-payments-cell-responsible p-1 text-sm text-familiar-ink",
        managePaymentsBowler: "manage-payments-table-cell manage-payments-cell-bowler p-1 text-sm text-familiar-ink",
        managePaymentsBalance: "manage-payments-table-cell manage-payments-cell-balance p-1 text-sm text-familiar-ink",
        managePaymentsFee: "manage-payments-table-cell manage-payments-cell-fee p-1 text-sm text-familiar-ink",
        managePaymentsReceived: "manage-payments-table-cell manage-payments-received-cell p-1 text-sm text-familiar-ink",
        managePaymentsFinal: "manage-payments-table-cell manage-payments-cell-final p-1 text-sm text-familiar-ink",
      },
    },
    defaultVariants: {
      tone: "default",
      weight: "default",
      font: "default",
      size: "default",
      density: "default",
      appearance: "default",
    },
  },
)

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & VariantProps<typeof tableCellVariants>
>(({ className, tone, weight, font, size, density, appearance, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(tableCellVariants({ tone, weight, font, size, density, appearance }), className)}
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
