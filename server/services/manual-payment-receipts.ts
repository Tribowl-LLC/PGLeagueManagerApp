import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { canonicalJsonStringify } from "@shared/canonical-json";
import {
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentVoids,
  payments,
  rotatingCreditApplications,
  rotatingCreditFundings,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { recordOwnedFundingInTransaction, releaseOwnedFundingApplicationInTransaction } from "./owned-payment-ledger.js";
import { reverseRotatingCreditApplicationsForAssignmentChangeInTransaction } from "./rotating-credit-applications.js";

export type ManualReceiptRevisionKind = "manual_record" | "manual_edit" | "manual_clear";

export interface ManualReceiptScope {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  occurrenceId: string;
  idempotencyKey: string;
}

export interface ManualReceiptPaymentRow {
  id: number;
  bowlerId: number;
  amount: number;
  type: string;
  checkNumber: string | null;
  currency: string;
  status: string;
  providerPaymentId: string | null;
  paymentOperationId: string | null;
  notes: string | null;
  paidByUserId: number | null;
}

export interface ActiveManualReceiptForPayment {
  receiptId: string;
  occurrenceId: string;
  payerBowlerId: number;
  revision: number;
  paymentId: number;
  amountMinor: number;
  businessCollectionLocalDate: string;
}

export interface ExistingManualPaymentMetadata {
  type: "cash" | "check";
  checkNumber: string | null;
  notes: string | null;
  paidByUserId: number | null;
}

export class ManualPaymentReceiptError extends Error {
  constructor(public readonly code: "manual_receipt_conflict" | "payment_write_failed", message: string) {
    super(message);
    this.name = "ManualPaymentReceiptError";
  }
}

export interface CanonicalManualReceiptQuoteIdentity {
  organizationId: number;
  leagueId: number;
  payerBowlerId: number;
  amountMinor: number;
  type: "cash" | "check";
  checkNumber: string | null;
  notes: string | null;
}

export function canonicalManualReceiptQuoteFingerprint(
  input: CanonicalManualReceiptQuoteIdentity,
  fifoQuoteFingerprint?: string,
): string {
  const identity = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
    amountMinor: input.amountMinor,
    type: input.type,
    checkNumber: input.type === "check" ? input.checkNumber?.trim() ?? null : null,
    notes: input.notes ?? null,
    ...(fifoQuoteFingerprint ? { fifoQuoteFingerprint } : {}),
  };
  return `lvmanualreceiptquote:v1:${createHash("sha256").update(canonicalJsonStringify(identity), "utf8").digest("hex")}`;
}

function receiptAuthorizationFingerprint(input: {
  organizationId: number;
  leagueId: number;
  occurrenceId: string;
  receiptId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  businessDate: string;
  idempotencyKey: string;
}): string {
  return `lvweeklyreceipt:v1:${createHash("sha256").update(canonicalJsonStringify(input), "utf8").digest("hex")}`;
}

function releaseKey(commandKey: string, applicationId: string): string {
  return `mprel_${createHash("sha256").update(`${commandKey}:${applicationId}`).digest("hex")}`;
}

export async function createManualReceiptHeadInTransaction(
  tx: PaymentOperationTransaction,
  input: Pick<ManualReceiptScope, "organizationId" | "leagueId" | "occurrenceId"> & { bowlerId: number; now: string },
): Promise<string> {
  const [receipt] = await tx.insert(weeklyPaymentWorksheetReceipts).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    occurrenceId: input.occurrenceId,
    payerBowlerId: input.bowlerId,
    receiptKind: "manual",
    createdAt: input.now,
  }).returning({ id: weeklyPaymentWorksheetReceipts.id });
  if (!receipt) throw new ManualPaymentReceiptError("payment_write_failed", "The cash or check receipt could not be created");
  return receipt.id;
}

export async function appendManualReceiptRevisionInTransaction(
  tx: PaymentOperationTransaction,
  input: Pick<ManualReceiptScope, "organizationId" | "leagueId" | "actorUserId"> & {
    receiptId: string;
    revision: number;
    paymentId: number | null;
    amountMinor: number;
    businessCollectionLocalDate: string;
    revisionKind: ManualReceiptRevisionKind;
    now: string;
  },
): Promise<void> {
  await tx.insert(weeklyPaymentWorksheetReceiptRevisions).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    receiptId: input.receiptId,
    receiptRevision: input.revision,
    paymentId: input.paymentId,
    revisionKind: input.revisionKind,
    amountMinor: input.amountMinor,
    businessCollectionLocalDate: input.businessCollectionLocalDate,
    recordedByUserId: input.actorUserId,
    createdAt: input.now,
  });
}

