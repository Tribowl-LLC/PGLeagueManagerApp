import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { PageLoadingState } from "@/components/page-states";
import { startOfToday } from "date-fns";
import type { League, Payment, ApiResponse } from "@shared/schema";
import { getBowlingDateByWeekNumber, getEffectiveBowlingWeeks } from "@shared/schedule-utils";
import { useParams, Link } from "wouter";
import { PaymentEntryRow } from "@/components/payment-entry-row";
import { PaymentHistoryTable } from "@/components/payment-history-table";
import { useWeeklyPayments, getNearestBowlingDay, getWeekNumber } from "@/hooks/use-weekly-payments";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WeekNavigator } from "@/components/week-navigator";
import { EditPaymentAmountDialog } from "@/components/edit-payment-amount-dialog";
import { DeletePaymentDialog } from "@/components/delete-payment-dialog";

interface EnrichedBowlerLeague {
  id: number;
  bowlerId: number;
  leagueId: number;
  teamId: number;
  bowler: { id: number; name: string; email: string | null; active: boolean } | null;
  team: { id: number; name: string; number: number; leagueId: number; displayOrder: number; active: boolean } | null;
  league: { id: number; name: string; description: string | null; active: boolean } | null;
}

export default function WeeklyPaymentsPage() {
  const params = useParams();
  const leagueId = parseInt(params.leagueId!);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [weekJumpOpen, setWeekJumpOpen] = useState(false);
  const isMobile = useIsMobile();

  const {
    paymentEntries,
    paymentToDelete,
    setPaymentToDelete,
    editingPayment,
    setEditingPayment,
    handlePaymentTypeChange,
    handleAmountChange,
    handleCheckNumberChange,
    handleSubmitPayment,
    handleDelete,
    handleStartEdit,
    handleSaveEdit,
    submitPaymentMutation,
    deletePaymentMutation,
    updatePaymentMutation,
  } = useWeeklyPayments(leagueId);

  const { data: userResponse } = useQuery<ApiResponse<{ role?: string }>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });
  const isAdmin = userResponse?.data?.role === 'system_admin'
    || userResponse?.data?.role === 'org_admin'
    || String(userResponse?.data?.role) === 'payment_manager';
  const isPaymentManager = String(userResponse?.data?.role) === 'payment_manager';

  const { data: leagueResponse, isLoading: loadingLeague } = useQuery<{ data: League }>({
    queryKey: [`/api/leagues/${leagueId}`],
    staleTime: 1000 * 60 * 30,
  });

  const { data: bowlerLeaguesResponse, isLoading: loadingBowlerLeagues } = useQuery<{ data: EnrichedBowlerLeague[] }>({
    queryKey: ["/api/bowler-leagues", { leagueId, enriched: true }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("leagueId", String(leagueId));
      params.set("enriched", "true");
      const response = await fetch(`/api/bowler-leagues?${params.toString()}`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || "Failed to fetch bowlers");
      }
      return response.json();
    },
    staleTime: 1000 * 60 * 5,
  });

  const league = leagueResponse?.data;
  const isReadOnlyArchive = league !== undefined
    && (!league.active || league.scheduleAuthority === "retired_legacy");
  const enrichedBowlerLeagues = useMemo(() => bowlerLeaguesResponse?.data || [], [bowlerLeaguesResponse?.data]);

  const sortedBowlerLeagues = useMemo(() => {
    return [...enrichedBowlerLeagues]
      .filter(bl => bl.bowler && (bl.team?.active !== false))
      .sort((a, b) => {
        const aOrder = a.team?.displayOrder ?? Infinity;
        const bOrder = b.team?.displayOrder ?? Infinity;
        if (aOrder !== bOrder) return aOrder - bOrder;
        const aTeam = a.team?.number ?? Infinity;
        const bTeam = b.team?.number ?? Infinity;
        if (aTeam !== bTeam) return aTeam - bTeam;
        return (a.bowler?.name ?? "").localeCompare(b.bowler?.name ?? "");
      });
  }, [enrichedBowlerLeagues]);

  const bowlers = useMemo(() => {
    const seen = new Set<number>();
    const unique: NonNullable<(typeof sortedBowlerLeagues)[number]["bowler"]>[] = [];
    for (const bl of sortedBowlerLeagues) {
      const bowler = bl.bowler!;
      if (!seen.has(bowler.id)) {
        seen.add(bowler.id);
        unique.push(bowler);
      }
    }
    return unique;
  }, [sortedBowlerLeagues]);

  const bowlerTeamMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const bl of sortedBowlerLeagues) {
      if (bl.bowler) {
        map.set(bl.bowler.id, bl.team?.name ?? "Unassigned");
      }
    }
    return map;
  }, [sortedBowlerLeagues]);

  const maxWeek = useMemo(() => {
    if (!league?.totalBowlingWeeks || !league?.weekDay) return 0;
    return getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? []);
  }, [league?.totalBowlingWeeks, league?.weekDay, league?.cancelledDates]);

  // Default to the bowling week nearest today until the user navigates to
  // another week. Derived during render rather than seeded by an effect:
  // `selectedWeek` holds only an explicit user choice, and `effectiveWeek`
  // falls back to the computed default in the meantime.
  const defaultWeek = useMemo(() => {
    if (!league?.weekDay || maxWeek <= 0) return null;
    const today = startOfToday();
    const nearestBowlingDay = getNearestBowlingDay(
      today,
      league.weekDay,
      league.skipDates ?? [],
      league.cancelledDates ?? []
    );
    const weekNum = getWeekNumber(nearestBowlingDay, league);
    return Math.max(1, Math.min(weekNum, maxWeek));
  }, [league, maxWeek]);

  const effectiveWeek = selectedWeek ?? defaultWeek;

  const selectedDate = useMemo(() => {
    if (!league?.weekDay || !league?.seasonStart || effectiveWeek === null) return undefined;
    return getBowlingDateByWeekNumber(
      league.seasonStart,
      league.weekDay,
      effectiveWeek,
      league.skipDates ?? [],
      league.cancelledDates ?? []
    ) ?? undefined;
  }, [league?.seasonStart, league?.weekDay, league?.skipDates, league?.cancelledDates, effectiveWeek]);

  const { data: paymentsResponse, isLoading: loadingPayments } = useQuery<{ data: Payment[] }>({
    queryKey: ["/api/payments", { leagueId, weekOf: selectedDate?.toISOString() }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (selectedDate) params.set("weekOf", selectedDate.toISOString());
      params.set("leagueId", String(leagueId));
      const response = await fetch(`/api/payments?${params.toString()}`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || "Failed to fetch payments");
      }
      return response.json();
    },
    enabled: !!selectedDate,
    staleTime: 1000 * 60,
  });

  // include ALL payment types (was filtered to cash/check only).
  // Card/Square rows need to appear here so admins can View Receipt and
  // Resend Receipt for paid card charges from the weekly view. The shared
  // PaymentHistoryTable below already gates resend/edit actions per row.
  const payments = paymentsResponse?.data || [];

  if ((loadingLeague || loadingBowlerLeagues) && !league) {
    return <Layout><PageLoadingState /></Layout>;
  }

  if (!league) {
    return <Layout><div className="text-center">League not found</div></Layout>;
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="space-y-6">
          <Link
            href={`/leagues/${leagueId}`}
            className="text-muted-foreground hover:text-foreground flex items-center mb-4"
          >
            <ArrowLeft className="size-4 mr-2" />
            Back to {league.name}
          </Link>

          <div className="flex flex-col gap-y-4">
            <h1 className="text-2xl font-bold">{league.name}: Weekly Payments</h1>
            {isReadOnlyArchive && (
              <div role="status" className="rounded-md border border-muted bg-muted/30 px-4 py-3 text-sm">
                <div className="font-medium">Read-only archive</div>
                <div className="text-muted-foreground">Historical payments remain available for review. Recording, editing, deleting, and resending payment records are unavailable.</div>
              </div>
            )}
            <WeekNavigator
              selectedWeek={effectiveWeek}
              maxWeek={maxWeek}
              selectedDate={selectedDate}
              onWeekChange={setSelectedWeek}
              popoverOpen={weekJumpOpen}
              onPopoverOpenChange={setWeekJumpOpen}
            />
          </div>

          <ErrorBoundary level="section">
            {selectedDate && (
              <Card>
                <CardHeader>
                  <CardTitle>Week {effectiveWeek}</CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  {loadingPayments || loadingBowlerLeagues ? (
                    <PageLoadingState fullPage={false} />
                  ) : (
                    <div className="space-y-6">
                      {isReadOnlyArchive ? (
                        <div role="status" className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                          Payment entry is unavailable for this archived league.
                        </div>
                      ) : isMobile ? (
                        <div className="space-y-3">
                          {sortedBowlerLeagues.length === 0 && (
                            <p className="text-center text-muted-foreground py-8">
                              No bowlers found in this league
                            </p>
                          )}
                          {sortedBowlerLeagues.map((bl) => (
                            <PaymentEntryRow
                              key={bl.id}
                              bowler={bl.bowler!}
                              teamName={bl.team?.name ?? "Unassigned"}
                              entry={paymentEntries[bl.bowler!.id]}
                              onPaymentTypeChange={handlePaymentTypeChange}
                              onAmountChange={handleAmountChange}
                              onCheckNumberChange={handleCheckNumberChange}
                              onSubmit={(bowlerId) => handleSubmitPayment(bowlerId, selectedDate)}
                              isSubmitting={submitPaymentMutation.isPending}
                              variant="card"
                              bowlerHrefSuffix={`?from=weekly-payments&fromLeagueId=${leagueId}`}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-md border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Bowler</TableHead>
                                <TableHead>Team</TableHead>
                                <TableHead>Payment Type</TableHead>
                                <TableHead>Amount</TableHead>
                                <TableHead>Action</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {sortedBowlerLeagues.length === 0 && (
                                <TableRow>
                                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                                    No bowlers found in this league
                                  </TableCell>
                                </TableRow>
                              )}
                              {sortedBowlerLeagues.map((bl) => (
                                <PaymentEntryRow
                                  key={bl.id}
                                  bowler={bl.bowler!}
                                  teamName={bl.team?.name ?? "Unassigned"}
                                  entry={paymentEntries[bl.bowler!.id]}
                                  onPaymentTypeChange={handlePaymentTypeChange}
                                  onAmountChange={handleAmountChange}
                                  onCheckNumberChange={handleCheckNumberChange}
                                  onSubmit={(bowlerId) => handleSubmitPayment(bowlerId, selectedDate)}
                                  isSubmitting={submitPaymentMutation.isPending}
                                  bowlerHrefSuffix={`?from=weekly-payments&fromLeagueId=${leagueId}`}
                                />
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}

                      <PaymentHistoryTable
                        payments={payments}
                        bowlers={bowlers}
                        bowlerTeamMap={bowlerTeamMap}
                        onStartEdit={handleStartEdit}
                        onDelete={setPaymentToDelete}
                        isDeletePending={deletePaymentMutation.isPending}
                        isAdmin={isAdmin}
                        isPaymentManager={isPaymentManager}
                        bowlerHrefSuffix={`?from=weekly-payments&fromLeagueId=${leagueId}`}
                        locationId={league?.locationId ?? null}
                        readOnly={isReadOnlyArchive}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </ErrorBoundary>

          {!isReadOnlyArchive && <EditPaymentAmountDialog
            editingPayment={editingPayment}
            onChange={setEditingPayment}
            onSave={handleSaveEdit}
            isPending={updatePaymentMutation.isPending}
          />}

          {!isReadOnlyArchive && <DeletePaymentDialog
            open={paymentToDelete !== null}
            onClose={() => setPaymentToDelete(null)}
            onConfirm={() => paymentToDelete !== null && handleDelete(paymentToDelete)}
            isPending={deletePaymentMutation.isPending}
          />}
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
