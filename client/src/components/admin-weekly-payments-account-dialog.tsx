import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { accountProjectionForBowler, projectedOutstandingMinor } from "@/lib/financial-utils";
import { getApiRetryDelay, makeApiError, shouldRetryApiQuery } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/utils";
import type { CanonicalPaymentRow, CanonicalPaymentFundingPortionRow } from "@shared/canonical-payment-report";
import type {
  FinancialReadAccountProjection,
  FinancialReadAccountProjectionRow,
  FinancialReadContractV3,
  FinancialReadRowContractV3,
} from "@shared/financial-contract";

const CANONICAL_DUE_CONTRACT_V3 = "canonical-due-past-due/3";
const OWNED_ACCOUNT_PROJECTION_V1 = "owned-account-projection/1";
const CANONICAL_PAYMENT_REPORT_V2 = "canonical-payment-report/2";
const CANONICAL_PAYMENT_REPORT_ORDER_V2 = "league,business-date,bowler,occurrence,allocation,payment/2";
const PAYMENT_PAGE_SIZE = 200;

export interface AdminWeeklyPaymentsAccountDialogProps {
  leagueId: number;
  bowlerId: number;
  bowlerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamNames?: Readonly<Record<number, string>>;
}

type OwnedPaymentRow = Pick<CanonicalPaymentRow,
  | "paymentId"
  | "leagueId"
  | "bowlerId"
  | "amountMinor"
  | "currency"
  | "status"
  | "paymentType"
  | "authoritativeLocalDate"
  | "source"
  | "reviewRequired"
  | "unresolved"
  | "refund"
  | "dispute"
  | "fundingPortions"
  | "correctionEvidence"
>;

interface PaymentReportPage {
  page: number;
  limit: number;
  totalRows: number;
  totalTransactions: number;
  rows: OwnedPaymentRow[];
}

interface OwnedPaymentHistoryEntry {
  row: OwnedPaymentRow;
  amountMinor: number;
  appliedMinor: number;
  availableMinor: number;
  refundedCreditMinor: number;
  totalRefundedMinor: number;
  heldCreditMinor: number;
  reviewRequired: boolean;
  key: string;
}

interface OwnedPaymentHistory {
  entries: OwnedPaymentHistoryEntry[];
  hasIncompleteOwnershipEvidence: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isOwnedAccountProjectionRow(value: unknown): value is FinancialReadAccountProjectionRow {
  if (!isRecord(value)) return false;
  return isPositiveSafeInteger(value.bowlerId)
    && isSafeNonNegativeMinor(value.amountPaidMinor)
    && isSafeNonNegativeMinor(value.availableCreditMinor)
    && isSafeNonNegativeMinor(value.confirmedDebtMinor)
    && typeof value.netBalanceMinor === "number"
    && Number.isSafeInteger(value.netBalanceMinor)
    && isSafeNonNegativeMinor(value.confirmedPastDueMinor)
    && isSafeNonNegativeMinor(value.seasonRemainingMinor)
    && typeof value.reviewRequired === "boolean";
}

function isOwnedAccountProjection(value: unknown): value is FinancialReadAccountProjection {
  return isRecord(value)
    && value.contractVersion === OWNED_ACCOUNT_PROJECTION_V1
    && Array.isArray(value.accounts)
    && value.accounts.every(isOwnedAccountProjectionRow);
}

function isFinancialRowProjection(value: unknown): value is NonNullable<FinancialReadRowContractV3["accountProjection"]> {
  if (!isRecord(value)) return false;
  return (value.effectiveDebtorBowlerId === null || isPositiveSafeInteger(value.effectiveDebtorBowlerId))
    && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "forecast")
    && isSafeNonNegativeMinor(value.projectedCreditMinor);
}

function isFinancialReadRowV3(value: unknown): value is FinancialReadRowContractV3 {
  if (!isRecord(value)) return false;
  const allowedComponents = ["full", "lineage", "prize"];
  const allowedStates = ["open", "partially_settled", "settled", "voided"];
  const allowedClassifications = ["future", "due", "past_due", "settled", "voided", "review_required"];
  const rowProjectionValid = value.accountProjection === undefined || isFinancialRowProjection(value.accountProjection);
  const projectedCreditMinor = isRecord(value.accountProjection)
    ? value.accountProjection.projectedCreditMinor
    : 0;

  return typeof value.id === "string"
    && value.id.length > 0
    && isPositiveSafeInteger(value.teamId)
    && typeof value.component === "string"
    && allowedComponents.includes(value.component)
    && isPositiveSafeInteger(value.plannedOrdinal)
    && isSafeNonNegativeMinor(value.amountMinor)
    && typeof value.state === "string"
    && allowedStates.includes(value.state)
    && isSafeNonNegativeMinor(value.allocatedMinor)
    && isSafeNonNegativeMinor(value.outstandingMinor)
    && typeof value.classification === "string"
    && allowedClassifications.includes(value.classification)
    && typeof value.reviewRequired === "boolean"
    && isSafeNonNegativeMinor(projectedCreditMinor)
    && Number.isSafeInteger(value.allocatedMinor + projectedCreditMinor)
    && rowProjectionValid;
}

