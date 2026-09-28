/* eslint-disable shadcn/no-unknown-classes */
import { FC, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { PaymentOverviewCard } from "@/components/payment-overview-card";
import { PaymentDetailsDialog, paymentEvidenceDisplayStatus } from "@/components/payment-details-dialog";
import { Link } from "wouter";
import type { ApiResponse, League, Bowler } from "@shared/schema";
import type { CanonicalPaymentReport, CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { RotatingCreditBalanceWire } from "@shared/rotating-credit-contract";
import type { CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  type LeagueOccurrenceScheduleOccurrence,
  type LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";
import { deriveBowlerFinancials } from "@/lib/financial-utils";
import { rotatingPaidTotalMinor } from "@/lib/rotating-paid-total";

interface PaymentStatusSectionProps {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
}

export type RotatingCreditDisplayState = "loading" | "error" | "standard" | "rotating";

/**
 * Rotating status is a separate, league-scoped authority. A missing or
 * malformed read must never fall through to ordinary payment totals.
 */
export function resolveRotatingCreditDisplayState(
  response: ApiResponse<RotatingCreditBalanceWire> | undefined,
  isLoading: boolean,
  error: unknown,
): RotatingCreditDisplayState {
  if (isLoading || (!response && !error)) return "loading";
  if (error || !response?.success || !response.data) return "error";
  return response.data.eligibleForCredit === true ? "rotating" : "standard";
}

function readCurrentDueMinor(rows: CanonicalDuePastDueRowV2[] | undefined): number | null {
  if (!Array.isArray(rows)) return null;
  let currentDueMinor = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.outstandingMinor) || row.outstandingMinor < 0) return null;
    if (row.reviewRequired || row.state === "voided" || row.state === "settled") continue;
    if (row.classification === "due" || row.classification === "past_due") currentDueMinor += row.outstandingMinor;
  }
  return Number.isSafeInteger(currentDueMinor) ? currentDueMinor : null;
}

type DuePeriodRow = Pick<CanonicalDuePastDueRowV2, "occurrenceId" | "classification" | "state" | "outstandingMinor" | "reviewRequired">;
type DuePeriodOccurrence = Pick<LeagueOccurrenceScheduleOccurrence, "occurrenceId" | "status" | "authoritativeLocalDate" | "plannedOrdinal">;

function formatDuePeriodDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

/**
 * Uses the stored schedule ordinal and local date for the first currently due
 * obligation. Calendar arithmetic and array position are deliberately not
 * used because neither is authoritative when a season has skips or edits.
 */
export function deriveCurrentDuePeriodLabel(
  rows: readonly DuePeriodRow[] | undefined,
  occurrences: readonly DuePeriodOccurrence[] | undefined,
): string | null {
  if (!Array.isArray(rows) || !Array.isArray(occurrences)) return null;
  const currentOccurrenceIds = new Set(rows
    .filter((row) => row.outstandingMinor > 0
      && row.state !== "voided"
      && row.state !== "settled"
      && !row.reviewRequired
      && (row.classification === "due" || row.classification === "past_due"))
    .map((row) => row.occurrenceId));
  const candidates = occurrences
    .filter((occurrence) => currentOccurrenceIds.has(occurrence.occurrenceId) && occurrence.status !== "cancelled")
    .map((occurrence) => ({
      ordinal: occurrence.plannedOrdinal,
      date: formatDuePeriodDate(occurrence.authoritativeLocalDate),
    }))
    .filter((candidate): candidate is { ordinal: number; date: string } => Number.isSafeInteger(candidate.ordinal)
      && candidate.ordinal > 0
      && candidate.date !== null)
    .sort((left, right) => left.ordinal - right.ordinal);
  const first = candidates[0];
  return first ? `Week ${first.ordinal} · ${first.date}` : null;
}

/**
 * Dashboard read-only payment summary. Checkout and automatic-payment
 * consent live on the Pay page; this component reads the same
 * canonical due contract and has no legacy schedule fallback.
 */
