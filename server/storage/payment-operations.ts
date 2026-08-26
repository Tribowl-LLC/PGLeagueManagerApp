import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagues,
  leagueOccurrences,
  locations,
  organizations,
  paymentOperations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentObligations,
  autopayConsents,
  autopayConsentPartners,
  payments,
  paymentDisputes,
  canonicalCollectionGroups,
  canonicalCollectionGroupMembers,
  bowlerPaymentLinks,
  refundPaymentOperationSnapshots,
  users,
  PAYMENT_OPERATION_ERROR_CLASSIFICATIONS,
  PAYMENT_OPERATION_MAX_ATTEMPTS,
  PAYMENT_OPERATION_MAX_LEASE_MS,
  PAYMENT_OPERATION_MAX_RETRY_DELAY_MS,
  type PaymentOperation,
  type Payment,
  type InteractiveCardSaveStatus,
  type PaymentOperationErrorClassification,
  locationSquareCredentialsSchema,
} from "@shared/schema";
import { db } from "../db.js";
import {
  bindInteractiveOccurrenceRequestFingerprint,
  buildPaymentOperationIdentity,
  INTERACTIVE_REQUEST_KEY_MAX_LENGTH,
  validateInteractiveRequestKey,
} from "../services/payment-operation-idempotency.js";
import {
  encryptRosterOperationSnapshot,
  fingerprintRosterOperationSnapshot,
  reconstructRosterOperationSnapshot,
  type RosterOperationSemanticSnapshot,
} from "../services/roster-operation-snapshot.js";
import { deriveSquareCardSaveIdempotencyKey } from "../services/payment-operation-idempotency.js";
import {
  encryptRefundPaymentSnapshot,
  fingerprintRefundPaymentSnapshot,
  reconstructRefundPaymentSnapshot,
  refundReplaySemanticsMatch,
  type RefundPaymentSemanticSnapshot,
} from "../services/refund-payment-operation-snapshot.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import { providerNameToPaymentType } from "@shared/schema/constants";
import {
  finalizeRosterSnapshotInTransaction,
  isRosterSnapshotFinalizationError,
  validateRosterSnapshotForDispatchInTransaction,
} from "../services/roster-payment-finalizer.js";
import { validateStandingConsentForDispatchInTransaction } from "../services/roster-standing-autopay.js";
import { rosterStandingAutopayEnabled, scheduledPaymentExecutionMode } from "../config.js";
async function releaseRosterReservationsWithoutProviderEvidence(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; operationId: string },
): Promise<void> {
  const [operation] = await tx.select({ providerObjectId: paymentOperations.providerObjectId }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.id, input.operationId),
  )).for("share");
  if (operation?.providerObjectId) return;
  const [providerPayment] = await tx.select({ id: payments.id }).from(payments).where(and(
    eq(payments.leagueId, input.leagueId),
    eq(payments.paymentOperationId, input.operationId),
  )).limit(1);
  if (providerPayment) return;
  await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.operationId, input.operationId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
  ));
}

export class PaymentOperationNotFoundError extends Error {
  constructor() {
    super("Payment operation not found");
    this.name = "PaymentOperationNotFoundError";
  }
}

export class PaymentOperationImmutableMismatchError extends Error {
  constructor(options?: ErrorOptions) {
    super("Existing payment operation does not match the immutable request", options);
    this.name = "PaymentOperationImmutableMismatchError";
  }
}

export class PaymentOperationInvalidTransitionError extends Error {
  constructor(status: string) {
    super(`Payment operation cannot transition from ${status}`);
    this.name = "PaymentOperationInvalidTransitionError";
  }
}

export class PaymentOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentOperationValidationError";
  }
}
export interface CreateOrGetInteractivePaymentOperationInput {
  organizationId: number;
  targetKey: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  authorizingUserId?: number | null;
  immutableSemanticFingerprint?: string;
  now?: Date;
}

export interface CreateOrGetGeneralInteractivePaymentOperationInput {
  organizationId: number;
  requestKey: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  authorizingUserId?: number | null;
  immutableSemanticFingerprint?: string;
  now?: Date;
}

export interface CreateOrGetRefundPaymentOperationInput {
  organizationId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  providerName: string;
  now?: Date;
}

export type PaymentOperationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PaymentOperationLinkedPaymentInput {
  allocationIndex: number;
  values: Omit<
    typeof payments.$inferInsert,
    "paymentOperationId" | "paymentOperationAllocationIndex"
  >;
}

