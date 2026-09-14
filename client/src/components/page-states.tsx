import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function PageLoadingState({ message, fullPage = true }: { message?: string; fullPage?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center ${fullPage ? "page-loading-viewport" : "py-12"}`}>
      <Loader2 className="size-8 animate-spin text-primary" />
      {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}

export function PageErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle className="size-5 shrink-0" />
      <p className="flex-1">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-end">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-white p-3.5 border border-navigation-200 rounded-lg shadow-sm">
            <Skeleton className="h-3 w-20 mb-2" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <div className="rounded-md border p-4 space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton shape="circular" className="h-6 w-20" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="h-6 w-32 mb-3" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-navigation-200 rounded-xl p-5 shadow-sm">
              <Skeleton className="h-4 w-28 mb-3" />
              <Skeleton className="h-4 w-20 mb-3" />
              <Skeleton shape="circular" className="h-1.5 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LeaguesTableSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="rounded-md border">
        <div className="flex items-center gap-4 p-3 border-b">
          <Skeleton className="h-8 w-45" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton shape="circular" className="h-5 w-9" />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead columnWidth="weekday">Weekday</TableHead>
              <TableHead columnWidth="name">Name</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Teams</TableHead>
              <TableHead columnWidth="date">Start Date</TableHead>
              <TableHead columnWidth="date">End Date</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...Array(5)].map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-28 mb-1" />
                  <Skeleton className="h-3 w-20" />
                </TableCell>
                <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                <TableCell><Skeleton shape="circular" className="h-6 w-16" /></TableCell>
                <TableCell>
                  <div className="flex gap-x-2">
                    <Skeleton className="size-8" />
                    <Skeleton className="size-8" />
                    <Skeleton className="size-8" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