function isFinancialReadContractV3(value: unknown, leagueId: number): value is FinancialReadContractV3 {
  if (!isRecord(value)
    || value.contractVersion !== CANONICAL_DUE_CONTRACT_V3
    || value.orderVersion !== "due-at,owner,occurrence,obligation/3"
    || value.authoritativeSource !== "payment_obligations"
    || value.leagueId !== leagueId
    || !Array.isArray(value.rows)
    || !value.rows.every(isFinancialReadRowV3)) return false;

  if (value.accountProjection === undefined) return true;
  if (!isOwnedAccountProjection(value.accountProjection)) return false;
  return value.rows.every((row) => isRecord(row) && isFinancialRowProjection(row.accountProjection));
}

function isPaymentFundingPortion(value: unknown): value is CanonicalPaymentFundingPortionRow {
  return isRecord(value)
    && isPositiveSafeInteger(value.creditedBowlerId)
    && isSafeNonNegativeMinor(value.amountMinor)
    && isSafeNonNegativeMinor(value.availableMinor)
    && isSafeNonNegativeMinor(value.appliedMinor)
    && isSafeNonNegativeMinor(value.refundedCreditMinor)
    && isSafeNonNegativeMinor(value.totalRefundedMinor)
    && isSafeNonNegativeMinor(value.heldCreditMinor)
    && typeof value.reviewRequired === "boolean";
}

function isOwnedPaymentRow(value: unknown, leagueId: number): value is OwnedPaymentRow {
  if (!isRecord(value)) return false;
  const allowedStatuses = ["confirmed_paid", "refunded", "disputed", "review_required", "unresolved", "pending", "failed"];
  const allowedPaymentTypes = ["cash", "check", "credit_card", "square"];
  const allowedSources = ["canonical_allocation", "prepaid_credit", "held_credit", "refunded_credit", "unresolved_operation"];
  const fundingPortionsValid = value.fundingPortions === undefined
    || (Array.isArray(value.fundingPortions) && value.fundingPortions.every(isPaymentFundingPortion));
  const refundValid = isRecord(value.refund)
    && typeof value.refund.present === "boolean"
    && isSafeNonNegativeMinor(value.refund.amountMinor);
  const disputeValid = isRecord(value.dispute)
    && typeof value.dispute.present === "boolean"
    && isSafeNonNegativeMinor(value.dispute.amountMinor)
    && (value.dispute.reviewRequired === undefined || typeof value.dispute.reviewRequired === "boolean");
  const correctionValid = value.correctionEvidence === undefined
    || (isRecord(value.correctionEvidence)
      && value.correctionEvidence.status === "voided"
      && typeof value.correctionEvidence.voidId === "string");

  return (value.paymentId === null || isPositiveSafeInteger(value.paymentId))
    && value.leagueId === leagueId
    && isPositiveSafeInteger(value.bowlerId)
    && isSafeNonNegativeMinor(value.amountMinor)
    && value.currency === "USD"
    && typeof value.status === "string"
    && allowedStatuses.includes(value.status)
    && typeof value.paymentType === "string"
    && allowedPaymentTypes.includes(value.paymentType)
    && isValidLocalDate(value.authoritativeLocalDate)
    && typeof value.source === "string"
    && allowedSources.includes(value.source)
    && typeof value.reviewRequired === "boolean"
    && typeof value.unresolved === "boolean"
    && refundValid
    && disputeValid
    && fundingPortionsValid
    && correctionValid;
}

function parsePaymentReportPage(value: unknown, page: number, leagueId: number): PaymentReportPage | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const report = value.data;
  if (report.contractVersion !== CANONICAL_PAYMENT_REPORT_V2
    || report.orderVersion !== CANONICAL_PAYMENT_REPORT_ORDER_V2
    || report.authoritativeSource !== "canonical"
    || report.leagueId !== leagueId
    || report.page !== page
    || report.limit !== PAYMENT_PAGE_SIZE
    || !isSafeNonNegativeMinor(report.totalRows)
    || !isSafeNonNegativeMinor(report.totalTransactions)
    || !Array.isArray(report.rows)
    || !report.rows.every((row) => isOwnedPaymentRow(row, leagueId))) return null;

  return {
    page,
    limit: PAYMENT_PAGE_SIZE,
    totalRows: report.totalRows,
    totalTransactions: report.totalTransactions,
    rows: report.rows,
  };
}