/** Serialize operation finalization with canonical schedule mutations. */
async function lockCanonicalMutationScope(
  tx: PaymentOperationTransaction,
  organizationId: number,
  operationId: string,
): Promise<PaymentOperation | undefined> {
  const [candidate] = await tx.select({
    operationType: paymentOperations.operationType,
    leagueId: paymentOperations.leagueId,
  }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, organizationId),
    eq(paymentOperations.id, operationId),
  )).limit(1);
  if (!candidate) return undefined;
  if (candidate.leagueId !== null) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${organizationId}::integer, ${candidate.leagueId}::integer)`);
  }
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, organizationId),
    eq(paymentOperations.id, operationId),
  )).limit(1).for("update");
  return operation;
}

export interface InteractiveCardSaveLeaseInput extends LeasedPaymentOperationInput {
  savedCardId: string;
}

export interface AcquirePaymentOperationLeaseInput {
  organizationId: number;
  operationId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now?: Date;
}

export interface LeasedPaymentOperationInput {
  organizationId: number;
  operationId: string;
  leaseToken: string;
  now?: Date;
}

export const GENERAL_INTERACTIVE_TARGET_PREFIX = "interactive-charge:" as const;
export const REFUND_TARGET_PREFIX = "payment-refund:" as const;
export const GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH =
  INTERACTIVE_REQUEST_KEY_MAX_LENGTH;

interface ErrorOutcomeInput extends LeasedPaymentOperationInput {
  errorCode?: string | null;
  providerObjectId?: string | null;
  providerOrderId?: string | null;
  failedPaymentRows?: PaymentOperationLinkedPaymentInput[];
}

function toIso(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new PaymentOperationValidationError(`${label} must be a valid timestamp`);
  }
  return value.toISOString();
}

function storedTimestampToIso(value: string | null): string | null {
  if (value === null) return null;
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  const parsed = new Date(includesZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function validateLeaseOwner(owner: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner)) {
    throw new PaymentOperationValidationError("leaseOwner has an invalid format");
  }
}

function validateLeaseToken(token: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new PaymentOperationValidationError("leaseToken must be a UUID");
  }
}

function validateProviderObjectId(providerObjectId: string): void {
  if (
    providerObjectId.length === 0
    || providerObjectId.length > 255
    || providerObjectId.trim() !== providerObjectId
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(providerObjectId)
  ) {
    throw new PaymentOperationValidationError("providerObjectId has an invalid format");
  }
}

function validateProviderOrderId(providerOrderId: string): void {
  validateProviderObjectId(providerOrderId);
}

function validateLinkedPaymentRows(rows: PaymentOperationLinkedPaymentInput[] | undefined): void {
  if (rows === undefined) return;
  const indexes = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.allocationIndex) || row.allocationIndex < 0) {
      throw new PaymentOperationValidationError("payment allocation index must be a non-negative integer");
    }
    if (indexes.has(row.allocationIndex)) {
      throw new PaymentOperationValidationError("payment allocation indexes must be unique");
    }
    indexes.add(row.allocationIndex);
  }
}

function validateFailedPaymentRows(rows: PaymentOperationLinkedPaymentInput[] | undefined): void {
  validateLinkedPaymentRows(rows);
  if (rows === undefined) return;
  if (rows.length > 1) {
    throw new PaymentOperationValidationError(
      "scheduled failure history permits only the payer-level row",
    );
  }
  const row = rows[0];
  if (!row) return;
  if (
    row.allocationIndex !== 0
    || row.values.status !== "failed"
    || row.values.combinedChargeGroupId != null
  ) {
    throw new PaymentOperationValidationError(
      "scheduled failure history must be one ungrouped failed payer row",
    );
  }
}

async function insertLinkedPaymentRows(
  executor: PaymentOperationTransaction,
  organizationId: number,
  operationId: string,
  rows: PaymentOperationLinkedPaymentInput[] | undefined,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const bowlerIds = [...new Set(rows.map((row) => row.values.bowlerId))];
  const leagueIds = [...new Set(rows.map((row) => row.values.leagueId))];
  const paidByUserIds = [...new Set(rows
    .map((row) => row.values.paidByUserId)
    .filter((id): id is number => typeof id === "number"))];
  const ownedBowlers = await executor.select({ id: bowlers.id }).from(bowlers).where(and(
    eq(bowlers.organizationId, organizationId),
    inArray(bowlers.id, bowlerIds),
  ));
  const ownedLeagues = await executor.select({ id: leagues.id }).from(leagues).where(and(
    eq(leagues.organizationId, organizationId),
    inArray(leagues.id, leagueIds),
  ));
  const ownedPaidByUsers = paidByUserIds.length === 0
    ? []
    : await executor.select({ id: users.id }).from(users).where(and(
      eq(users.organizationId, organizationId),
      inArray(users.id, paidByUserIds),
    ));
  if (
    ownedBowlers.length !== bowlerIds.length
    || ownedLeagues.length !== leagueIds.length
    || ownedPaidByUsers.length !== paidByUserIds.length
  ) {
    throw new PaymentOperationValidationError("linked payment rows do not belong to the operation tenant");
  }

  // A local finalization can commit provider/payment evidence before an
  // allocation write fails. Recovery must be able to replay the same exact
  // rows without violating the operation-allocation uniqueness boundary.
  const existingRows = await executor.select().from(payments).where(and(
    eq(payments.paymentOperationId, operationId),
    eq(payments.leagueId, rows[0]?.values.leagueId ?? 0),
  )).orderBy(asc(payments.paymentOperationAllocationIndex), asc(payments.id)).for("update");
  const existingByIndex = new Map(existingRows.map((row) => [row.paymentOperationAllocationIndex, row]));
  const missingRows: PaymentOperationLinkedPaymentInput[] = [];
  for (const row of rows) {
    const existing = existingByIndex.get(row.allocationIndex);
    if (!existing) {
      missingRows.push(row);
      continue;
    }
    if (
      existing.bowlerId !== row.values.bowlerId
      || existing.leagueId !== row.values.leagueId
      || existing.amount !== row.values.amount
      || existing.lineageAmount !== row.values.lineageAmount
      || existing.prizeFundAmount !== row.values.prizeFundAmount
      || existing.providerPaymentId !== row.values.providerPaymentId
      || existing.status !== row.values.status
      || existing.type !== row.values.type
    ) {
      throw new PaymentOperationImmutableMismatchError();
    }
    if (existing.receiptUrl !== null && row.values.receiptUrl !== undefined && row.values.receiptUrl !== existing.receiptUrl) throw new PaymentOperationImmutableMismatchError();
    if (existing.receiptNumber !== null && row.values.receiptNumber !== undefined && row.values.receiptNumber !== existing.receiptNumber) throw new PaymentOperationImmutableMismatchError();
    if ((existing.receiptUrl === null && row.values.receiptUrl !== undefined) || (existing.receiptNumber === null && row.values.receiptNumber !== undefined)) {
      await executor.update(payments).set({
        receiptUrl: existing.receiptUrl === null ? row.values.receiptUrl : undefined,
        receiptNumber: existing.receiptNumber === null ? row.values.receiptNumber : undefined,
      }).where(and(eq(payments.id, existing.id), eq(payments.leagueId, row.values.leagueId)));
    }
  }
  if (missingRows.length === 0) return;
  await executor.insert(payments).values(missingRows.map((row) => ({
    ...row.values,
    paymentOperationId: operationId,
    paymentOperationAllocationIndex: row.allocationIndex,
  })));
}

async function deriveStandingPaymentRowsInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; operationId: string; providerPaymentId: string; providerName: string; actorUserId: number | null },
): Promise<PaymentOperationLinkedPaymentInput[]> {
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.id, input.operationId),
    eq(paymentOperations.operationType, "standing_autopay_charge"),
  )).limit(1).for("share");
  if (!operation || operation.leagueId === null) throw new PaymentOperationValidationError("standing operation scope is incomplete");
  const rows = await tx.select({ item: paymentOperationRosterSnapshotItems, obligation: paymentObligations }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(
    eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId),
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, operation.leagueId),
  )).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, operation.leagueId),
    eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
  )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
  if (rows.length === 0) throw new PaymentOperationValidationError("standing operation snapshot has no payment rows");
  return rows.map((row) => ({
    allocationIndex: row.item.allocationIndex,
    values: {
      bowlerId: row.obligation.payerBowlerId,
      leagueId: operation.leagueId as number,
      amount: row.item.amountMinor,
      lineageAmount: null,
      prizeFundAmount: null,
      weekOf: row.obligation.dueAt,
      status: "paid" as const,
      type: providerNameToPaymentType(input.providerName),
      providerPaymentId: input.providerPaymentId,
      receiptEmailMissing: false,
      combinedChargeGroupId: null,
      paidByUserId: input.actorUserId,
      notes: "Roster standing automatic payment",
    },
  }));
}

function validateErrorDetails(
  classification: PaymentOperationErrorClassification,
  code?: string | null,
): string | null {
  if (!PAYMENT_OPERATION_ERROR_CLASSIFICATIONS.includes(classification)) {
    throw new PaymentOperationValidationError("errorClassification is invalid");
  }
  if (code == null) return null;
  if (!/^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(code)) {
    throw new PaymentOperationValidationError("errorCode must be a sanitized provider code");
  }
  return code;
}

function validateFutureDueAt(value: Date, now: Date, label: string): string {
  const dueAt = toIso(value, label);
  const delayMs = value.getTime() - now.getTime();
  if (delayMs <= 0 || delayMs > PAYMENT_OPERATION_MAX_RETRY_DELAY_MS) {
    throw new PaymentOperationValidationError(
      `${label} must be in the future and within the bounded retry window`,
    );
  }
  return dueAt;
}

function immutableInteractiveOperationMatches(
  operation: PaymentOperation,
  expected: ReturnType<typeof buildPaymentOperationIdentity>,
): boolean {
  const request = expected.normalizedRequest;
  return operation.organizationId === request.organizationId
    && operation.operationType === "interactive_charge"
    && operation.targetKey === request.targetKey
    && operation.amountMinor === request.amountMinor
    && operation.currency === request.currency
    && operation.providerName === request.providerName
    && operation.requestFingerprint === expected.requestFingerprint
    && operation.providerIdempotencyKey === expected.providerIdempotencyKey;
}

function refundTargetKey(paymentId: number): string {
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
    throw new PaymentOperationValidationError("paymentId must be a positive integer");
  }
  return `${REFUND_TARGET_PREFIX}${paymentId}`;
}

function immutableRefundOperationMatches(
  operation: PaymentOperation,
  expected: ReturnType<typeof buildPaymentOperationIdentity>,
): boolean {
  const request = expected.normalizedRequest;
  return operation.organizationId === request.organizationId
    && operation.operationType === "refund"
    && operation.targetKey === request.targetKey
    && operation.amountMinor === request.amountMinor
    && operation.currency === request.currency
    && operation.providerName === request.providerName
    && operation.requestFingerprint === expected.requestFingerprint
    && operation.providerIdempotencyKey === expected.providerIdempotencyKey;
}

/**
 * Creates durable intent for one interactive charge. This primitive does not
 * acquire a lease or call a provider; the explicit executor owns both steps.
 */
export async function createOrGetInteractivePaymentOperation(
  input: CreateOrGetInteractivePaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const baseIdentity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "interactive_charge",
    targetKey: input.targetKey,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
  });
  const identity = {
    ...baseIdentity,
    requestFingerprint: bindInteractiveOccurrenceRequestFingerprint(
      baseIdentity.requestFingerprint,
      input.immutableSemanticFingerprint,
    ),
  };
  const request = identity.normalizedRequest;
  const nowDate = input.now ?? new Date();
  if (!Number.isFinite(nowDate.getTime())) {
    throw new PaymentOperationValidationError("now must be a valid timestamp");
  }
  const now = nowDate.toISOString();

  const run = async (tx: PaymentOperationTransaction): Promise<PaymentOperation> => {
    const [ownedOrganization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1)
      .for("share");
    if (!ownedOrganization) throw new PaymentOperationNotFoundError();

    const [created] = await tx
      .insert(paymentOperations)
      .values({
        organizationId: request.organizationId,
        operationType: "interactive_charge",
        targetKey: request.targetKey,
        amountMinor: request.amountMinor,
        currency: request.currency,
        requestFingerprint: identity.requestFingerprint,
        providerIdempotencyKey: identity.providerIdempotencyKey,
        providerName: request.providerName,
        authorizingUserId: input.authorizingUserId ?? null,
        status: "pending",
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [existing] = await tx
      .select()
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.operationType, "interactive_charge"),
        eq(paymentOperations.targetKey, request.targetKey),
      ))
      .limit(1);
    if (!existing || !immutableInteractiveOperationMatches(existing, identity)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return existing;
  };

  return existingTransaction ? run(existingTransaction) : db.transaction(run);
}

function buildGeneralInteractiveTargetKey(requestKey: string): string {
  try {
    validateInteractiveRequestKey(requestKey);
  } catch (error) {
    throw new PaymentOperationValidationError(
      error instanceof Error ? error.message : "general interactive request key has an invalid format",
    );
  }
  return `${GENERAL_INTERACTIVE_TARGET_PREFIX}${requestKey}`;
}

export function getGeneralInteractiveTargetKey(requestKey: string): string {
  return buildGeneralInteractiveTargetKey(requestKey);
}

/**
 * Creates general interactive intent under a reserved target-key namespace.
 * Standing automatic payment uses its own operation namespace and cannot
 * collide with a regular checkout request.
 */
export async function createOrGetGeneralInteractivePaymentOperation(
  input: CreateOrGetGeneralInteractivePaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const operation = await createOrGetInteractivePaymentOperation({
    organizationId: input.organizationId,
    targetKey: buildGeneralInteractiveTargetKey(input.requestKey),
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    authorizingUserId: input.authorizingUserId,
    immutableSemanticFingerprint: input.immutableSemanticFingerprint,
    now: input.now,
  }, existingTransaction);
  // Existing pre-F2 operations have no actor evidence and retain their exact
  // recovery behavior. Once actor evidence exists it is immutable.
  if (operation.authorizingUserId !== null
    && input.authorizingUserId != null
    && operation.authorizingUserId !== input.authorizingUserId) {
    throw new PaymentOperationImmutableMismatchError();
  }
  return operation;
}

export async function createOrGetRefundPaymentOperation(
  input: CreateOrGetRefundPaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const targetKey = refundTargetKey(input.paymentId);
  const identity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "refund",
    targetKey,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
  });
  const request = identity.normalizedRequest;
  const now = toIso(input.now ?? new Date(), "now");
  const run = async (tx: PaymentOperationTransaction): Promise<PaymentOperation> => {
    const [created] = await tx.insert(paymentOperations).values({
      organizationId: request.organizationId,
      operationType: "refund",
      targetKey,
      amountMinor: request.amountMinor,
      currency: request.currency,
      requestFingerprint: identity.requestFingerprint,
      providerIdempotencyKey: identity.providerIdempotencyKey,
      providerName: request.providerName,
      status: "pending",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.targetKey, targetKey),
    )).limit(1);
    if (!existing || !immutableRefundOperationMatches(existing, identity)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return existing;
  };
  return existingTransaction ? run(existingTransaction) : db.transaction(run);
}

/**
 * Concurrent callers converge on the operation target uniqueness constraint.
 * A conflict is returned only when every immutable field still matches;
 * amount/currency/tenant/target drift fails closed.
 */
async function validateRosterOperationSnapshotTenantReferences(
  executor: PaymentOperationTransaction,
  snapshot: RosterOperationSemanticSnapshot,
): Promise<void> {
  const bowlerIds = [...new Set([snapshot.payerBowlerId, ...snapshot.allocations.map((row) => row.bowlerId)])];
  const paidByUserIds = [...new Set(snapshot.allocations.map((row) => row.paidByUserId).filter((id): id is number => id !== null))];
  const [ownedLeague] = await executor.select({ id: leagues.id }).from(leagues).where(and(
    eq(leagues.id, snapshot.leagueId), eq(leagues.organizationId, snapshot.organizationId),
  )).limit(1);
  const ownedBowlers = await executor.select({ id: bowlers.id }).from(bowlers).where(and(
    eq(bowlers.organizationId, snapshot.organizationId), inArray(bowlers.id, bowlerIds),
  ));
  const ownedUsers = paidByUserIds.length === 0 ? [] : await executor.select({ id: users.id }).from(users).where(and(
    eq(users.organizationId, snapshot.organizationId), inArray(users.id, paidByUserIds),
  ));
  const ownedLocation = snapshot.locationId === null ? [] : await executor.select({ id: locations.id }).from(locations).where(and(
    eq(locations.organizationId, snapshot.organizationId), eq(locations.id, snapshot.locationId),
  ));
  if (!ownedLeague || ownedBowlers.length !== bowlerIds.length || ownedUsers.length !== paidByUserIds.length || ownedLocation.length !== (snapshot.locationId === null ? 0 : 1)) {
    throw new PaymentOperationValidationError("roster operation snapshot references do not belong to the operation tenant");
  }
}

async function loadRosterOperationSnapshot(
  executor: typeof db | PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<RosterOperationSemanticSnapshot | undefined> {
  if (operation.operationType !== "interactive_charge" || operation.leagueId === null) return undefined;
  const [stored] = await executor.select().from(paymentOperationRosterSnapshots).where(and(
    eq(paymentOperationRosterSnapshots.operationId, operation.id),
    eq(paymentOperationRosterSnapshots.organizationId, operation.organizationId),
    eq(paymentOperationRosterSnapshots.leagueId, operation.leagueId),
    eq(paymentOperationRosterSnapshots.snapshotKind, "interactive"),
  )).limit(1);
  if (!stored) return undefined;
  if (stored.requestKind === null || stored.sourceKind === null || stored.encryptedSourceId === null || stored.payerBowlerId === null || stored.weekOf === null) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const requestKind = stored.requestKind;
  const sourceKind = stored.sourceKind;
  const encryptedSourceId = stored.encryptedSourceId;
  const payerBowlerId = stored.payerBowlerId;
  const weekOf = stored.weekOf;
  const allocations = Array.isArray(stored.obligations) ? stored.obligations : [];
  return reconstructRosterOperationSnapshot({
    organizationId: operation.organizationId, amountMinor: operation.amountMinor, currency: operation.currency,
    providerName: operation.providerName, providerIdempotencyKey: operation.providerIdempotencyKey,
    stored: { ...stored, snapshotVersion: 2, requestKind, sourceKind, encryptedSourceId, payerBowlerId, weekOf },
    allocations: allocations as RosterOperationSemanticSnapshot["allocations"],
    lineItems: stored.lineItems,
  });
}

export async function persistRosterOperationSnapshot(
  operation: PaymentOperation,
  snapshot: RosterOperationSemanticSnapshot,
  transaction: PaymentOperationTransaction,
  quoteFingerprint?: string | null,
): Promise<RosterOperationSemanticSnapshot> {
  if (snapshot.organizationId !== operation.organizationId) {
    throw new PaymentOperationValidationError("roster snapshot does not belong to the operation tenant");
  }
  if (operation.operationType !== "interactive_charge" || (operation.leagueId !== null && operation.leagueId !== snapshot.leagueId) || snapshot.amountMinor !== operation.amountMinor || snapshot.currency !== operation.currency || snapshot.providerName !== operation.providerName) {
    throw new PaymentOperationImmutableMismatchError();
  }
  // Validate the composite tenant references before binding a previously
  // unscoped operation to its league. This prevents a cross-tenant snapshot
  // from reaching the database FK and turns it into the intended fail-closed
  // application error.
  await validateRosterOperationSnapshotTenantReferences(transaction, snapshot);
  let operationForSnapshot = operation;
  if (operation.leagueId === null) {
    const [boundOperation] = await transaction.update(paymentOperations).set({ leagueId: snapshot.leagueId }).where(and(
      eq(paymentOperations.id, operation.id),
      eq(paymentOperations.organizationId, operation.organizationId),
      isNull(paymentOperations.leagueId),
    )).returning();
    if (boundOperation) {
      operationForSnapshot = boundOperation;
    } else {
      const [alreadyBound] = await transaction.select().from(paymentOperations).where(and(
        eq(paymentOperations.id, operation.id),
        eq(paymentOperations.organizationId, operation.organizationId),
      )).limit(1).for("share");
      if (!alreadyBound || alreadyBound.leagueId !== snapshot.leagueId) {
        throw new PaymentOperationImmutableMismatchError();
      }
      operationForSnapshot = alreadyBound;
    }
  }
  const [storedOperation] = await transaction.select().from(paymentOperations).where(and(
    eq(paymentOperations.id, operationForSnapshot.id), eq(paymentOperations.organizationId, operationForSnapshot.organizationId),
  )).limit(1).for("share");
  if (!storedOperation || storedOperation.operationType !== operationForSnapshot.operationType || storedOperation.leagueId !== snapshot.leagueId || storedOperation.targetKey !== operationForSnapshot.targetKey || storedOperation.amountMinor !== operationForSnapshot.amountMinor || storedOperation.currency !== operationForSnapshot.currency || storedOperation.providerName !== operationForSnapshot.providerName || storedOperation.requestFingerprint !== operationForSnapshot.requestFingerprint || storedOperation.providerIdempotencyKey !== operationForSnapshot.providerIdempotencyKey) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const encrypted = encryptRosterOperationSnapshot(snapshot);
  const [created] = await transaction.insert(paymentOperationRosterSnapshots).values({
    operationId: operationForSnapshot.id, organizationId: snapshot.organizationId, leagueId: snapshot.leagueId, snapshotVersion: 2, snapshotKind: "interactive",
    amountMinor: snapshot.amountMinor, currency: snapshot.currency, obligations: snapshot.allocations,
    locationId: encrypted.locationId, providerLocationId: encrypted.providerLocationId, payerBowlerId: encrypted.payerBowlerId, requestKind: encrypted.requestKind,
    encryptedSourceId: encrypted.encryptedSourceId, encryptedCustomerId: encrypted.encryptedCustomerId, encryptedBuyerEmail: encrypted.encryptedBuyerEmail,
    storeCard: encrypted.storeCard, sourceKind: encrypted.sourceKind, weekOf: encrypted.weekOf, combinedChargeGroupId: encrypted.combinedChargeGroupId,
    quoteFingerprint: quoteFingerprint ?? null, lineItems: snapshot.lineItems, snapshotFingerprint: encrypted.snapshotFingerprint,
  }).onConflictDoNothing().returning({ operationId: paymentOperationRosterSnapshots.operationId });
  if (!created) {
    const existing = await loadRosterOperationSnapshot(transaction, operationForSnapshot);
    if (!existing || fingerprintRosterOperationSnapshot(existing) !== encrypted.snapshotFingerprint) throw new PaymentOperationImmutableMismatchError();
    return existing;
  }
  if (snapshot.storeCard) await initializeInteractiveCardSaveState(transaction, operationForSnapshot, snapshot);
  const stored = await loadRosterOperationSnapshot(transaction, operationForSnapshot);
  if (!stored || fingerprintRosterOperationSnapshot(stored) !== encrypted.snapshotFingerprint) throw new PaymentOperationImmutableMismatchError();
  return stored;
}

function validateSavedCardId(savedCardId: string): void {
  if (
    savedCardId.length === 0
    || savedCardId.length > 255
    || savedCardId.trim() !== savedCardId
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(savedCardId)
  ) {
    throw new PaymentOperationValidationError("saved card id has an invalid format");
  }
}

function validateCardSaveErrorCode(errorCode: string): void {
  if (!/^[A-Z0-9][A-Z0-9_.:-]{0,127}$/.test(errorCode)) {
    throw new PaymentOperationValidationError("card save error code has an invalid format");
  }
}

/**
 * Initializes the optional pre-charge vault state in the same transaction as
 * the immutable interactive snapshot. The operation row remains the sole
 * durable provider-operation ledger.
 */
async function initializeInteractiveCardSaveState(
  transaction: PaymentOperationTransaction,
  operation: PaymentOperation,
  snapshot: RosterOperationSemanticSnapshot,
): Promise<void> {
  // Preparation callers may use a deterministic/future transaction clock in
  // tests and recovery tooling. Keep the mutable side-effect timestamp at or
  // after the operation's existing creation/update timestamp so the parent
  // timestamp invariant remains true.
  const now = operation.updatedAt;
  const requestedStatus: InteractiveCardSaveStatus | null = snapshot.storeCard
    && snapshot.sourceKind === "saved_card"
    ? "not_available"
    : snapshot.storeCard && snapshot.sourceKind === "new_card"
      ? "pending"
      : null;
  const cardSaveProviderIdempotencyKey = requestedStatus === "pending"
    ? deriveSquareCardSaveIdempotencyKey(operation.providerIdempotencyKey)
    : null;

  const [current] = await transaction
    .select({
      cardSaveStatus: paymentOperations.cardSaveStatus,
      cardSaveProviderIdempotencyKey: paymentOperations.cardSaveProviderIdempotencyKey,
      encryptedSavedCardId: paymentOperations.encryptedSavedCardId,
      cardSaveCompletedAt: paymentOperations.cardSaveCompletedAt,
    })
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.organizationId, operation.organizationId),
      eq(paymentOperations.id, operation.id),
    ))
    .limit(1)
    .for("share");
  if (!current) throw new PaymentOperationNotFoundError();

  if (requestedStatus === null) {
    if (current.cardSaveStatus !== null) throw new PaymentOperationImmutableMismatchError();
    return;
  }
  if (current.cardSaveStatus !== null) {
    if (requestedStatus === "pending") {
      const validPersistedState = ["pending", "saved", "failed"].includes(current.cardSaveStatus)
        && current.cardSaveProviderIdempotencyKey === cardSaveProviderIdempotencyKey;
      if (!validPersistedState) throw new PaymentOperationImmutableMismatchError();
      return;
    }
    if (
      current.cardSaveStatus !== requestedStatus
      || current.cardSaveProviderIdempotencyKey !== cardSaveProviderIdempotencyKey
    ) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return;
  }

  await transaction
    .update(paymentOperations)
    .set({
      cardSaveStatus: requestedStatus,
      cardSaveProviderIdempotencyKey,
      encryptedSavedCardId: null,
      cardSaveErrorCode: null,
      cardSaveCompletedAt: requestedStatus === "not_available" ? now : null,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, operation.organizationId),
      eq(paymentOperations.id, operation.id),
      isNull(paymentOperations.cardSaveStatus),
    ));
}

export async function finalizeInteractiveCardSave(
  input: InteractiveCardSaveLeaseInput,
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateSavedCardId(input.savedCardId);
  const now = toIso(input.now ?? new Date(), "now");
  const encryptedSavedCardId = encrypt(input.savedCardId);

  const updated = await db.transaction(async (tx) => {
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        cardSaveStatus: "saved",
        encryptedSavedCardId,
        cardSaveErrorCode: null,
        cardSaveCompletedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
        eq(paymentOperations.cardSaveStatus, "pending"),
      ))
      .returning();
    if (transitioned) return transitioned;

    const [existing] = await tx
      .select()
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
      ))
      .limit(1);
    if (!existing) throw new PaymentOperationNotFoundError();
    if (
      existing.cardSaveStatus === "saved"
      && existing.encryptedSavedCardId !== null
      && decrypt(existing.encryptedSavedCardId) === input.savedCardId
    ) return existing;
    throw new PaymentOperationInvalidTransitionError(existing.status);
  });
  return updated;
}

export async function recordInteractiveCardSaveFailure(
  input: LeasedPaymentOperationInput & { errorCode: string },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateCardSaveErrorCode(input.errorCode);
  const now = toIso(input.now ?? new Date(), "now");
  const [updated] = await db
    .update(paymentOperations)
    .set({
      cardSaveStatus: "failed",
      encryptedSavedCardId: null,
      cardSaveErrorCode: input.errorCode,
      cardSaveCompletedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      eq(paymentOperations.cardSaveStatus, "pending"),
    ))
    .returning();
  if (updated) return updated;
  const existing = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
  if (!existing) throw new PaymentOperationNotFoundError();
  throw new PaymentOperationInvalidTransitionError(existing.status);
}

export function getInteractiveCardSaveResponse(operation: PaymentOperation): {
  savedCardId: string | null;
  cardSaveStatus: "not_requested" | "saved" | "failed" | "not_available";
} {
  if (operation.cardSaveStatus === "saved" && operation.encryptedSavedCardId) {
    const savedCardId = decrypt(operation.encryptedSavedCardId);
    if (savedCardId) return { savedCardId, cardSaveStatus: "saved" };
    return { savedCardId: null, cardSaveStatus: "failed" };
  }
  if (operation.cardSaveStatus === "failed") {
    return { savedCardId: null, cardSaveStatus: "failed" };
  }
  if (operation.cardSaveStatus === "not_available") {
    return { savedCardId: null, cardSaveStatus: "not_available" };
  }
  return { savedCardId: null, cardSaveStatus: "not_requested" };
}

async function loadRefundPaymentOperationSnapshot(
  executor: typeof db | PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<RefundPaymentSemanticSnapshot | undefined> {
  if (operation.operationType !== "refund") return undefined;
  const [stored] = await executor.select().from(refundPaymentOperationSnapshots).where(
    eq(refundPaymentOperationSnapshots.operationId, operation.id),
  ).limit(1);
  if (!stored) return undefined;
  return reconstructRefundPaymentSnapshot({
    organizationId: operation.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    stored,
  });
}

export async function persistRefundPaymentOperationSnapshot(
  operation: PaymentOperation,
  snapshot: RefundPaymentSemanticSnapshot,
  transaction: PaymentOperationTransaction,
): Promise<RefundPaymentSemanticSnapshot> {
  if (
    operation.operationType !== "refund"
    || operation.targetKey !== refundTargetKey(snapshot.paymentId)
    || snapshot.organizationId !== operation.organizationId
    || snapshot.amountMinor !== operation.amountMinor
    || snapshot.currency !== operation.currency
    || snapshot.providerName !== operation.providerName
  ) throw new PaymentOperationImmutableMismatchError();

  const encrypted = encryptRefundPaymentSnapshot(snapshot);
  const [created] = await transaction.insert(refundPaymentOperationSnapshots).values({
    operationId: operation.id,
    ...encrypted,
  }).onConflictDoNothing().returning({ operationId: refundPaymentOperationSnapshots.operationId });
  const stored = await loadRefundPaymentOperationSnapshot(transaction, operation);
  if (!stored) throw new PaymentOperationImmutableMismatchError();
  if (created) {
    if (encrypted.snapshotFingerprint !== fingerprintRefundPaymentSnapshot(stored)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return stored;
  }
  if (!refundReplaySemanticsMatch(stored, snapshot)) {
    throw new PaymentOperationImmutableMismatchError();
  }
  return stored;
}

export async function getRefundPaymentOperationSnapshotForOrganization(
  organizationId: number,
  operationId: string,
): Promise<RefundPaymentSemanticSnapshot | undefined> {
  const operation = await getPaymentOperationForOrganization(organizationId, operationId);
  if (!operation) return undefined;
  return loadRefundPaymentOperationSnapshot(db, operation);
}

export async function getRosterOperationSnapshotForOrganization(
  organizationId: number,
  operationId: string,
): Promise<RosterOperationSemanticSnapshot | undefined> {
  const operation = await getPaymentOperationForOrganization(organizationId, operationId);
  if (!operation) return undefined;
  return loadRosterOperationSnapshot(db, operation);
}

export async function getPaymentOperationForOrganization(
  organizationId: number,
  operationId: string,
): Promise<PaymentOperation | undefined> {
  const [operation] = await db
    .select()
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.id, operationId),
    ))
    .limit(1);
  return operation;
}

export async function getGeneralInteractivePaymentOperationForOrganization(
  organizationId: number,
  requestKey: string,
): Promise<PaymentOperation | undefined> {
  const [operation] = await db
    .select()
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.targetKey, buildGeneralInteractiveTargetKey(requestKey)),
    ))
    .limit(1);
  return operation;
}

export async function getRefundPaymentOperationForOrganization(
  organizationId: number,
  paymentId: number,
): Promise<PaymentOperation | undefined> {
  const [operation] = await db.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, organizationId),
    eq(paymentOperations.operationType, "refund"),
    eq(paymentOperations.targetKey, refundTargetKey(paymentId)),
  )).limit(1);
  return operation;
}

/** Re-open only a refund that was terminalized by the old config-failure path. */
export async function retryRefundPaymentOperationAfterConfigurationFailure(
  input: { organizationId: number; operationId: string; now?: Date },
): Promise<PaymentOperation | undefined> {
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const [retry] = await db
    .update(paymentOperations)
    .set({
      status: "retry_scheduled",
      nextAttemptAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.status, "failed_terminal"),
      eq(paymentOperations.errorClassification, "configuration"),
    ))
    .returning();
  return retry;
}

async function throwInvalidTransition(
  organizationId: number,
  operationId: string,
): Promise<never> {
  const operation = await getPaymentOperationForOrganization(organizationId, operationId);
  if (!operation) throw new PaymentOperationNotFoundError();
  throw new PaymentOperationInvalidTransitionError(operation.status);
}

/** One conditional UPDATE owns both first acquisition and expired recovery. */
export async function acquirePaymentOperationLease(
  input: AcquirePaymentOperationLeaseInput,
): Promise<PaymentOperation | undefined> {
  validateLeaseOwner(input.leaseOwner);
  if (
    !Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 1_000
    || input.leaseDurationMs > PAYMENT_OPERATION_MAX_LEASE_MS
  ) {
    throw new PaymentOperationValidationError("leaseDurationMs is outside the bounded lease window");
  }

  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const leaseExpiresAt = new Date(nowDate.getTime() + input.leaseDurationMs).toISOString();
  const leaseToken = randomUUID();

  const [leased] = await db
    .update(paymentOperations)
    .set({
      status: "leased",
      // A provider configuration outage is not a provider-attempt budget
      // failure. Keep the bounded attempt count unchanged while the same
      // immutable operation waits for credentials/configuration to be
      // repaired; the operation must remain leaseable with its original
      // provider identity.
      attemptCount: sql`CASE
        WHEN ${paymentOperations.status} = 'retry_scheduled'
          AND ${paymentOperations.errorClassification} = 'configuration'
        THEN ${paymentOperations.attemptCount}
        ELSE ${paymentOperations.attemptCount} + 1
      END`,
      nextAttemptAt: null,
      leaseOwner: input.leaseOwner,
      leaseToken,
      leaseExpiresAt,
      leaseRecoveryCount: sql`CASE
        WHEN ${paymentOperations.status} = 'leased'
        THEN ${paymentOperations.leaseRecoveryCount} + 1
        ELSE ${paymentOperations.leaseRecoveryCount}
      END`,
      // A recovered lease receives a fresh fencing token and must acquire a
      // fresh one-shot dispatch cutoff. The provider identity remains
      // immutable, so replay after an in-flight/unknown request is still the
      // exact idempotent request rather than a new charge.
      dispatchClaimedAt: sql`CASE
        WHEN ${paymentOperations.status} = 'leased' THEN NULL
        ELSE ${paymentOperations.dispatchClaimedAt}
      END`,
      lastLeaseRecoveredAt: sql`CASE
        WHEN ${paymentOperations.status} = 'leased' THEN ${now}
        ELSE ${paymentOperations.lastLeaseRecoveredAt}
      END`,
      errorClassification: null,
      errorCode: null,
      startedAt: sql`COALESCE(${paymentOperations.startedAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      or(
        lt(paymentOperations.attemptCount, PAYMENT_OPERATION_MAX_ATTEMPTS),
        and(
          eq(paymentOperations.status, "retry_scheduled"),
          eq(paymentOperations.errorClassification, "configuration"),
        ),
      ),
      or(
        and(
          inArray(paymentOperations.status, ["pending", "provider_unknown", "retry_scheduled"]),
          lte(paymentOperations.nextAttemptAt, now),
        ),
        and(
          eq(paymentOperations.status, "leased"),
          lte(paymentOperations.leaseExpiresAt, now),
        ),
      ),
    ))
    .returning();
  return leased;
}