/** Resolve the exact active worksheet receipt head for a payment. A prior
 * revision is not enough: the latest receipt revision must still point at
 * this payment and the receipt must remain in its original collection week. */
export async function readActiveManualReceiptForPaymentInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; paymentId: number },
): Promise<ActiveManualReceiptForPayment | null> {
  const linked = await tx.select({
    receiptId: weeklyPaymentWorksheetReceiptRevisions.receiptId,
    occurrenceId: weeklyPaymentWorksheetReceipts.occurrenceId,
    payerBowlerId: weeklyPaymentWorksheetReceipts.payerBowlerId,
  }).from(weeklyPaymentWorksheetReceiptRevisions).innerJoin(weeklyPaymentWorksheetReceipts, and(
    eq(weeklyPaymentWorksheetReceipts.id, weeklyPaymentWorksheetReceiptRevisions.receiptId),
    eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
    eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
    eq(weeklyPaymentWorksheetReceipts.receiptKind, "manual"),
  )).where(and(
    eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
    eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
    eq(weeklyPaymentWorksheetReceiptRevisions.paymentId, input.paymentId),
  )).limit(2).for("update", { of: [weeklyPaymentWorksheetReceiptRevisions, weeklyPaymentWorksheetReceipts] });
  if (linked.length === 0) return null;
  if (linked.length !== 1) throw new ManualPaymentReceiptError("manual_receipt_conflict", "This payment has ambiguous receipt history");
  const receipt = linked[0];
  if (!receipt) return null;
  const [latest] = await tx.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
    eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, receipt.receiptId),
    eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
    eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
  )).orderBy(desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision)).limit(1).for("update");
  if (!latest || latest.paymentId !== input.paymentId || latest.revisionKind === "manual_clear") {
    throw new ManualPaymentReceiptError("manual_receipt_conflict", "This payment is no longer the active receipt in its collection week");
  }
  return {
    receiptId: receipt.receiptId,
    occurrenceId: receipt.occurrenceId,
    payerBowlerId: receipt.payerBowlerId,
    revision: latest.receiptRevision,
    paymentId: input.paymentId,
    amountMinor: latest.amountMinor,
    businessCollectionLocalDate: latest.businessCollectionLocalDate,
  };
}

/** Create a real cash/check tender and the exact credited-owner funding source.
 * Callers append its stable receipt revision and apply owner FIFO in the same
 * surrounding transaction. */
export async function createManualReceiptPaymentInTransaction(
  tx: PaymentOperationTransaction,
  scope: ManualReceiptScope,
  values: {
    receiptId: string;
    bowlerId: number;
    amountMinor: number;
    businessDate: string;
    paymentIdempotencyKey?: string | null;
    existingPayment?: ExistingManualPaymentMetadata;
  },
  now: string,
): Promise<number> {
  const receiptType = values.existingPayment?.type ?? "cash";
  const [payment] = await tx.insert(payments).values({
    organizationId: scope.organizationId,
    bowlerId: values.bowlerId,
    leagueId: scope.leagueId,
    amount: values.amountMinor,
    currency: "USD",
    status: "paid",
    type: receiptType,
    checkNumber: values.existingPayment?.checkNumber ?? null,
    providerPaymentId: null,
    idempotencyKey: values.paymentIdempotencyKey ?? null,
    receiptEmailMissing: false,
    notes: values.existingPayment?.notes ?? null,
    paidByUserId: values.existingPayment?.paidByUserId ?? scope.actorUserId,
    paymentOperationId: null,
    createdAt: now,
  }).returning({ id: payments.id });
  if (!payment) throw new ManualPaymentReceiptError("payment_write_failed", "The cash or check payment could not be recorded");
  await recordOwnedFundingInTransaction(tx, {
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    creditedBowlerId: values.bowlerId,
    paymentId: payment.id,
    portionIndex: 0,
    amountMinor: values.amountMinor,
    currency: "USD",
    source: "worksheet_manual",
    authorizationKind: "manual_receipt",
    authorizationFingerprint: receiptAuthorizationFingerprint({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceId,
      receiptId: values.receiptId,
      paymentId: payment.id,
      bowlerId: values.bowlerId,
      amountMinor: values.amountMinor,
      businessDate: values.businessDate,
      idempotencyKey: scope.idempotencyKey,
    }),
    authorizationOperationId: null,
    authorizationItemCount: 0,
    adoptionId: null,
    recordedByUserId: scope.actorUserId,
    now,
  });
  return payment.id;
}