async function readFinancialReport(leagueId: number, bowlerId: number, signal: AbortSignal): Promise<FinancialReadContractV3> {
  const response = await fetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/3?bowlerId=${bowlerId}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw makeApiError(body, response.status, "Account details are unavailable");
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.success !== true || !isFinancialReadContractV3(payload.data, leagueId)) {
    throw new Error("Account details are unavailable");
  }
  return payload.data;
}

async function readPaymentReportPage(
  leagueId: number,
  bowlerId: number,
  page: number,
  signal: AbortSignal,
): Promise<PaymentReportPage> {
  const response = await fetch(`/api/financials/f5/payments?leagueId=${leagueId}&bowlerId=${bowlerId}&page=${page}&limit=${PAYMENT_PAGE_SIZE}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw makeApiError(body, response.status, "Payment history is unavailable");
  }
  const payload: unknown = await response.json();
  const report = parsePaymentReportPage(payload, page, leagueId);
  if (!report) throw new Error("Payment history is unavailable");
  return report;
}

async function readAllPaymentHistory(
  leagueId: number,
  bowlerId: number,
  signal: AbortSignal,
): Promise<OwnedPaymentHistory> {
  const firstPage = await readPaymentReportPage(leagueId, bowlerId, 1, signal);
  const pageCount = Math.ceil(Math.max(firstPage.totalRows, firstPage.totalTransactions) / PAYMENT_PAGE_SIZE);
  const laterPages = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => (
    readPaymentReportPage(leagueId, bowlerId, index + 2, signal)
  )));
  const pages = [firstPage, ...laterPages];
  if (pages.some((page) => page.totalRows !== firstPage.totalRows
    || page.totalTransactions !== firstPage.totalTransactions)) {
    throw new Error("Payment history is unavailable");
  }
  const rows = pages.flatMap((page) => page.rows);
  if (rows.length !== firstPage.totalRows) throw new Error("Payment history is unavailable");

  const entries: OwnedPaymentHistoryEntry[] = [];
  let hasIncompleteOwnershipEvidence = false;
  rows.forEach((row, index) => {
    const isCompletedReceipt = row.status === "confirmed_paid"
      || row.status === "refunded"
      || row.status === "disputed"
      || row.status === "review_required";
    if (!row.fundingPortions || row.fundingPortions.length === 0) {
      if (isCompletedReceipt && row.correctionEvidence?.status !== "voided") {
        hasIncompleteOwnershipEvidence = true;
      }
      return;
    }

    const ownedPortions = row.fundingPortions.filter((portion) => portion.creditedBowlerId === bowlerId);
    if (ownedPortions.length === 0) return;
    const amountMinor = ownedPortions.reduce((sum, portion) => sum + portion.amountMinor, 0);
    const appliedMinor = ownedPortions.reduce((sum, portion) => sum + portion.appliedMinor, 0);
    const availableMinor = ownedPortions.reduce((sum, portion) => sum + portion.availableMinor, 0);
    const refundedCreditMinor = ownedPortions.reduce((sum, portion) => sum + portion.refundedCreditMinor, 0);
    const totalRefundedMinor = ownedPortions.reduce((sum, portion) => sum + portion.totalRefundedMinor, 0);
    const heldCreditMinor = ownedPortions.reduce((sum, portion) => sum + portion.heldCreditMinor, 0);
    if (![amountMinor, appliedMinor, availableMinor, refundedCreditMinor, totalRefundedMinor, heldCreditMinor].every(Number.isSafeInteger)) {
      hasIncompleteOwnershipEvidence = true;
      return;
    }
    entries.push({
      row,
      amountMinor,
      appliedMinor,
      availableMinor,
      refundedCreditMinor,
      totalRefundedMinor,
      heldCreditMinor,
      reviewRequired: ownedPortions.some((portion) => portion.reviewRequired),
      key: `${row.paymentId ?? "operation"}:${row.authoritativeLocalDate}:${index}`,
    });
  });

  return { entries, hasIncompleteOwnershipEvidence };
}

function paymentMethodLabel(paymentType: OwnedPaymentRow["paymentType"]): string {
  switch (paymentType) {
    case "cash": return "cash";
    case "check": return "check";
    case "credit_card":
    case "square": return "card";
  }
}

function paymentStatusLabel(entry: OwnedPaymentHistoryEntry): string {
  const { row } = entry;
  if (row.correctionEvidence?.status === "voided") return "Voided";
  if (row.status === "failed") return "Failed";
  if (row.status === "pending") return "Pending";
  if (row.status === "unresolved") return "Review required";
  if (row.status === "refunded" || row.source === "refunded_credit") return "Refunded";
  if (row.status === "disputed" || row.status === "review_required"
    || row.reviewRequired || row.dispute.reviewRequired === true || entry.reviewRequired || entry.heldCreditMinor > 0) {
    return "Review required";
  }
  if (row.refund.present || entry.totalRefundedMinor > 0 || entry.refundedCreditMinor > 0) return "Partially refunded";
  return "Confirmed";
}

function formatPaymentDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function financialReadForDialog(
  financialReport: FinancialReadContractV3 | undefined,
  bowlerId: number,
): { account: FinancialReadAccountProjectionRow | undefined; fees: FinancialReadRowContractV3[]; reviewFeeCount: number } {
  if (!financialReport?.accountProjection) return { account: undefined, fees: [], reviewFeeCount: 0 };
  const account = accountProjectionForBowler(financialReport, bowlerId);
  const matchingAccounts = financialReport.accountProjection.accounts.filter((candidate) => candidate.bowlerId === bowlerId);
  if (!account || matchingAccounts.length !== 1) return { account: undefined, fees: [], reviewFeeCount: 0 };
  const selectedRows = financialReport.rows.filter((row) => (
    row.accountProjection?.effectiveDebtorBowlerId === bowlerId
    && row.accountProjection.confirmationStatus === "confirmed"
    && row.state !== "voided"
    && row.classification !== "voided"
  ));
  const reviewFeeCount = selectedRows.filter((row) => row.reviewRequired || row.classification === "review_required").length;
  const fees = selectedRows.filter((row) => !row.reviewRequired && row.classification !== "review_required");
  return { account, fees, reviewFeeCount };
}

function summaryAmount(value: number | undefined, loading: boolean): string {
  if (loading) return "Loading…";
  if (value === undefined) return "Unavailable";
  return formatCurrency(value);
}

export function AdminWeeklyPaymentsAccountDialog({
  leagueId,
  bowlerId,
  bowlerName,
  open,
  onOpenChange,
  teamNames,
}: AdminWeeklyPaymentsAccountDialogProps) {
  const focusReturnTarget = useRef<HTMLElement | null>(null);
  const validScope = isPositiveSafeInteger(leagueId) && isPositiveSafeInteger(bowlerId);
  const financialQuery = useQuery<FinancialReadContractV3>({
    queryKey: ["/api/financials/leagues", leagueId, "canonical-due-past-due/3", bowlerId],
    queryFn: ({ signal }) => readFinancialReport(leagueId, bowlerId, signal),
    enabled: open && validScope,
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
    staleTime: 30_000,
  });
  const paymentQuery = useQuery<OwnedPaymentHistory>({
    queryKey: ["/api/financials/f5/payments", { leagueId, bowlerId, view: "admin-weekly-account" }],
    queryFn: ({ signal }) => readAllPaymentHistory(leagueId, bowlerId, signal),
    enabled: open && validScope,
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
    staleTime: 30_000,
  });

  const financial = financialReadForDialog(
    validScope && !financialQuery.error ? financialQuery.data : undefined,
    bowlerId,
  );
  const financialLoading = open && validScope && financialQuery.isLoading;
  const account = financial.account;
  const feesAvailable = Boolean(account);
  const history = paymentQuery.data;
  const paymentHistoryLoading = open && validScope && paymentQuery.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="managePayments"
        viewport="dialog"
        showCloseButton={false}
        data-awpa="dialog"
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement;
          focusReturnTarget.current = activeElement instanceof HTMLElement ? activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (focusReturnTarget.current?.isConnected) {
            event.preventDefault();
            focusReturnTarget.current.focus();
          }
          focusReturnTarget.current = null;
        }}
      >
        <DialogHeader variant="managePayments" data-awpa="header">
          <DialogTitle>{bowlerName} account</DialogTitle>
          <DialogDescription className="sr-only">
            Read-only account balances, confirmed fees, and payment history.
          </DialogDescription>
          <DialogClose asChild>
            <Button variant="paymentsGhost" size="paymentsIcon" aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <dl data-awpa="summary" aria-label="Account summary">
          <div data-awpa="summary-cell">
            <dt>Owed now</dt>
            <dd>{summaryAmount(account?.confirmedDebtMinor, financialLoading)}</dd>
          </div>
          <div data-awpa="summary-cell">
            <dt>Available credit</dt>
            <dd>{summaryAmount(account?.availableCreditMinor, financialLoading)}</dd>
          </div>
          <div data-awpa="summary-cell">
            <dt>Remaining season</dt>
            <dd>{summaryAmount(account?.seasonRemainingMinor, financialLoading)}</dd>
          </div>
        </dl>

        <section data-awpa="section" aria-labelledby={`awpa-fees-${leagueId}-${bowlerId}`}>
          <div data-awpa="section-heading">
            <h3 id={`awpa-fees-${leagueId}-${bowlerId}`}>Confirmed fees</h3>
            {feesAvailable && <span>{financial.fees.length}</span>}
          </div>
          {financialLoading ? (
            <p data-awpa="empty">Loading confirmed fees…</p>
          ) : financialQuery.error ? (
            <div data-awpa="empty">
              <p>Confirmed fee details are unavailable.</p>
              <Button type="button" variant="outline" size="sm" data-awpa="retry" onClick={() => { void financialQuery.refetch(); }}>
                Try again
              </Button>
            </div>
          ) : !feesAvailable ? (
            <p data-awpa="empty">Confirmed fee details are unavailable for this account.</p>
          ) : financial.fees.length === 0 ? (
            <p data-awpa="empty">No confirmed fees yet.</p>
          ) : (
            <ul data-awpa="fee-list">
              {financial.fees.map((fee) => {
                const owedMinor = projectedOutstandingMinor(fee);
                const coveredMinor = fee.allocatedMinor + (fee.accountProjection?.projectedCreditMinor ?? 0);
                const teamName = teamNames?.[fee.teamId];
                const componentLabel = fee.component === "full"
                  ? "Weekly fee"
                  : fee.component === "lineage" ? "Lineage fee" : "Prize fee";
                return (
                  <li data-awpa="fee" key={fee.id}>
                    <div>
                      <strong>Week {fee.plannedOrdinal}</strong>
                      <small>{[teamName, componentLabel].filter(Boolean).join(" · ")}</small>
                    </div>
                    <strong>{formatCurrency(fee.amountMinor)}</strong>
                    <span>{formatCurrency(coveredMinor)} covered · {formatCurrency(owedMinor)} owed</span>
                  </li>
                );
              })}
            </ul>
          )}
          {feesAvailable && financial.reviewFeeCount > 0 && (
            <p data-awpa="empty">{financial.reviewFeeCount} confirmed {financial.reviewFeeCount === 1 ? "fee needs" : "fees need"} review and is not included.</p>
          )}
        </section>

        <section data-awpa="section" aria-labelledby={`awpa-history-${leagueId}-${bowlerId}`}>
          <div data-awpa="section-heading">
            <h3 id={`awpa-history-${leagueId}-${bowlerId}`}>Payment history</h3>
            {history && <span>{history.entries.length}</span>}
          </div>
          {paymentHistoryLoading ? (
            <p data-awpa="empty">Loading payment history…</p>
          ) : paymentQuery.error ? (
            <div data-awpa="empty">
              <p>Payment history is unavailable.</p>
              <Button type="button" variant="outline" size="sm" data-awpa="retry" onClick={() => { void paymentQuery.refetch(); }}>
                Try again
              </Button>
            </div>
          ) : !validScope ? (
            <p data-awpa="empty">Payment history is unavailable for this account.</p>
          ) : history?.entries.length ? (
            <div data-awpa="history" role="region" aria-label="Payment transactions">
              {history.entries.map((entry) => (
                <article data-awpa="receipt" key={entry.key}>
                  <strong>{formatCurrency(entry.amountMinor)} · {formatPaymentDate(entry.row.authoritativeLocalDate)}</strong>
                  <span>
                    {paymentMethodLabel(entry.row.paymentType)} · {formatCurrency(entry.appliedMinor)} applied · {formatCurrency(entry.availableMinor)} credit
                  </span>
                  {entry.totalRefundedMinor > 0 && <span>{formatCurrency(entry.totalRefundedMinor)} refunded</span>}
                  {entry.heldCreditMinor > 0 && <span>{formatCurrency(entry.heldCreditMinor)} refund on hold</span>}
                  <span>{paymentStatusLabel(entry)}</span>
                </article>
              ))}
              {history.hasIncompleteOwnershipEvidence && (
                <p data-awpa="empty">Some payment history needs review and is not included.</p>
              )}
            </div>
          ) : history?.hasIncompleteOwnershipEvidence ? (
            <p data-awpa="empty">Payment history needs review and is unavailable.</p>
          ) : (
            <p data-awpa="empty">No payments credited to this account.</p>
          )}
        </section>

        <DialogFooter data-awpa="actions">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