/**
 * Claim the one-shot F2 interactive dispatch window under the same
 * organization/league advisory lock used by occurrence cancellation. A
 * leased row without this marker is still cancellable; once the marker is
 * committed, cancellation preserves the exact in-flight identity for
 * provider reconciliation.
 */
export async function acquireInteractivePaymentOperationDispatchCutoff(input: {
  organizationId: number;
  operationId: string;
  leaseToken: string;
  now?: Date;
}): Promise<boolean | null> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: paymentOperations.leagueId })
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.operationType, "interactive_charge"),
      ))
      .limit(1);
    // The retired D2 occurrence supplement used to provide this scope. A
    // retained operation with no ledger league remains on legacy behavior;
    // a roster operation never reaches this provider path.
    if (!scope || scope.leagueId === null) return null;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${scope.leagueId}::integer)`);
    const [operation] = await tx.select({
      status: paymentOperations.status,
      leaseToken: paymentOperations.leaseToken,
      providerObjectId: paymentOperations.providerObjectId,
      dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
    }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.operationType, "interactive_charge"),
    )).for("update");
    if (!operation || operation.status !== "leased" || operation.leaseToken !== input.leaseToken) return false;
    try {
      await validateRosterSnapshotForDispatchInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: scope.leagueId,
        operationId: input.operationId,
      });
    } catch (error) {
      if (!isRosterSnapshotFinalizationError(error)) throw error;
      await releaseRosterReservationsWithoutProviderEvidence(tx, {
        organizationId: input.organizationId,
        leagueId: scope.leagueId,
        operationId: input.operationId,
      });
      const blockedAt = (input.now ?? new Date()).toISOString();
      await tx.update(paymentOperations).set({
        status: "reconciliation_required",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        dispatchClaimedAt: null,
        errorClassification: "internal",
        errorCode: error.code,
        completedAt: blockedAt,
        updatedAt: blockedAt,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
      ));
      return false;
    }
    const claimedAt = (input.now ?? new Date()).toISOString();
    const [claimed] = await tx.update(paymentOperations).set({
      dispatchClaimedAt: claimedAt,
      updatedAt: claimedAt,
    }).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      isNull(paymentOperations.dispatchClaimedAt),
    )).returning({ id: paymentOperations.id });
    return Boolean(claimed);
  });
}

/** Standing-autopay dispatch fence. Consent/link/membership evidence is
 * revalidated under the same league lock immediately before provider I/O. */
export async function acquireStandingAutopayDispatchCutoff(input: {
  organizationId: number;
  operationId: string;
  leaseToken: string;
  now?: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: paymentOperations.leagueId })
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.operationType, "standing_autopay_charge"),
      )).limit(1);
    if (!scope?.leagueId) return false;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${scope.leagueId}::integer)`);
    const [operation] = await tx.select({
      status: paymentOperations.status,
      leaseToken: paymentOperations.leaseToken,
      providerObjectId: paymentOperations.providerObjectId,
      dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
    }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.operationType, "standing_autopay_charge"),
    )).limit(1).for("update");
    if (!operation || operation.status !== "leased" || operation.leaseToken !== input.leaseToken) return false;
    try {
      await validateStandingConsentForDispatchInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: scope.leagueId,
        operationId: input.operationId,
        leagueIdAlreadyLocked: true,
      });
    } catch (error) {
      await releaseRosterReservationsWithoutProviderEvidence(tx, {
        organizationId: input.organizationId,
        leagueId: scope.leagueId,
        operationId: input.operationId,
      });
      const blockedAt = (input.now ?? new Date()).toISOString();
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "STANDING_DISPATCH_INVALID";
      const providerEvidenceExists = operation.providerObjectId !== null || operation.dispatchClaimedAt !== null;
      await tx.update(paymentOperations).set({
        status: providerEvidenceExists ? "reconciliation_required" : "canceled",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        dispatchClaimedAt: null,
        // `canceled` is a clean terminal state in the ledger and therefore
        // cannot carry an error classification/code (the DB state-shape
        // guard deliberately reserves those fields for retry/error states).
        errorClassification: providerEvidenceExists ? "internal" : null,
        errorCode: providerEvidenceExists ? code : null,
        completedAt: blockedAt,
        updatedAt: blockedAt,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
      ));
      return false;
    }
    const claimedAt = (input.now ?? new Date()).toISOString();
    const [claimed] = await tx.update(paymentOperations).set({ dispatchClaimedAt: claimedAt, updatedAt: claimedAt }).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      isNull(paymentOperations.dispatchClaimedAt),
    )).returning({ id: paymentOperations.id });
    return Boolean(claimed);
  });
}