export const PaymentStatusSection: FC<PaymentStatusSectionProps> = ({ league, bowler, weeklyFee }) => {
  const { data, isLoading, error } = useQuery<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: [`/api/financials/leagues/${league.id}/canonical-due-past-due/2`, bowler.id],
    queryFn: async () => {
      const response = await csrfFetch(`/api/financials/leagues/${league.id}/canonical-due-past-due/2?bowlerId=${bowler.id}`);
      if (!response.ok) throw new Error("Canonical payment evidence is unavailable");
      return response.json();
    },
    enabled: true,
    retry: false,
    staleTime: 30_000,
  });

  const { data: paymentReportResponse, isLoading: isLoadingPayments, error: paymentReportError } = useQuery<ApiResponse<CanonicalPaymentReport>>({
    queryKey: [`/api/financials/f5/payments`, { leagueId: league.id, bowlerId: bowler.id, page: 1 }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/f5/payments?leagueId=${league.id}&bowlerId=${bowler.id}&page=1&limit=20`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Payment history is unavailable");
      return response.json();
    },
    enabled: true,
    retry: false,
    staleTime: 30_000,
  });

  const { data: rotatingCreditResponse, isLoading: isLoadingRotatingCredit, error: rotatingCreditError } = useQuery<ApiResponse<RotatingCreditBalanceWire>>({
    queryKey: [`/api/financials/leagues/${league.id}/rotating-credit/1`],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${league.id}/rotating-credit/1`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Rotating payment eligibility is unavailable");
      return response.json();
    },
    enabled: true,
    retry: false,
    staleTime: 30_000,
  });

  const { data: scheduleResponse } = useQuery<ApiResponse<LeagueOccurrenceScheduleReadContract>>({
    queryKey: [`/api/leagues/${league.id}/occurrence-schedule`],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/leagues/${league.id}/occurrence-schedule`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Canonical schedule is unavailable");
      return response.json();
    },
    enabled: true,
    retry: false,
    staleTime: 60_000,
  });

  const rotatingCreditState = resolveRotatingCreditDisplayState(rotatingCreditResponse, isLoadingRotatingCredit, rotatingCreditError);

  const report = data?.data;
  const summary = deriveBowlerFinancials(
    report?.rows ?? [],
    report?.asOf ?? "",
    report?.totals.collectiblePastDueMinor ?? 0,
  );
  const currentDueMinor = readCurrentDueMinor(report?.rows);
  const schedule = scheduleResponse?.data;
  const scheduleOccurrences = schedule?.contractVersion === LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION
    && schedule.authoritativeSource === "canonical"
    ? schedule.occurrences
    : undefined;
  const duePeriod = deriveCurrentDuePeriodLabel(report?.rows, scheduleOccurrences);
  const isRotating = rotatingCreditState === "rotating";
  const rotatingPaidMinor = isRotating
    ? rotatingPaidTotalMinor(paymentReportResponse?.data, league.id)
    : null;
  const financials = {
    fullSeasonAmount: summary.fullSeasonAmount,
    totalDueToDate: summary.totalSeasonDues,
    totalPaid: isRotating ? rotatingPaidMinor ?? 0 : summary.totalPaidAmount,
    amountPastDue: summary.amountPastDue,
    // Keep the dashboard's existing authoritative balance projection. The
    // profile/history surfaces expose review evidence separately before using
    // their collectible balance policy.
    remainingBalance: report?.totals.outstandingMinor ?? 0,
    waivedAmount: summary.waivedAmount,
  };
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading canonical payment evidence…</p>;
  if (error) return <p className="text-sm text-destructive">Canonical payment evidence requires review.</p>;

  return (
    <div className="familiar-dashboard-payment-stack">
      {currentDueMinor === null ? (
        <p className="text-sm text-destructive">Payment totals require review.</p>
      ) : rotatingCreditState === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading payment summary…</p>
      ) : rotatingCreditState === "error" ? (
        <p className="text-sm text-destructive">Payment summary requires review.</p>
      ) : isRotating && isLoadingPayments ? (
        <p className="text-sm text-muted-foreground">Loading payment summary…</p>
      ) : isRotating && rotatingPaidMinor === null ? (
        <p className="text-sm text-destructive">Payment summary requires review.</p>
      ) : (
        <PaymentOverviewCard
          weeklyFee={weeklyFee}
          leagueId={league.id}
          paymentMode={league.paymentMode}
          financials={financials}
          currentDueMinor={currentDueMinor}
          duePeriod={duePeriod}
          isRotating={isRotating}
        />
      )}
      <LatestPaymentCard
        payment={latestPayment(paymentReportResponse?.data?.rows ?? [])}
        leagueId={league.id}
        organizationId={league.organizationId}
        bowlerName={bowler.name}
        isLoading={isLoadingPayments}
        hasError={Boolean(paymentReportError)}
      />
    </div>
  );
};

function latestPayment(rows: CanonicalPaymentRow[]): CanonicalPaymentRow | null {
  return [...rows].sort((left, right) => {
    const rightDate = Date.parse(right.authoritativeLocalDate);
    const leftDate = Date.parse(left.authoritativeLocalDate);
    if (Number.isFinite(rightDate) && Number.isFinite(leftDate) && rightDate !== leftDate) return rightDate - leftDate;
    return 0;
  })[0] ?? null;
}

function formatPaymentDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatPaymentAmount(amountMinor: number, currency: string): string {
  const hasCents = Number.isSafeInteger(amountMinor) && Math.abs(amountMinor) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function latestPaymentTitle(payment: CanonicalPaymentRow): string {
  const references = payment.appliedTo?.length ? payment.appliedTo : payment.allocations;
  const ordinals = [...new Set(references
    .map((reference) => reference.plannedOrdinal)
    .filter((ordinal): ordinal is number => typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0))];
  return ordinals.length === 1 ? `Week ${ordinals[0]} payment` : "Payment";
}

function LatestPaymentCard({
  payment,
  leagueId,
  organizationId,
  bowlerName,
  isLoading,
  hasError,
}: {
  payment: CanonicalPaymentRow | null;
  leagueId: number;
  organizationId?: number | null;
  bowlerName: string;
  isLoading: boolean;
  hasError: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const status = payment ? paymentEvidenceDisplayStatus(payment) : null;

  return (
    <section className="familiar-latest-payment" aria-labelledby="latest-payment-title">
      <header className="familiar-latest-payment__header">
        <h2 id="latest-payment-title">Latest payment</h2>
        <Link href={`/payment-history?leagueId=${leagueId}`}>View history</Link>
      </header>
      {isLoading ? (
        <p className="familiar-latest-payment__message">Loading payment history…</p>
      ) : hasError ? (
        <p className="familiar-latest-payment__message familiar-latest-payment__message--error">Latest payment is unavailable.</p>
      ) : payment ? (
        <button type="button" className="familiar-latest-payment__row" onClick={() => setDetailsOpen(true)} aria-label={`View latest payment of ${formatPaymentAmount(payment.amountMinor, payment.currency)} on ${formatPaymentDate(payment.authoritativeLocalDate)}`}>
          <span className="familiar-latest-payment__copy">
            <strong>{latestPaymentTitle(payment)}</strong>
            <span>{formatPaymentDate(payment.authoritativeLocalDate)}</span>
          </span>
          <span className="familiar-latest-payment__amount">
            <strong>{formatPaymentAmount(payment.amountMinor, payment.currency)}</strong>
            <span className={status === "Confirmed paid" ? "familiar-latest-payment__paid" : ""}>{status === "Confirmed paid" ? "✓ Paid" : status}</span>
          </span>
        </button>
      ) : (
        <p className="familiar-latest-payment__message">No payments yet.</p>
      )}
      {payment && detailsOpen && (
        <PaymentDetailsDialog
          payment={null}
          evidence={payment}
          bowlerName={bowlerName}
          canCorrect={false}
          organizationId={organizationId}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </section>
  );
}