/** Void exactly one cash/check tender while releasing the source applications
 * and old rotating applications tied to that payment. No payment or allocation
 * evidence is physically removed. */
export async function voidManualReceiptPaymentInTransaction(
  tx: PaymentOperationTransaction,
  scope: ManualReceiptScope & { reason: string },
  row: ManualReceiptPaymentRow,
  receiptId: string,
  now: string,
): Promise<Set<number>> {
  if (row.status !== "paid" || row.currency !== "USD" || row.providerPaymentId !== null || row.paymentOperationId !== null
    || (row.type !== "cash" && row.type !== "check")) {
    throw new ManualPaymentReceiptError("manual_receipt_conflict", "This receipt is no longer an editable cash or check payment");
  }
  const fundingApplications = await tx.select({ application: paymentAllocationFundingApplications, allocation: paymentAllocations })
    .from(paymentAllocationFundingApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
      eq(paymentAllocations.organizationId, scope.organizationId),
      eq(paymentAllocations.leagueId, scope.leagueId),
    )).where(and(
      eq(paymentAllocationFundingApplications.organizationId, scope.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, scope.leagueId),
      eq(paymentAllocationFundingApplications.paymentId, row.id),
      eq(paymentAllocations.state, "active"),
    )).orderBy(asc(paymentAllocationFundingApplications.id)).for("update", { of: [paymentAllocationFundingApplications, paymentAllocations] });
  const affectedOwners = new Set<number>();
  for (const { application } of fundingApplications) {
    affectedOwners.add(application.creditedBowlerId);
    await releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      applicationId: application.id,
      actorUserId: scope.actorUserId,
      reason: "worksheet_correction",
      idempotencyKey: releaseKey(scope.idempotencyKey, application.id),
      now,
    });
  }
  const rotatingRows = await tx.select({
    application: rotatingCreditApplications,
    funding: rotatingCreditFundings,
  }).from(rotatingCreditApplications)
    .innerJoin(rotatingCreditFundings, and(
      eq(rotatingCreditFundings.id, rotatingCreditApplications.fundingId),
      eq(rotatingCreditFundings.organizationId, scope.organizationId),
      eq(rotatingCreditFundings.leagueId, scope.leagueId),
    )).where(and(
      eq(rotatingCreditApplications.organizationId, scope.organizationId),
      eq(rotatingCreditApplications.leagueId, scope.leagueId),
      eq(rotatingCreditApplications.paymentId, row.id),
    )).orderBy(asc(rotatingCreditApplications.id));
  const assignmentIds = new Set<string>();
  for (const { application, funding } of rotatingRows) {
    affectedOwners.add(funding.bowlerId);
    assignmentIds.add(application.assignmentId);
  }
  for (const assignmentId of assignmentIds) {
    await reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(tx, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      assignmentId,
      actorUserId: scope.actorUserId,
      reason: scope.reason,
      paymentId: row.id,
      now,
    });
  }
  const activeAllocations = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, scope.organizationId),
    eq(paymentAllocations.leagueId, scope.leagueId),
    eq(paymentAllocations.paymentId, row.id),
    eq(paymentAllocations.state, "active"),
  ));
  if (activeAllocations.length > 0) throw new ManualPaymentReceiptError("manual_receipt_conflict", "This receipt has allocations that cannot be safely edited");
  await tx.insert(paymentVoids).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    paymentId: row.id,
    reason: `${scope.reason} (receipt ${receiptId})`,
    recordedByUserId: scope.actorUserId,
    createdAt: now,
  });
  await tx.update(payments).set({ status: "voided" }).where(and(
    eq(payments.id, row.id),
    eq(payments.organizationId, scope.organizationId),
    eq(payments.leagueId, scope.leagueId),
    eq(payments.status, "paid"),
  ));
  return affectedOwners;
}