export async function schedulePaymentOperationRetry(
  input: ErrorOutcomeInput & {
    nextAttemptAt: Date;
    errorClassification: PaymentOperationErrorClassification;
  },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerObjectId != null) validateProviderObjectId(input.providerObjectId);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const nextAttemptAt = validateFutureDueAt(input.nextAttemptAt, nowDate, "nextAttemptAt");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const updated = await db.transaction(async (tx) => {
    await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        status: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN 'failed_terminal'
          ELSE 'retry_scheduled'
        END`,
        nextAttemptAt: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN NULL::timestamp
          ELSE ${nextAttemptAt}::timestamp
        END`,
        leaseOwner: null,
        leaseToken: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN ${paymentOperations.leaseToken}
          ELSE NULL
        END`,
        leaseExpiresAt: null,
        dispatchClaimedAt: sql`NULL`,
        providerObjectId: input.providerObjectId ?? undefined,
        providerOrderId: input.providerOrderId ?? undefined,
        errorClassification: input.errorClassification,
        errorCode: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN 'ATTEMPTS_EXHAUSTED'
          ELSE ${errorCode}
        END`,
        completedAt: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN ${now}::timestamp
          ELSE NULL::timestamp
        END`,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
        input.providerObjectId == null
          ? undefined
          : or(isNull(paymentOperations.providerObjectId), eq(paymentOperations.providerObjectId, input.providerObjectId)),
        input.providerOrderId == null
          ? undefined
          : or(
            isNull(paymentOperations.providerOrderId),
            eq(paymentOperations.providerOrderId, input.providerOrderId),
          ),
      ))
      .returning();
    if (transitioned?.status === "failed_terminal") {
      await insertLinkedPaymentRows(
        tx,
        input.organizationId,
        input.operationId,
        input.failedPaymentRows,
      );
    }
    return transitioned;
  });
  if (!updated) return throwInvalidTransition(input.organizationId, input.operationId);
  return updated;
}

export async function recordPaymentOperationProviderUnknown(
  input: ErrorOutcomeInput & { recoveryAt: Date },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerObjectId != null) validateProviderObjectId(input.providerObjectId);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const nextAttemptAt = validateFutureDueAt(input.recoveryAt, nowDate, "recoveryAt");
  const errorCode = validateErrorDetails("provider_unknown", input.errorCode);

  const updated = await db.transaction(async (tx) => {
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        status: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN 'reconciliation_required'
          ELSE 'provider_unknown'
        END`,
        nextAttemptAt: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN NULL::timestamp
          ELSE ${nextAttemptAt}::timestamp
        END`,
        leaseOwner: null,
        leaseToken: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN ${paymentOperations.leaseToken}
          ELSE NULL
        END`,
        leaseExpiresAt: null,
        // The provider-unknown operation retains its immutable provider
        // identity, but a future lease must acquire a fresh dispatch cutoff.
        dispatchClaimedAt: sql`NULL`,
        providerObjectId: input.providerObjectId ?? undefined,
        providerOrderId: input.providerOrderId ?? undefined,
        errorClassification: "provider_unknown",
        errorCode: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN 'PROVIDER_OUTCOME_UNCERTAIN'
          ELSE ${errorCode}
        END`,
        completedAt: sql`CASE
          WHEN ${paymentOperations.attemptCount} >= ${PAYMENT_OPERATION_MAX_ATTEMPTS}
          THEN ${now}::timestamp
          ELSE NULL::timestamp
        END`,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
        input.providerObjectId == null
          ? undefined
          : or(isNull(paymentOperations.providerObjectId), eq(paymentOperations.providerObjectId, input.providerObjectId)),
        input.providerOrderId == null
          ? undefined
          : or(
            isNull(paymentOperations.providerOrderId),
            eq(paymentOperations.providerOrderId, input.providerOrderId),
          ),
      ))
      .returning();
    // An exhausted unknown result is not proof of failure. Keep the exact
    // provider identity and fencing token for explicit reconciliation, and
    // deliberately omit a failed payment-history row.
    return transitioned;
  });
  if (!updated) return throwInvalidTransition(input.organizationId, input.operationId);
  return updated;
}

/**
 * Configuration/authentication failures are recoverable operator state, not
 * proof that the refund failed. Keep the operation due and preserve its
 * immutable provider idempotency key. Configuration retries do not consume
 * the provider-attempt budget, so repairing credentials can recover even
 * after repeated checks while the outage is active.
 */
export async function recordPaymentOperationConfigurationRetry(
  input: ErrorOutcomeInput & { recoveryAt: Date },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerObjectId != null) validateProviderObjectId(input.providerObjectId);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const recoveryAt = validateFutureDueAt(input.recoveryAt, nowDate, "recoveryAt");
  const errorCode = validateErrorDetails("configuration", input.errorCode);

  const [transitioned] = await db
    .update(paymentOperations)
    .set({
      status: "retry_scheduled",
      nextAttemptAt: recoveryAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      dispatchClaimedAt: sql`NULL`,
      providerObjectId: input.providerObjectId ?? undefined,
      providerOrderId: input.providerOrderId ?? undefined,
      errorClassification: "configuration",
      errorCode,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      input.providerObjectId == null
        ? undefined
        : or(isNull(paymentOperations.providerObjectId), eq(paymentOperations.providerObjectId, input.providerObjectId)),
      input.providerOrderId == null
        ? undefined
        : or(isNull(paymentOperations.providerOrderId), eq(paymentOperations.providerOrderId, input.providerOrderId)),
    ))
    .returning();
  if (!transitioned) return throwInvalidTransition(input.organizationId, input.operationId);
  return transitioned;
}

async function recordTerminalErrorOutcome(
  input: ErrorOutcomeInput & {
    status: "action_required" | "reconciliation_required" | "failed_terminal";
    errorClassification: PaymentOperationErrorClassification;
  },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerObjectId != null) validateProviderObjectId(input.providerObjectId);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const now = toIso(input.now ?? new Date(), "now");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const updated = await db.transaction(async (tx) => {
    await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        status: input.status,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        providerObjectId: input.providerObjectId ?? undefined,
        providerOrderId: input.providerOrderId ?? undefined,
        errorClassification: input.errorClassification,
        errorCode,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        eq(paymentOperations.leaseToken, input.leaseToken),
        input.providerObjectId == null
          ? undefined
          : or(isNull(paymentOperations.providerObjectId), eq(paymentOperations.providerObjectId, input.providerObjectId)),
        input.providerOrderId == null
          ? undefined
          : or(
            isNull(paymentOperations.providerOrderId),
            eq(paymentOperations.providerOrderId, input.providerOrderId),
          ),
      ))
      .returning();
    if (!transitioned) return undefined;
    await insertLinkedPaymentRows(
      tx,
      input.organizationId,
      input.operationId,
      input.failedPaymentRows,
    );
    // A deterministic terminal failure before dispatch must not strand the
    // cutoff reservation. Once dispatch has started we retain the reservation
    // as fail-closed evidence until provider reconciliation resolves it.
    if (
      transitioned.operationType === "standing_autopay_charge"
      && transitioned.leagueId !== null
      && (transitioned.dispatchClaimedAt === null || transitioned.status === "action_required")
      && transitioned.providerObjectId === null
    ) {
      await releaseRosterReservationsWithoutProviderEvidence(tx, {
        organizationId: input.organizationId,
        leagueId: transitioned.leagueId,
        operationId: transitioned.id,
      });
    }
    return transitioned;
  });
  if (updated) return updated;

  const existing = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
  if (!existing) throw new PaymentOperationNotFoundError();
  if (
    existing.status === input.status
    && existing.leaseToken === input.leaseToken
    && existing.errorClassification === input.errorClassification
    && existing.errorCode === errorCode
    && (input.providerObjectId == null || existing.providerObjectId === input.providerObjectId)
    && (input.providerOrderId == null || existing.providerOrderId === input.providerOrderId)
  ) {
    return existing;
  }
  throw new PaymentOperationInvalidTransitionError(existing.status);
}

export async function recordPaymentOperationActionRequired(
  input: ErrorOutcomeInput,
): Promise<PaymentOperation> {
  return recordTerminalErrorOutcome({
    ...input,
    status: "action_required",
    errorClassification: "hard_decline",
  });
}

export async function recordPaymentOperationReconciliationRequired(
  input: LeasedPaymentOperationInput & {
    errorCode?: string | null;
    providerObjectId?: string | null;
    providerOrderId?: string | null;
  },
): Promise<PaymentOperation> {
  return recordTerminalErrorOutcome({
    ...input,
    status: "reconciliation_required",
    errorClassification: "provider_unknown",
  });
}

export async function recordPaymentOperationFailedTerminal(
  input: ErrorOutcomeInput & { errorClassification: PaymentOperationErrorClassification },
): Promise<PaymentOperation> {
  return recordTerminalErrorOutcome({ ...input, status: "failed_terminal" });
}

export type FinalizePaymentOperationSuccessInput = LeasedPaymentOperationInput & {
  providerObjectId: string;
  providerOrderId?: string | null;
  paymentRows?: PaymentOperationLinkedPaymentInput[];
};

export async function finalizePaymentOperationSuccessInTransaction(
  tx: PaymentOperationTransaction,
  input: FinalizePaymentOperationSuccessInput,
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateProviderObjectId(input.providerObjectId);
  validateLinkedPaymentRows(input.paymentRows);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const now = toIso(input.now ?? new Date(), "now");
  if (input.providerOrderId == null) {
    const [rosterSnapshot] = await tx.select({ requestKind: paymentOperationRosterSnapshots.requestKind })
      .from(paymentOperationRosterSnapshots)
      .where(eq(paymentOperationRosterSnapshots.operationId, input.operationId))
      .limit(1);
    if (rosterSnapshot?.requestKind === "order") throw new PaymentOperationImmutableMismatchError();
  }
  const preflightOperation = await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
  const cancellationReviewRequired = false;
  if (preflightOperation) {
    // Provider identities are immutable evidence. A reclaim/finalization may
    // fill a previously empty identity, but it may never replace one retained
    // from an earlier dispatch or reconciliation attempt.
    if ((preflightOperation.providerObjectId !== null
      && preflightOperation.providerObjectId !== input.providerObjectId)
      || (preflightOperation.providerOrderId !== null
        && preflightOperation.providerOrderId !== input.providerOrderId)) {
      throw new PaymentOperationImmutableMismatchError();
    }
  }

  const [transitioned] = await tx
    .update(paymentOperations)
    .set({
      status: cancellationReviewRequired ? "reconciliation_required" : "succeeded",
      providerObjectId: input.providerObjectId,
      providerOrderId: input.providerOrderId ?? undefined,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorClassification: cancellationReviewRequired ? "provider_unknown" : null,
      errorCode: cancellationReviewRequired ? "CANCELLATION_REVIEW" : null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      input.providerOrderId == null
        ? undefined
        : or(
          isNull(paymentOperations.providerOrderId),
          eq(paymentOperations.providerOrderId, input.providerOrderId),
        ),
    ))
    .returning();
  if (transitioned) {
    await insertLinkedPaymentRows(
      tx,
      input.organizationId,
      input.operationId,
      input.paymentRows,
    );
    if (!cancellationReviewRequired && transitioned.leagueId !== null) {
      try {
        await tx.transaction(async (finalizerTx) => {
          await finalizeRosterSnapshotInTransaction(finalizerTx, {
            organizationId: input.organizationId,
            leagueId: transitioned.leagueId ?? 0,
            operationId: transitioned.id,
            now,
            actorUserId: transitioned.authorizingUserId,
          });
        });
      } catch (error) {
        if (!isRosterSnapshotFinalizationError(error)) throw error;
        const [reviewed] = await tx.update(paymentOperations).set({
          status: "reconciliation_required",
          nextAttemptAt: null,
          errorClassification: "internal",
          errorCode: error.code,
          completedAt: now,
          updatedAt: now,
        }).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.id, transitioned.id),
          eq(paymentOperations.status, "succeeded"),
        )).returning();
        return reviewed ?? transitioned;
      }
    }
    return transitioned;
  }

  const [existing] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.id, input.operationId),
  )).limit(1);
  if (!existing) throw new PaymentOperationNotFoundError();
  if (
    existing.status === "succeeded"
    && existing.leaseToken === input.leaseToken
    && existing.providerObjectId === input.providerObjectId
    && (input.providerOrderId == null || existing.providerOrderId === input.providerOrderId)
  ) {
    if ((existing.operationType === "interactive_charge" || existing.operationType === "standing_autopay_charge") && existing.leagueId !== null) {
      try {
        await tx.transaction(async (finalizerTx) => {
          await finalizeRosterSnapshotInTransaction(finalizerTx, {
            organizationId: input.organizationId,
            leagueId: existing.leagueId as number,
            operationId: existing.id,
            now,
            actorUserId: existing.authorizingUserId,
          });
        });
      } catch (error) {
        if (!isRosterSnapshotFinalizationError(error)) throw error;
        const [reviewed] = await tx.update(paymentOperations).set({
          status: "reconciliation_required",
          nextAttemptAt: null,
          errorClassification: "internal",
          errorCode: error.code,
          updatedAt: now,
        }).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.id, existing.id),
          eq(paymentOperations.status, "succeeded"),
        )).returning();
        return reviewed ?? existing;
      }
    }
    return existing;
  }
  if (
    existing.status === "reconciliation_required"
    && existing.leaseToken === input.leaseToken
    && existing.providerObjectId === input.providerObjectId
    && (input.providerOrderId == null || existing.providerOrderId === input.providerOrderId)
  ) return existing;
  throw new PaymentOperationInvalidTransitionError(existing.status);
}

export async function finalizePaymentOperationSuccess(
  input: FinalizePaymentOperationSuccessInput,
): Promise<PaymentOperation> {
  return db.transaction((tx) => finalizePaymentOperationSuccessInTransaction(tx, input));
}

export async function finalizeRefundPaymentOperationSuccess(input: LeasedPaymentOperationInput & {
  providerObjectId: string;
}): Promise<{ operation: PaymentOperation; payment: Payment }> {
  validateLeaseToken(input.leaseToken);
  validateProviderObjectId(input.providerObjectId);
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
    )).limit(1).for("update");
    if (!operation) throw new PaymentOperationNotFoundError();
    const snapshot = await loadRefundPaymentOperationSnapshot(tx, operation);
    if (!snapshot) throw new PaymentOperationImmutableMismatchError();
    if (
      !["leased", "succeeded"].includes(operation.status)
      || operation.leaseToken !== input.leaseToken
    ) {
      throw new PaymentOperationInvalidTransitionError(operation.status);
    }
    return finalizeRefundFromWebhookEvidenceInTransaction(tx, {
      organizationId: operation.organizationId,
      operationId: operation.id,
      locationId: snapshot.locationId,
      providerObjectId: input.providerObjectId,
      providerPaymentId: snapshot.providerPaymentId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      now: input.now,
    });
  });
}

export interface ProviderWebhookCompletionEvidence {
  organizationId: number;
  operationId: string;
  locationId: number;
  providerLocationId?: string;
  providerObjectId: string;
  providerPaymentId: string;
  providerOrderId?: string | null;
  amountMinor: number;
  currency: string;
  receiptUrl?: string | null;
  receiptNumber?: string | null;
  now?: Date;
}

const webhookCompletableStatuses = new Set<PaymentOperation["status"]>([
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "reconciliation_required",
]);

function rosterWebhookPaymentRows(
  operation: PaymentOperation,
  snapshot: RosterOperationSemanticSnapshot,
  input: ProviderWebhookCompletionEvidence,
): PaymentOperationLinkedPaymentInput[] {
  return snapshot.allocations.map((allocation) => ({
    allocationIndex: allocation.allocationIndex,
    values: {
      bowlerId: allocation.bowlerId,
      leagueId: snapshot.leagueId,
      amount: allocation.amountMinor,
      lineageAmount: allocation.lineageAmountMinor,
      prizeFundAmount: allocation.prizeFundAmountMinor,
      weekOf: allocation.weekOf,
      status: "paid" as const,
      type: providerNameToPaymentType(snapshot.providerName),
      providerPaymentId: input.providerPaymentId,
      receiptUrl: input.receiptUrl ?? undefined,
      receiptNumber: input.receiptNumber ?? undefined,
      receiptEmailMissing: snapshot.buyerEmail === null,
      combinedChargeGroupId: snapshot.combinedChargeGroupId,
      idempotencyKey: allocation.allocationIndex === 0 ? operation.id : undefined,
      notes: allocation.notes,
      paidByUserId: allocation.paidByUserId,
    },
  }));
}

/**
 * Conclusive signed provider evidence uses the same local invariants and row
 * insertion primitive as executor finalization, but never calls a provider.
 * The caller must already hold the inbox event row lock in this transaction.
 */
export async function finalizeChargeFromWebhookEvidenceInTransaction(
  tx: PaymentOperationTransaction,
  input: ProviderWebhookCompletionEvidence,
): Promise<PaymentOperation> {
  validateProviderObjectId(input.providerObjectId);
  if (input.providerObjectId !== input.providerPaymentId) {
    throw new PaymentOperationImmutableMismatchError();
  }
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const now = toIso(input.now ?? new Date(), "now");
  const operation = await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
  if (!operation || !["interactive_charge", "standing_autopay_charge"].includes(operation.operationType)) {
    throw new PaymentOperationNotFoundError();
  }
  if (
    operation.providerName !== "square"
    || operation.amountMinor !== input.amountMinor
    || operation.currency !== input.currency
    || (operation.providerObjectId !== null && operation.providerObjectId !== input.providerObjectId)
    || (operation.providerOrderId !== null && operation.providerOrderId !== input.providerOrderId)
  ) throw new PaymentOperationImmutableMismatchError();

  let rows: PaymentOperationLinkedPaymentInput[] = [];
  if (operation.operationType === "interactive_charge") {
    const snapshot = await loadRosterOperationSnapshot(tx, operation);
    if (
      !snapshot
      || snapshot.locationId !== input.locationId
      || (snapshot.providerLocationId !== null
        && snapshot.providerLocationId !== input.providerLocationId)
    ) throw new PaymentOperationImmutableMismatchError();
    rows = rosterWebhookPaymentRows(operation, snapshot, input);
  } else if (operation.operationType === "standing_autopay_charge") {
    const [binding] = await tx.select({ providerLocationId: paymentOperationStandingAutopayBindings.providerLocationId, collectionMode: paymentOperationStandingAutopayBindings.collectionMode }).from(paymentOperationStandingAutopayBindings).innerJoin(autopayConsents, and(
      eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId),
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, operation.leagueId ?? 0),
    )).where(and(
      eq(paymentOperationStandingAutopayBindings.operationId, operation.id),
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, operation.leagueId ?? 0),
    )).limit(1);
    if (!binding || binding.providerLocationId !== input.providerLocationId) throw new PaymentOperationImmutableMismatchError();
    const standingRows = await tx.select({ item: paymentOperationRosterSnapshotItems, obligation: paymentObligations }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, operation.leagueId ?? 0),
    )).where(and(
      eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, operation.leagueId ?? 0),
    )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
    rows = standingRows.map((row) => ({
      allocationIndex: row.item.allocationIndex,
      values: {
        bowlerId: row.obligation.payerBowlerId,
        leagueId: operation.leagueId ?? 0,
        amount: row.item.amountMinor,
        lineageAmount: null,
        prizeFundAmount: null,
        weekOf: row.obligation.dueAt,
        status: "paid" as const,
        type: providerNameToPaymentType(operation.providerName),
        providerPaymentId: input.providerObjectId,
        receiptUrl: input.receiptUrl ?? undefined,
        receiptNumber: input.receiptNumber ?? undefined,
        receiptEmailMissing: false,
        combinedChargeGroupId: binding.collectionMode === "double_pay" ? operation.id : null,
        paidByUserId: operation.authorizingUserId,
        notes: "Roster standing automatic payment",
      },
    }));
    if (rows.length === 0) throw new PaymentOperationImmutableMismatchError();
  }

  if (operation.status === "succeeded") {
    if (operation.providerObjectId !== input.providerObjectId) {
      throw new PaymentOperationImmutableMismatchError();
    }
    if ((operation.operationType === "interactive_charge" || operation.operationType === "standing_autopay_charge") && operation.leagueId !== null) {
      try {
        await tx.transaction(async (finalizerTx) => {
          await finalizeRosterSnapshotInTransaction(finalizerTx, {
            organizationId: input.organizationId,
            leagueId: operation.leagueId as number,
            operationId: operation.id,
            now,
            actorUserId: operation.authorizingUserId,
          });
        });
      } catch (error) {
        if (!isRosterSnapshotFinalizationError(error)) throw error;
        const [reviewed] = await tx.update(paymentOperations).set({
          status: "reconciliation_required",
          nextAttemptAt: null,
          errorClassification: "internal",
          errorCode: error.code,
          updatedAt: now,
        }).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.id, operation.id),
          eq(paymentOperations.status, "succeeded"),
        )).returning();
        return reviewed ?? operation;
      }
    }
    return operation;
  }
  if (!webhookCompletableStatuses.has(operation.status)) {
    throw new PaymentOperationInvalidTransitionError(operation.status);
  }
  let leaseToken = operation.leaseToken;
  if (operation.status !== "leased") {
    leaseToken = randomUUID();
    const [leased] = await tx.update(paymentOperations).set({
      status: "leased",
      nextAttemptAt: null,
      leaseOwner: "square-webhook",
      leaseToken,
      leaseExpiresAt: new Date(new Date(now).getTime() + PAYMENT_OPERATION_MAX_LEASE_MS).toISOString(),
      errorClassification: null,
      errorCode: null,
      completedAt: null,
      updatedAt: now,
    }).where(and(
      eq(paymentOperations.id, operation.id),
      eq(paymentOperations.organizationId, operation.organizationId),
      eq(paymentOperations.status, operation.status),
      operation.leaseToken === null
        ? isNull(paymentOperations.leaseToken)
        : eq(paymentOperations.leaseToken, operation.leaseToken),
    )).returning();
    if (!leased) throw new PaymentOperationInvalidTransitionError(operation.status);
  }
  if (!leaseToken) throw new PaymentOperationInvalidTransitionError(operation.status);
  return finalizePaymentOperationSuccessInTransaction(tx, {
    organizationId: input.organizationId,
    operationId: operation.id,
    leaseToken,
    providerObjectId: input.providerObjectId,
    providerOrderId: input.providerOrderId,
    paymentRows: rows,
    now: input.now,
  });
}

export async function finalizeRefundFromWebhookEvidenceInTransaction(
  tx: PaymentOperationTransaction,
  input: ProviderWebhookCompletionEvidence,
): Promise<{ operation: PaymentOperation; payment: Payment }> {
  validateProviderObjectId(input.providerObjectId);
  const now = toIso(input.now ?? new Date(), "now");
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.id, input.operationId),
    eq(paymentOperations.operationType, "refund"),
  )).limit(1).for("update");
  if (!operation) throw new PaymentOperationNotFoundError();
  const snapshot = await loadRefundPaymentOperationSnapshot(tx, operation);
  if (
    !snapshot
    || operation.providerName !== "square"
    || operation.amountMinor !== input.amountMinor
    || operation.currency !== input.currency
    || snapshot.locationId !== input.locationId
    || snapshot.providerPaymentId !== input.providerPaymentId
    || (operation.providerObjectId !== null && operation.providerObjectId !== input.providerObjectId)
  ) throw new PaymentOperationImmutableMismatchError();

  const [currentPayment] = await tx.select().from(payments)
    .where(eq(payments.id, snapshot.paymentId)).limit(1).for("update");
  if (operation.status === "succeeded") {
    if (
      operation.providerObjectId !== input.providerObjectId
      || currentPayment?.status !== "refunded"
      || currentPayment.squareRefundId !== input.providerObjectId
    ) throw new PaymentOperationImmutableMismatchError();
    return { operation, payment: currentPayment };
  }
  if (!webhookCompletableStatuses.has(operation.status) || currentPayment?.status !== "paid") {
    throw new PaymentOperationInvalidTransitionError(operation.status);
  }
  const [payment] = await tx.update(payments).set({
    status: "refunded",
    squareRefundId: input.providerObjectId,
    refundReason: snapshot.requestedReason,
    refundedAt: now,
  }).where(and(
    eq(payments.id, snapshot.paymentId),
    eq(payments.leagueId, snapshot.leagueId),
    eq(payments.amount, snapshot.amountMinor),
    eq(payments.providerPaymentId, snapshot.providerPaymentId),
    eq(payments.status, "paid"),
  )).returning();
  if (!payment) throw new PaymentOperationImmutableMismatchError();
  const [completed] = await tx.update(paymentOperations).set({
    status: "succeeded",
    providerObjectId: input.providerObjectId,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    errorClassification: null,
    errorCode: null,
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(paymentOperations.id, operation.id),
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.status, operation.status),
    operation.leaseToken === null
      ? isNull(paymentOperations.leaseToken)
      : eq(paymentOperations.leaseToken, operation.leaseToken),
    or(isNull(paymentOperations.providerObjectId), eq(paymentOperations.providerObjectId, input.providerObjectId)),
  )).returning();
  if (!completed) throw new PaymentOperationInvalidTransitionError(operation.status);
  return { operation: completed, payment };
}

export type PaymentOperationWake = {
  kind: "operation";
  organizationId: number;
  operationId: string;
  operationType: PaymentOperation["operationType"];
  status: PaymentOperation["status"];
  attemptCount: number;
  dueAt: string;
};

/** Work generated only from an active PR2 standing consent.  This is kept
 * separate from PaymentOperationWake so the retired schedule worker cannot
 * accidentally wake standing work (or vice versa). */
export type StandingAutopayWake = {
  kind: "standing_cutoff";
  organizationId: number;
  leagueId: number;
  consentId: string;
  dueAt: string;
} | {
  kind: "standing_operation";
  organizationId: number;
  operationId: string;
  dueAt: string;
  status: PaymentOperation["status"];
  attemptCount: number;
};

/**
 * Return the earliest standing-consent cutoff or retry.  The query deliberately
 * does not join any retired schedule or plan table. Reservations are
 * considered only while unresolved; finalized evidence is history and must not
 * suppress a later partial collection.
 */
export async function getNextStandingAutopayWake(): Promise<StandingAutopayWake | undefined> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return undefined;
  const result = await db.execute<{
    kind: "standing_cutoff" | "standing_operation";
    organization_id: number;
    league_id: number | null;
    consent_id: string | null;
    work_id: string | null;
    status: PaymentOperation["status"] | null;
    attempt_count: number | null;
    due_at: string;
  }>(sql`
    WITH next_cutoff AS (
      SELECT
        'standing_cutoff'::text AS kind,
        c.organization_id,
        c.league_id,
        c.id::text AS consent_id,
        NULL::text AS work_id,
        NULL::text AS status,
        NULL::integer AS attempt_count,
        MIN(o.due_at) AS due_at
      FROM autopay_consents c
      INNER JOIN payment_obligations o
        ON o.organization_id = c.organization_id
       AND o.league_id = c.league_id
       AND o.state IN ('open', 'partially_settled')
       AND o.due_at IS NOT NULL
       AND o.due_at >= c.activated_at
      INNER JOIN league_occurrences cutoff_occurrence
        ON cutoff_occurrence.id = o.occurrence_id
       AND cutoff_occurrence.organization_id = o.organization_id
       AND cutoff_occurrence.league_id = o.league_id
       AND NOT EXISTS (
         SELECT 1 FROM payment_operation_roster_snapshot_items ri
         WHERE ri.organization_id = o.organization_id
           AND ri.league_id = o.league_id
           AND ri.obligation_id = o.id
           AND ri.state = 'reserved'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM canonical_collection_group_members paired_member
           INNER JOIN canonical_collection_groups paired_group
             ON paired_group.id = paired_member.group_id
            AND paired_group.organization_id = paired_member.organization_id
            AND paired_group.league_id = paired_member.league_id
          WHERE paired_member.organization_id = o.organization_id
            AND paired_member.league_id = o.league_id
            AND paired_member.occurrence_id = o.occurrence_id
            AND paired_member.role = 'paired'
            AND paired_member.active = true
            AND paired_group.state = 'published'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM payment_operations blocked
           INNER JOIN payment_operation_standing_autopay_bindings blocked_binding
             ON blocked_binding.operation_id = blocked.id
            AND blocked_binding.organization_id = blocked.organization_id
            AND blocked_binding.league_id = blocked.league_id
          WHERE blocked.organization_id = c.organization_id
            AND blocked.league_id = c.league_id
            AND blocked.operation_type = 'standing_autopay_charge'
            AND blocked.status IN ('canceled', 'failed_terminal', 'action_required', 'reconciliation_required')
            AND blocked_binding.consent_id = c.id
            AND blocked_binding.consent_version = c.consent_version
           AND blocked.trigger_occurrence_id = cutoff_occurrence.id
           AND blocked.target_key LIKE concat(
              'standing-autopay:%:', cutoff_occurrence.current_revision
            )
       )
       AND NOT EXISTS (
         SELECT 1 FROM financial_commands decided
         WHERE decided.organization_id = c.organization_id
           AND decided.league_id = c.league_id
           AND decided.command_type = 'standing_autopay_cutoff'
           AND decided.idempotency_key = concat(c.id, ':', c.consent_version, ':', to_char(o.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ':', cutoff_occurrence.current_revision)
           AND decided.state = 'applied'
       )
       AND (
         o.payer_bowler_id = c.payer_bowler_id
         OR EXISTS (
           SELECT 1 FROM autopay_consent_partners cp
           WHERE cp.organization_id = c.organization_id
             AND cp.league_id = c.league_id
             AND cp.consent_id = c.id
             AND cp.consent_version = c.consent_version
             AND cp.partner_bowler_id = o.payer_bowler_id
         )
       )
      WHERE c.state = 'active'
        AND c.payment_mode = 'weekly'
        AND c.revoked_at IS NULL
      GROUP BY c.organization_id, c.league_id, c.id
      ORDER BY MIN(o.due_at) ASC, c.id ASC
      LIMIT 1
    ), next_operation AS (
      SELECT
        'standing_operation'::text AS kind,
        po.organization_id,
        po.league_id,
        NULL::text AS consent_id,
        po.id::text AS work_id,
        po.status,
        po.attempt_count,
        CASE WHEN po.status = 'leased' THEN po.lease_expires_at ELSE po.next_attempt_at END AS due_at
      FROM payment_operations po
      WHERE po.operation_type = 'standing_autopay_charge'
        AND po.status IN ('pending', 'provider_unknown', 'retry_scheduled', 'leased')
        AND (po.status <> 'provider_unknown' OR po.provider_object_id IS NULL)
        AND CASE WHEN po.status = 'leased' THEN po.lease_expires_at ELSE po.next_attempt_at END IS NOT NULL
      ORDER BY CASE WHEN po.status = 'leased' THEN po.lease_expires_at ELSE po.next_attempt_at END ASC, po.id ASC
      LIMIT 1
    )
    SELECT kind, organization_id, league_id, consent_id, work_id, status, attempt_count,
      (due_at AT TIME ZONE 'UTC')::text AS due_at
    FROM (
      SELECT * FROM next_cutoff
      UNION ALL
      SELECT * FROM next_operation
    ) standing_work
    ORDER BY due_at ASC, organization_id ASC, COALESCE(consent_id, work_id) ASC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.kind === "standing_cutoff") {
    if (row.league_id === null || row.consent_id === null) throw new PaymentOperationValidationError("standing cutoff wake row is incomplete");
    return { kind: "standing_cutoff", organizationId: Number(row.organization_id), leagueId: Number(row.league_id), consentId: row.consent_id, dueAt: row.due_at };
  }
  if (row.work_id === null || row.status === null || row.attempt_count === null) throw new PaymentOperationValidationError("standing operation wake row is incomplete");
  return { kind: "standing_operation", organizationId: Number(row.organization_id), operationId: row.work_id, dueAt: row.due_at, status: row.status, attemptCount: Number(row.attempt_count) };
}

/** Exported so PostgreSQL plan tests exercise the exact production query. */
export function buildNextPaymentOperationWakeQuery() {
  return sql`
    WITH next_operation AS (
      SELECT
        'operation'::text AS kind,
        ${paymentOperations.organizationId} AS organization_id,
        ${paymentOperations.id}::text AS work_id,
        ${paymentOperations.operationType} AS operation_type,
        ${paymentOperations.status} AS status,
        ${paymentOperations.attemptCount} AS attempt_count,
        NULL::integer AS league_id,
        CASE
          WHEN ${paymentOperations.status} = 'leased' THEN ${paymentOperations.leaseExpiresAt}
          ELSE ${paymentOperations.nextAttemptAt}
        END AS due_at
      FROM ${paymentOperations}
      WHERE (
        ${paymentOperations.operationType} IN ('interactive_charge', 'refund')
        AND (
          (${paymentOperations.status} IN ('pending', 'provider_unknown', 'retry_scheduled')
            AND ${paymentOperations.nextAttemptAt} IS NOT NULL)
          OR (${paymentOperations.status} = 'leased'
            AND ${paymentOperations.leaseExpiresAt} IS NOT NULL)
        )
      )
      ORDER BY due_at ASC, ${paymentOperations.id} ASC
      LIMIT 1
    )
    SELECT
      kind,
      organization_id,
      work_id,
      operation_type,
      status,
      attempt_count,
      league_id,
      (due_at AT TIME ZONE 'UTC')::text AS due_at
    FROM next_operation AS scheduled_payment_work
    ORDER BY scheduled_payment_work.due_at ASC
    LIMIT 1
  `;
}

/** One indexed query for the earliest schedule preparation or operation work. */
export async function getNextPaymentOperationWake(): Promise<PaymentOperationWake | undefined> {
  const result = await db.execute<{
    kind: "operation";
    organization_id: number;
    work_id: string;
    operation_type: PaymentOperation["operationType"] | null;
    status: PaymentOperation["status"] | null;
    attempt_count: number | null;
    league_id: number | null;
    due_at: string;
  }>(buildNextPaymentOperationWakeQuery());
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.operation_type === null || row.status === null || row.attempt_count === null) {
    throw new PaymentOperationValidationError("operation wake row is incomplete");
  }
  return {
    kind: "operation",
    organizationId: Number(row.organization_id),
    operationId: row.work_id,
    operationType: row.operation_type,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    dueAt: row.due_at,
  };
}

