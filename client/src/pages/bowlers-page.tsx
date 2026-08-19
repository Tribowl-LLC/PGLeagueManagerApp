import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { BowlerForm } from "@/components/bowler-form";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Eye, EyeOff, Search, CheckCircle2, Pencil } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Bowler } from "@shared/schema";
import { getSquareCustomerUrl } from "@/lib/square";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { useBowlers } from "@/hooks/use-bowlers";
import { PaymentSyncRetryStatus } from "@/components/payment-sync-retry-status";
import type { ApiResponse, User } from "@shared/schema";

function BowlerTableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>League Name</TableHead>
          <TableHead>Team Name</TableHead>
          <TableHead>Square Account</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...Array(5)].map((_, i) => (
          <TableRow key={i}>
            <TableCell><Skeleton className="h-4 w-32" /></TableCell>
            <TableCell><Skeleton className="h-4 w-32" /></TableCell>
            <TableCell><Skeleton className="h-4 w-32" /></TableCell>
            <TableCell><Skeleton className="h-4 w-24" /></TableCell>
            <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function BowlersPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingBowler, setEditingBowler] = useState<Bowler | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 5 * 60 * 1000,
  });
  const isPaymentManager = String(currentUserResponse?.data?.role) === "payment_manager";

  const {
    bowlers: filteredBowlers,
    getBowlerFirstLeagueName,
    getBowlerTeamName,
    isInitialLoading,
    isLoadingRelatedData
  } = useBowlers({
    showInactive,
    searchQuery
  });

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Bowlers</h1>
        <div className="flex items-center gap-2">
          {!isPaymentManager && <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4 mr-2" />
              Add Bowler
            </Button>}
        </div>
      </div>

      <div className="space-y-4 mb-6">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search bowlers..."
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-x-2">
          {showInactive ? (
            <Eye className="size-4 text-muted-foreground" />
          ) : (
            <EyeOff className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm text-muted-foreground">Show inactive bowlers</span>
          <Switch
            checked={showInactive}
            onCheckedChange={setShowInactive}
          />
        </div>
      </div>

      <div className="rounded-md border">
        {isInitialLoading ? (
          <BowlerTableSkeleton />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">League Name</TableHead>
                <TableHead className="hidden md:table-cell">Team Name</TableHead>
                <TableHead className="hidden md:table-cell">Square Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBowlers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-4">
                    {isLoadingRelatedData ? (
                      <div className="flex items-center justify-center">
                        <Loader2 className="size-4 animate-spin mr-2" />
                        Loading bowler details…
                      </div>
                    ) : (
                      "No bowlers found"
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                filteredBowlers.map((bowler) => {
                  const leagueName = getBowlerFirstLeagueName(bowler);
                  const teamName = getBowlerTeamName(bowler);
                  return (
                    <TableRow key={bowler.id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className={`size-4 ${bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} />
                          <Link
                            href={`/bowlers/${bowler.id}?from=bowlers`}
                            className="hover:underline text-foreground"
                          >
                            {bowler.name}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {isLoadingRelatedData ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          leagueName
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {isLoadingRelatedData ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          teamName
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">
                        {bowler.paymentCustomerId ? (
                          <a
                            href={getSquareCustomerUrl(bowler.paymentCustomerId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            Square Customer
                          </a>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={bowler.active ? "default" : "secondary"} className="w-fit">
                            {bowler.active ? "Active" : "Inactive"}
                          </Badge>
                          <PaymentSyncRetryStatus bowler={bowler} compact />
                        </div>
                      </TableCell>
                      <TableCell>
                        {!isPaymentManager && <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingBowler(bowler)}
                            aria-label={`Edit ${bowler.name}`}
                            data-testid={`button-edit-bowler-${bowler.id}`}
                          >
                            <Pencil className="size-4" />
                          </Button>}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {!isPaymentManager && <BowlerForm
          open={showForm}
          onClose={() => {
            setShowForm(false);
          }}
        />}

      <BowlerForm
        key={editingBowler?.id ?? "edit-none"}
        open={!!editingBowler}
        bowler={editingBowler ?? undefined}
        onClose={() => {
          setEditingBowler(null);
        }}
      />
      </ErrorBoundary>
    </Layout>
  );
}