/**
 * Explicit operator reconciliation for a provider-unknown operation. This is
 * never called by the automatic wake executor: a confirmed provider success
 * must be supplied together with the exact retained fencing token.
 */
export async function reconcilePaymentOperationSuccess(
  input: LeasedPaymentOperationInput & {
    providerObjectId: string;
    providerOrderId?: string | null;
    paymentRows?: PaymentOperationLinkedPaymentInput[];
  },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateProviderObjectId(input.providerObjectId);
  validateLinkedPaymentRows(input.paymentRows);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const now = toIso(input.now ?? new Date(), "now");

  const updated = await db.transaction(async (tx) => {
    // Canonical reconciliation must enter through the same advisory → plan
    // → operation lock order as dispatch and revocation. The helper performs
    // only an unlocked scope read, then takes the canonical lock; legacy
    // operations retain their historical operation-row lock behavior.
    const current = await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
    if (!current) return undefined;
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        status: "succeeded",
        providerObjectId: input.providerObjectId,
        providerOrderId: input.providerOrderId ?? undefined,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorClassification: null,
        errorCode: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "reconciliation_required"),
        eq(paymentOperations.leaseToken, input.leaseToken),
        input.providerOrderId == null
          ? undefined
          : or(
            isNull(paymentOperations.providerOrderId),
            eq(paymentOperations.providerOrderId, input.providerOrderId),
          ),
      ))
      .returning();
    if (!transitioned) return undefined;
    const linkedRows = transitioned.operationType === "standing_autopay_charge" && (!input.paymentRows || input.paymentRows.length === 0)
      ? await deriveStandingPaymentRowsInTransaction(tx, { organizationId: input.organizationId, operationId: transitioned.id, providerPaymentId: input.providerObjectId, providerName: transitioned.providerName, actorUserId: transitioned.authorizingUserId })
      : input.paymentRows;
    await insertLinkedPaymentRows(tx, input.organizationId, input.operationId, linkedRows);
    if ((transitioned.operationType === "interactive_charge" || transitioned.operationType === "standing_autopay_charge") && transitioned.leagueId !== null) {
      try {
        await tx.transaction(async (finalizerTx) => {
          await finalizeRosterSnapshotInTransaction(finalizerTx, {
            organizationId: input.organizationId,
            leagueId: transitioned.leagueId as number,
            operationId: transitioned.id,
            now,
            actorUserId: transitioned.authorizingUserId,
          });
        });
      } catch (error) {
        if (!isRosterSnapshotFinalizationError(error)) throw error;
        const [reviewed] = await tx.update(paymentOperations).set({
          status: "reconciliation_required",
          nextAttemptAt: null,
          errorClassification: "internal",
          errorCode: error.code,
          updatedAt: now,
        }).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.id, transitioned.id),
          eq(paymentOperations.status, "succeeded"),
        )).returning();
        return reviewed ?? transitioned;
      }
    }
    return transitioned;
  });
  if (updated) return updated;

  const existing = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
  if (!existing) throw new PaymentOperationNotFoundError();
  if (
    existing.status === "succeeded"
    && existing.leaseToken === input.leaseToken
    && existing.providerObjectId === input.providerObjectId
    && (input.providerOrderId == null || existing.providerOrderId === input.providerOrderId)
  ) {
    return existing;
  }
  throw new PaymentOperationInvalidTransitionError(existing.status);
}

/**
 * A lease that consumed attempt eight and then expired cannot be acquired
 * again. Its provider outcome is uncertain, so automatic execution stops in
 * reconciliation_required without asserting that payment failed.
 */
export async function recordExpiredPaymentOperationAttemptExhausted(input: {
  organizationId: number;
  operationId: string;
  now?: Date;
  failedPaymentRows?: PaymentOperationLinkedPaymentInput[];
}): Promise<PaymentOperation | undefined> {
  validateFailedPaymentRows(input.failedPaymentRows);
  const now = toIso(input.now ?? new Date(), "now");
  return db.transaction(async (tx) => {
    await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
    const [updated] = await tx
      .update(paymentOperations)
      .set({
        status: "reconciliation_required",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorClassification: "provider_unknown",
        errorCode: "PROVIDER_OUTCOME_UNCERTAIN",
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "leased"),
        gte(paymentOperations.attemptCount, PAYMENT_OPERATION_MAX_ATTEMPTS),
        lte(paymentOperations.leaseExpiresAt, now),
      ))
      .returning();
    return updated;
  });
}

/** Phase 2B-2 legacy guard; deliberately not wired into the scheduler here. */
export async function cancelPaymentOperation(
  input: Omit<LeasedPaymentOperationInput, "leaseToken"> & { leaseToken?: string },
): Promise<PaymentOperation> {
  if (input.leaseToken !== undefined) validateLeaseToken(input.leaseToken);
  const now = toIso(input.now ?? new Date(), "now");
  const statePredicate = input.leaseToken === undefined
    ? inArray(paymentOperations.status, ["pending", "provider_unknown", "retry_scheduled"])
    : and(
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
    );

  const [updated] = await db
    .update(paymentOperations)
    .set({
      status: "canceled",
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorClassification: null,
      errorCode: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      statePredicate,
    ))
    .returning();
  if (!updated) return throwInvalidTransition(input.organizationId, input.operationId);
  return updated;
}
