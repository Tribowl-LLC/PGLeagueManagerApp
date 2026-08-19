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
  paymentSchedules,
  payments,
  paymentDisputes,
  scheduledPaymentOperationAllocations,
  scheduledPaymentOperationLineItems,
  scheduledPaymentOperationSnapshots,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationLineItems,
  interactivePaymentOperationSnapshots,
  paymentOccurrenceAllocations,
  occurrenceCollectionPlans,
  paymentOccurrenceAllocationRevisions,
  paymentOperationOccurrenceSnapshots,
  paymentOperationOccurrenceSnapshotAllocations,
  bowlerOccurrenceObligations,
  bowlerOccurrenceObligationRevisions,
  canonicalAutopayExecutionSnapshots,
  f3PayerAuthorizations,
  f3AutopayPlanProvenance,
  f3CollectionPolicies,
  financialActivations,
  bowlerPaymentLinks,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlanRevisions,
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
  encryptScheduledPaymentSnapshot,
  fingerprintScheduledPaymentSnapshot,
  reconstructScheduledPaymentSnapshot,
  type ScheduledPaymentSemanticSnapshot,
} from "../services/scheduled-payment-operation-snapshot.js";
import {
  encryptInteractivePaymentSnapshot,
  fingerprintInteractivePaymentSnapshot,
  fingerprintInteractivePaymentSnapshotAsLegacy,
  reconstructInteractivePaymentSnapshot,
  type InteractivePaymentSemanticSnapshot,
} from "../services/interactive-payment-operation-snapshot.js";
import { deriveSquareCardSaveIdempotencyKey } from "../services/payment-operation-idempotency.js";
import {
  PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
  fingerprintPaymentOperationOccurrenceSnapshot,
  validatePaymentOperationOccurrenceSnapshot,
} from "../services/payment-operation-occurrence-snapshot.js";
import {
  encryptRefundPaymentSnapshot,
  fingerprintRefundPaymentSnapshot,
  reconstructRefundPaymentSnapshot,
  refundReplaySemanticsMatch,
  type RefundPaymentSemanticSnapshot,
} from "../services/refund-payment-operation-snapshot.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import { providerNameToPaymentType } from "@shared/schema/constants";
import { canonicalAutopayProviderIdempotencyKey, canonicalAutopayTargetKey, validateF4ExecutionSnapshot } from "@shared/f4-canonical-autopay-contract";
import { canonicalF3AutopayEnabled, canonicalF4AutopayExecutionEnabled } from "../config.js";
import { requireLiveF1ActivationEvidence } from "../services/f3-workflow.js";

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

export interface CreateOrGetScheduledPaymentOperationInput {
  organizationId: number;
  paymentScheduleId: number;
  billingCycleAt: string | Date;
  amountMinor: number;
  currency: string;
  providerName: string;
  /** Server-resolved D1 trigger identity; never part of provider identity. */
  triggerOccurrenceId?: string | null;
}

export interface CreateOrGetCanonicalAutopayPaymentOperationInput {
  organizationId: number;
  leagueId: number;
  d2PlanId: string;
  triggerOccurrenceId: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  authorizingUserId: number;
  now?: Date;
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

/**
 * Canonical mutation lock order: advisory organization/league, D2 plan row,
 * then payment operation row. Revocation uses this same order. The initial
 * operation read is deliberately unlocked and only identifies the scope.
 */
async function lockCanonicalMutationScope(
  tx: PaymentOperationTransaction,
  organizationId: number,
  operationId: string,
): Promise<PaymentOperation | undefined> {
  const [candidate] = await tx.select({ operationType: paymentOperations.operationType, leagueId: paymentOperations.leagueId, canonicalPlanId: paymentOperations.canonicalPlanId })
    .from(paymentOperations)
    .where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.id, operationId)))
    .limit(1);
  if (!candidate || candidate.operationType !== "canonical_autopay_charge" || candidate.leagueId === null || candidate.canonicalPlanId === null) {
    if (!candidate) return undefined;
    const [legacyOperation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.id, operationId))).limit(1).for("update");
    return legacyOperation;
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${organizationId}::integer, ${candidate.leagueId}::integer)`);
  await tx.select({ id: occurrenceCollectionPlans.id }).from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, candidate.canonicalPlanId), eq(occurrenceCollectionPlans.organizationId, organizationId), eq(occurrenceCollectionPlans.leagueId, candidate.leagueId))).limit(1).for("update");
  const [operation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.id, operationId))).limit(1).for("update");
  return operation;
}

export interface PaymentOperationLinkedPaymentInput {
  allocationIndex: number;
  values: Omit<
    typeof payments.$inferInsert,
    "paymentOperationId" | "paymentOperationAllocationIndex"
  >;
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

async function validateSnapshotTenantReferences(
  executor: PaymentOperationTransaction,
  snapshot: ScheduledPaymentSemanticSnapshot,
): Promise<void> {
  const bowlerIds = [...new Set(snapshot.allocations.map((row) => row.bowlerId))];
  const paidByUserIds = [...new Set(snapshot.allocations
    .map((row) => row.paidByUserId)
    .filter((id): id is number => id !== null))];
  // PaymentOperationTransaction may be a single pinned pg client. Do not
  // overlap its queries: pg@8 warns and pg@9 will reject that usage.
  const ownedBowlers = await executor.select({ id: bowlers.id }).from(bowlers).where(and(
    eq(bowlers.organizationId, snapshot.organizationId),
    inArray(bowlers.id, bowlerIds),
  ));
  const ownedLeague = await executor.select({ id: leagues.id }).from(leagues).where(and(
    eq(leagues.organizationId, snapshot.organizationId),
    eq(leagues.id, snapshot.leagueId),
  ));
  const ownedPaidByUsers = paidByUserIds.length === 0
    ? []
    : await executor.select({ id: users.id }).from(users).where(and(
      eq(users.organizationId, snapshot.organizationId),
      inArray(users.id, paidByUserIds),
    ));
  const ownedLocations = snapshot.locationId === null
    ? []
    : await executor.select({ id: locations.id }).from(locations).where(and(
      eq(locations.organizationId, snapshot.organizationId),
      eq(locations.id, snapshot.locationId),
    ));
  if (
    ownedBowlers.length !== bowlerIds.length
    || ownedLeague.length !== 1
    || ownedPaidByUsers.length !== paidByUserIds.length
    || ownedLocations.length !== (snapshot.locationId === null ? 0 : 1)
  ) {
    throw new PaymentOperationValidationError(
      "scheduled payment snapshot references do not belong to the operation tenant",
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
  await executor.insert(payments).values(rows.map((row) => ({
    ...row.values,
    paymentOperationId: operationId,
    paymentOperationAllocationIndex: row.allocationIndex,
  })));
}

async function deactivatePaidInFullSchedule(
  executor: PaymentOperationTransaction,
  operationId: string,
  now: string,
): Promise<void> {
  const [context] = await executor
    .select({
      paymentScheduleId: paymentOperations.paymentScheduleId,
      leagueId: scheduledPaymentOperationSnapshots.leagueId,
      threshold: scheduledPaymentOperationSnapshots.paidInFullThresholdAmountMinor,
      seasonStartAt: scheduledPaymentOperationSnapshots.seasonStartAt,
      seasonEndAt: scheduledPaymentOperationSnapshots.seasonEndAt,
      payerBowlerId: scheduledPaymentOperationAllocations.bowlerId,
    })
    .from(paymentOperations)
    .innerJoin(
      scheduledPaymentOperationSnapshots,
      eq(scheduledPaymentOperationSnapshots.operationId, paymentOperations.id),
    )
    .innerJoin(
      scheduledPaymentOperationAllocations,
      and(
        eq(scheduledPaymentOperationAllocations.operationId, paymentOperations.id),
        eq(scheduledPaymentOperationAllocations.allocationIndex, 0),
      ),
    )
    .where(eq(paymentOperations.id, operationId))
    .limit(1);
  if (
    !context?.paymentScheduleId
    || context.threshold === null
    || context.seasonStartAt === null
    || context.seasonEndAt === null
  ) return;

  const [paid] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(and(
      eq(payments.bowlerId, context.payerBowlerId),
      eq(payments.leagueId, context.leagueId),
      eq(payments.status, "paid"),
      gte(payments.weekOf, context.seasonStartAt),
      lte(payments.weekOf, context.seasonEndAt),
    ));
  if (Number(paid?.total ?? 0) < context.threshold) return;

  await executor
    .update(paymentSchedules)
    .set({
      active: false,
      cancelledAt: now,
      cancelReason: `paid_in_full:payment_operation=${operationId}`,
    })
    .where(eq(paymentSchedules.id, context.paymentScheduleId));
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

function immutableScheduledOperationMatches(
  operation: PaymentOperation,
  expected: ReturnType<typeof buildPaymentOperationIdentity>,
): boolean {
  const request = expected.normalizedRequest;
  return operation.organizationId === request.organizationId
    && operation.operationType === request.operationType
    && operation.targetKey === request.targetKey
    && operation.paymentScheduleId === request.paymentScheduleId
    && storedTimestampToIso(operation.billingCycleAt) === request.billingCycleAt
    && operation.amountMinor === request.amountMinor
    && operation.currency === request.currency
    && operation.providerName === request.providerName
    && operation.requestFingerprint === expected.requestFingerprint
    && operation.providerIdempotencyKey === expected.providerIdempotencyKey;
}

function immutableInteractiveOperationMatches(
  operation: PaymentOperation,
  expected: ReturnType<typeof buildPaymentOperationIdentity>,
): boolean {
  const request = expected.normalizedRequest;
  return operation.organizationId === request.organizationId
    && operation.operationType === "interactive_charge"
    && operation.targetKey === request.targetKey
    && operation.paymentScheduleId === null
    && operation.billingCycleAt === null
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
    && operation.paymentScheduleId === null
    && operation.billingCycleAt === null
    && operation.amountMinor === request.amountMinor
    && operation.currency === request.currency
    && operation.providerName === request.providerName
    && operation.requestFingerprint === expected.requestFingerprint
    && operation.providerIdempotencyKey === expected.providerIdempotencyKey;
}

/**
 * Creates dormant durable intent for one interactive charge. This primitive
 * does not acquire a lease or call a provider; an explicit executor must do
 * both in a later behavior-cutover release.
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
 * Creates dormant general interactive intent under a reserved target-key
 * namespace. Auto-pay setup uses its own `autopay-setup:` namespace and is
 * therefore unable to collide with a future regular checkout request.
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
 * Concurrent callers converge on the partial recurring-cycle uniqueness
 * constraint. A conflict is returned only when every immutable field still
 * matches; amount/currency/tenant/target drift fails closed.
 */
export async function createOrGetScheduledPaymentOperation(
  input: CreateOrGetScheduledPaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const identity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "scheduled_charge",
    targetKey: `payment-schedule:${input.paymentScheduleId}`,
    paymentScheduleId: input.paymentScheduleId,
    billingCycleAt: input.billingCycleAt,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
  });
  const request = identity.normalizedRequest;
  const now = new Date().toISOString();

  const run = async (tx: PaymentOperationTransaction): Promise<PaymentOperation> => {
    // Lock both the schedule and joined league rows for the duration of this
    // short insert/get transaction. That closes the tenant-check TOCTOU window
    // without ever spanning a provider call.
    const [owned] = await tx
      .select({
        id: paymentSchedules.id,
        leagueId: paymentSchedules.leagueId,
        nextOccurrenceId: paymentSchedules.nextOccurrenceId,
      })
      .from(paymentSchedules)
      .innerJoin(leagues, eq(paymentSchedules.leagueId, leagues.id))
      .where(and(
        eq(paymentSchedules.id, input.paymentScheduleId),
        eq(leagues.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("share");
    if (!owned) throw new PaymentOperationNotFoundError();

    const [prior] = await tx
      .select()
      .from(paymentOperations)
      .where(and(
        eq(paymentOperations.operationType, "scheduled_charge"),
        eq(paymentOperations.paymentScheduleId, input.paymentScheduleId),
        sql`${paymentOperations.billingCycleAt} = ${request.billingCycleAt}`,
      ))
      .limit(1);
    if (prior) {
      if (!immutableScheduledOperationMatches(prior, identity)
        || (prior.triggerOccurrenceId !== null
          && prior.triggerOccurrenceId !== (input.triggerOccurrenceId ?? null))) {
        throw new PaymentOperationImmutableMismatchError();
      }
      // A pre-D1 retry intentionally retains its original null reference even
      // when the caller can now see canonical state.
      if (prior.triggerOccurrenceId === null) return prior;
    } else if ((input.triggerOccurrenceId ?? null) !== owned.nextOccurrenceId) {
      throw new PaymentOperationImmutableMismatchError();
    }
    if (input.triggerOccurrenceId != null) {
      const [trigger] = await tx.select({ id: leagueOccurrences.id })
        .from(leagueOccurrences)
        .where(and(
          eq(leagueOccurrences.id, input.triggerOccurrenceId),
          eq(leagueOccurrences.organizationId, input.organizationId),
          eq(leagueOccurrences.leagueId, owned.leagueId),
          eq(leagueOccurrences.startAt, request.billingCycleAt as string),
          inArray(leagueOccurrences.lifecycle, ["published", "locked"]),
          inArray(leagueOccurrences.status, ["scheduled", "completed"]),
        ))
        .limit(1)
        .for("share");
      if (!trigger) throw new PaymentOperationImmutableMismatchError();
    }
    if (prior) return prior;

    const [created] = await tx
      .insert(paymentOperations)
      .values({
        organizationId: request.organizationId,
        operationType: request.operationType,
        targetKey: request.targetKey,
        paymentScheduleId: request.paymentScheduleId,
        billingCycleAt: request.billingCycleAt,
        triggerOccurrenceId: input.triggerOccurrenceId ?? null,
        amountMinor: request.amountMinor,
        currency: request.currency,
        requestFingerprint: identity.requestFingerprint,
        providerIdempotencyKey: identity.providerIdempotencyKey,
        providerName: request.providerName,
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
        eq(paymentOperations.operationType, "scheduled_charge"),
        eq(paymentOperations.paymentScheduleId, input.paymentScheduleId),
        sql`${paymentOperations.billingCycleAt} = ${request.billingCycleAt}`,
      ))
      .limit(1);
    if (!existing || !immutableScheduledOperationMatches(existing, identity)
      || (existing.triggerOccurrenceId !== null
        && existing.triggerOccurrenceId !== (input.triggerOccurrenceId ?? null))) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return existing;
  };
  return existingTransaction ? run(existingTransaction) : db.transaction(run);
}

/** F4 preparation identity. Exactly one operation is linked to one immutable
 * D2 plan; this namespace cannot collide with any legacy schedule or F2 key. */
export async function createOrGetCanonicalAutopayPaymentOperation(
  input: CreateOrGetCanonicalAutopayPaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const targetKey = canonicalAutopayTargetKey(input.d2PlanId);
  const providerIdempotencyKey = canonicalAutopayProviderIdempotencyKey(input);
  const identity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "canonical_autopay_charge",
    targetKey,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
  });
  const now = toIso(input.now ?? new Date(), "now");
  const run = async (tx: PaymentOperationTransaction): Promise<PaymentOperation> => {
    const [plan] = await tx.select({ id: occurrenceCollectionPlans.id }).from(occurrenceCollectionPlans).where(and(
      eq(occurrenceCollectionPlans.id, input.d2PlanId),
      eq(occurrenceCollectionPlans.organizationId, input.organizationId),
      eq(occurrenceCollectionPlans.leagueId, input.leagueId),
      eq(occurrenceCollectionPlans.state, "ready"),
    )).limit(1).for("share");
    if (!plan) throw new PaymentOperationNotFoundError();
    const [existing] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.operationType, "canonical_autopay_charge"),
      eq(paymentOperations.targetKey, targetKey),
    )).limit(1);
    if (existing) {
      if (existing.leagueId !== input.leagueId || existing.canonicalPlanId !== input.d2PlanId
        || existing.triggerOccurrenceId !== input.triggerOccurrenceId
        || existing.amountMinor !== input.amountMinor || existing.currency !== input.currency.toUpperCase()
      || existing.providerName !== input.providerName || existing.requestFingerprint !== identity.requestFingerprint
        || existing.providerIdempotencyKey !== providerIdempotencyKey || existing.authorizingUserId !== input.authorizingUserId) throw new PaymentOperationImmutableMismatchError();
      return existing;
    }
    const [created] = await tx.insert(paymentOperations).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      canonicalPlanId: input.d2PlanId,
      operationType: "canonical_autopay_charge",
      targetKey,
      triggerOccurrenceId: input.triggerOccurrenceId,
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
      requestFingerprint: identity.requestFingerprint,
      providerIdempotencyKey,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      status: "pending",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (created) return created;
    const [winner] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.operationType, "canonical_autopay_charge"),
      eq(paymentOperations.targetKey, targetKey),
    )).limit(1);
    if (!winner || winner.leagueId !== input.leagueId || winner.canonicalPlanId !== input.d2PlanId
      || winner.requestFingerprint !== identity.requestFingerprint || winner.providerIdempotencyKey !== providerIdempotencyKey
      || winner.authorizingUserId !== input.authorizingUserId) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return winner;
  };
  return existingTransaction ? run(existingTransaction) : db.transaction(run);
}

async function loadScheduledPaymentOperationSnapshot(
  executor: typeof db | PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<ScheduledPaymentSemanticSnapshot | undefined> {
  if (operation.paymentScheduleId === null || operation.billingCycleAt === null) return undefined;
  const [stored] = await executor
    .select()
    .from(scheduledPaymentOperationSnapshots)
    .where(eq(scheduledPaymentOperationSnapshots.operationId, operation.id))
    .limit(1);
  if (!stored) return undefined;
  const allocationRows = await executor
    .select()
    .from(scheduledPaymentOperationAllocations)
    .where(eq(scheduledPaymentOperationAllocations.operationId, operation.id))
    .orderBy(asc(scheduledPaymentOperationAllocations.allocationIndex));
  const lineItemRows = await executor
    .select()
    .from(scheduledPaymentOperationLineItems)
    .where(eq(scheduledPaymentOperationLineItems.operationId, operation.id))
    .orderBy(asc(scheduledPaymentOperationLineItems.lineItemIndex));
  return reconstructScheduledPaymentSnapshot({
    organizationId: operation.organizationId,
    paymentScheduleId: operation.paymentScheduleId,
    billingCycleAt: storedTimestampToIso(operation.billingCycleAt) ?? operation.billingCycleAt,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    stored,
    allocations: allocationRows.map((row) => ({
      allocationIndex: row.allocationIndex,
      bowlerId: row.bowlerId,
      amountMinor: row.amountMinor,
      lineageAmountMinor: row.lineageAmountMinor,
      prizeFundAmountMinor: row.prizeFundAmountMinor,
      notes: row.notes,
      paidByUserId: row.paidByUserId,
    })),
    lineItems: lineItemRows.map((row) => ({
      lineItemIndex: row.lineItemIndex,
      catalogObjectId: row.catalogObjectId,
      quantity: row.quantity,
    })),
  });
}

/**
 * Persist or verify the encrypted structured snapshot inside the caller's
 * cycle-preparation transaction. Phase 2B-1 exposes this primitive but does
 * not call it from the production scheduler.
 */
export async function persistScheduledPaymentOperationSnapshot(
  operation: PaymentOperation,
  snapshot: ScheduledPaymentSemanticSnapshot,
  transaction: PaymentOperationTransaction,
): Promise<ScheduledPaymentSemanticSnapshot> {
  if (
    operation.operationType !== "scheduled_charge"
    || operation.paymentScheduleId === null
    || operation.billingCycleAt === null
    || snapshot.organizationId !== operation.organizationId
    || snapshot.paymentScheduleId !== operation.paymentScheduleId
    || new Date(snapshot.billingCycleAt).toISOString() !== storedTimestampToIso(operation.billingCycleAt)
    || snapshot.amountMinor !== operation.amountMinor
    || snapshot.currency !== operation.currency
    || snapshot.providerName !== operation.providerName
  ) {
    throw new PaymentOperationImmutableMismatchError();
  }

  await validateSnapshotTenantReferences(transaction, snapshot);
  const encrypted = encryptScheduledPaymentSnapshot(snapshot);
  const [created] = await transaction
    .insert(scheduledPaymentOperationSnapshots)
    .values({ operationId: operation.id, ...encrypted })
    .onConflictDoNothing()
    .returning({ operationId: scheduledPaymentOperationSnapshots.operationId });
  if (created) {
    await transaction.insert(scheduledPaymentOperationAllocations).values(
      snapshot.allocations.map((row) => ({ operationId: operation.id, ...row })),
    );
    if (snapshot.lineItems.length > 0) {
      await transaction.insert(scheduledPaymentOperationLineItems).values(
        snapshot.lineItems.map((row) => ({ operationId: operation.id, ...row })),
      );
    }
  }

  let stored: ScheduledPaymentSemanticSnapshot | undefined;
  try {
    stored = await loadScheduledPaymentOperationSnapshot(transaction, operation);
  } catch (error) {
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  if (!stored || encrypted.snapshotFingerprint !== fingerprintScheduledPaymentSnapshot(stored)) {
    throw new PaymentOperationImmutableMismatchError();
  }
  return stored;
}

async function validateInteractiveSnapshotTenantReferences(
  executor: PaymentOperationTransaction,
  snapshot: InteractivePaymentSemanticSnapshot,
): Promise<void> {
  const bowlerIds = [...new Set([
    snapshot.payerBowlerId,
    ...snapshot.allocations.map((row) => row.bowlerId),
  ])];
  const paidByUserIds = [...new Set(snapshot.allocations
    .map((row) => row.paidByUserId)
    .filter((id): id is number => id !== null))];

  const [ownedLeague] = await executor
    .select({ id: leagues.id })
    .from(leagues)
    .where(and(
      eq(leagues.id, snapshot.leagueId),
      eq(leagues.organizationId, snapshot.organizationId),
    ))
    .limit(1);
  const ownedBowlers = await executor
    .select({ id: bowlers.id })
    .from(bowlers)
    .where(and(
      eq(bowlers.organizationId, snapshot.organizationId),
      inArray(bowlers.id, bowlerIds),
    ));
  const rosteredBowlers = await executor
    .select({ bowlerId: bowlerLeagues.bowlerId })
    .from(bowlerLeagues)
    .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
    .where(and(
      eq(bowlerLeagues.leagueId, snapshot.leagueId),
      eq(bowlerLeagues.active, true),
      eq(bowlers.organizationId, snapshot.organizationId),
      inArray(bowlerLeagues.bowlerId, snapshot.allocations.map((row) => row.bowlerId)),
    ));
  const ownedPaidByUsers = paidByUserIds.length === 0
    ? []
    : await executor
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.organizationId, snapshot.organizationId),
        inArray(users.id, paidByUserIds),
      ));
  const ownedLocation = snapshot.locationId === null
    ? []
    : await executor
      .select({ id: locations.id })
      .from(locations)
      .where(and(
        eq(locations.organizationId, snapshot.organizationId),
        eq(locations.id, snapshot.locationId),
      ));

  if (
    !ownedLeague
    || ownedBowlers.length !== bowlerIds.length
    || rosteredBowlers.length !== snapshot.allocations.length
    || ownedPaidByUsers.length !== paidByUserIds.length
    || ownedLocation.length !== (snapshot.locationId === null ? 0 : 1)
  ) {
    throw new PaymentOperationValidationError(
      "interactive payment snapshot references do not belong to the operation tenant",
    );
  }
}

async function loadInteractivePaymentOperationSnapshot(
  executor: typeof db | PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<InteractivePaymentSemanticSnapshot | undefined> {
  if (
    operation.operationType !== "interactive_charge"
    || operation.paymentScheduleId !== null
    || operation.billingCycleAt !== null
  ) return undefined;

  const [stored] = await executor
    .select()
    .from(interactivePaymentOperationSnapshots)
    .where(eq(interactivePaymentOperationSnapshots.operationId, operation.id))
    .limit(1);
  if (!stored) return undefined;
  const allocationRows = await executor
    .select()
    .from(interactivePaymentOperationAllocations)
    .where(eq(interactivePaymentOperationAllocations.operationId, operation.id))
    .orderBy(asc(interactivePaymentOperationAllocations.allocationIndex));
  const lineItemRows = await executor
    .select()
    .from(interactivePaymentOperationLineItems)
    .where(eq(interactivePaymentOperationLineItems.operationId, operation.id))
    .orderBy(asc(interactivePaymentOperationLineItems.lineItemIndex));

  return reconstructInteractivePaymentSnapshot({
    organizationId: operation.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    stored,
    allocations: allocationRows.map((row) => ({
      allocationIndex: row.allocationIndex,
      bowlerId: row.bowlerId,
      amountMinor: row.amountMinor,
      lineageAmountMinor: row.lineageAmountMinor,
      prizeFundAmountMinor: row.prizeFundAmountMinor,
      weekOf: storedTimestampToIso(row.weekOf) ?? row.weekOf,
      notes: row.notes,
      paidByUserId: row.paidByUserId,
    })),
    lineItems: lineItemRows.map((row) => ({
      lineItemIndex: row.lineItemIndex,
      catalogObjectId: row.catalogObjectId,
      quantity: row.quantity,
    })),
  });
}

export async function persistInteractivePaymentOperationSnapshot(
  operation: PaymentOperation,
  snapshot: InteractivePaymentSemanticSnapshot,
  transaction: PaymentOperationTransaction,
): Promise<InteractivePaymentSemanticSnapshot> {
  if (
    operation.operationType !== "interactive_charge"
    || !operation.targetKey.startsWith(GENERAL_INTERACTIVE_TARGET_PREFIX)
    || operation.paymentScheduleId !== null
    || operation.billingCycleAt !== null
    || snapshot.organizationId !== operation.organizationId
    || snapshot.amountMinor !== operation.amountMinor
    || snapshot.currency !== operation.currency
    || snapshot.providerName !== operation.providerName
  ) {
    throw new PaymentOperationImmutableMismatchError();
  }

  // Re-read and lock the durable parent in the caller transaction. The
  // operation object is normally returned by the preparation call, but the
  // tenant and immutable-field check must not rely on an untrusted or stale
  // in-memory copy when this primitive is reused by a future route.
  const [storedOperation] = await transaction
    .select()
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.id, operation.id),
      eq(paymentOperations.organizationId, operation.organizationId),
    ))
    .limit(1)
    .for("share");
  if (
    !storedOperation
    || storedOperation.operationType !== operation.operationType
    || storedOperation.targetKey !== operation.targetKey
    || storedOperation.paymentScheduleId !== operation.paymentScheduleId
    || storedOperation.billingCycleAt !== operation.billingCycleAt
    || storedOperation.amountMinor !== operation.amountMinor
    || storedOperation.currency !== operation.currency
    || storedOperation.providerName !== operation.providerName
    || storedOperation.requestFingerprint !== operation.requestFingerprint
    || storedOperation.providerIdempotencyKey !== operation.providerIdempotencyKey
  ) {
    throw new PaymentOperationImmutableMismatchError();
  }

  await validateInteractiveSnapshotTenantReferences(transaction, snapshot);
  const encrypted = encryptInteractivePaymentSnapshot(snapshot);
  const [created] = await transaction
    .insert(interactivePaymentOperationSnapshots)
    .values({ operationId: operation.id, ...encrypted })
    .onConflictDoNothing()
    .returning({ operationId: interactivePaymentOperationSnapshots.operationId });
  if (created) {
    await transaction.insert(interactivePaymentOperationAllocations).values(
      snapshot.allocations.map((row) => ({ operationId: operation.id, ...row })),
    );
    if (snapshot.lineItems.length > 0) {
      await transaction.insert(interactivePaymentOperationLineItems).values(
        snapshot.lineItems.map((row) => ({ operationId: operation.id, ...row })),
      );
    }
  }

  if (snapshot.snapshotVersion === 2) {
    await initializeInteractiveCardSaveState(transaction, operation, snapshot);
  }

  let stored: InteractivePaymentSemanticSnapshot | undefined;
  try {
    stored = await loadInteractivePaymentOperationSnapshot(transaction, operation);
  } catch (error) {
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  const fingerprintsMatch = stored
    && (
      encrypted.snapshotFingerprint === fingerprintInteractivePaymentSnapshot(stored)
      || (
        stored.snapshotVersion === 1
        && encrypted.snapshotFingerprint === fingerprintInteractivePaymentSnapshotAsLegacy(snapshot)
      )
    );
  if (!stored || !fingerprintsMatch) {
    throw new PaymentOperationImmutableMismatchError();
  }
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
  snapshot: InteractivePaymentSemanticSnapshot,
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

export async function getInteractivePaymentOperationSnapshotForOrganization(
  organizationId: number,
  operationId: string,
): Promise<InteractivePaymentSemanticSnapshot | undefined> {
  const operation = await getPaymentOperationForOrganization(organizationId, operationId);
  if (!operation) return undefined;
  return loadInteractivePaymentOperationSnapshot(db, operation);
}

export async function getScheduledPaymentOperationSnapshotForOrganization(
  organizationId: number,
  operationId: string,
): Promise<ScheduledPaymentSemanticSnapshot | undefined> {
  const operation = await getPaymentOperationForOrganization(organizationId, operationId);
  if (!operation) return undefined;
  return loadScheduledPaymentOperationSnapshot(db, operation);
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
 * F4 dispatch cutoff shared with F3 revoke/supersede. Holding the same
 * organization/league advisory lock and plan/auth row locks makes revoke
 * first a durable zero-call outcome; once this returns true, the leased
 * operation owns the exact in-flight dispatch window.
 */
export async function acquireCanonicalAutopayDispatchCutoff(input: {
  organizationId: number;
  leagueId: number;
  operationId: string;
  leaseToken: string;
  now?: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [scope] = await tx.select({ canonicalPlanId: paymentOperations.canonicalPlanId }).from(paymentOperations).where(and(eq(paymentOperations.id, input.operationId), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "canonical_autopay_charge"))).limit(1);
    if (!scope?.canonicalPlanId) return false;
    const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, scope.canonicalPlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId))).limit(1).for("update");
    const [operation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.id, input.operationId), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "canonical_autopay_charge"))).limit(1).for("update");
    if (!operation || operation.status !== "leased" || operation.leaseToken !== input.leaseToken || operation.canonicalPlanId === null) return false;
    const [snapshot] = await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId), eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId))).limit(1).for("share");
    if (!plan || !snapshot || plan.state !== "ready" || plan.version !== snapshot.planVersion || plan.currency !== snapshot.currency || plan.triggerOccurrenceId !== snapshot.triggerOccurrenceId || operation.amountMinor !== snapshot.amountMinor || operation.currency !== snapshot.currency) return false;
    const [provenance] = await tx.select().from(f3AutopayPlanProvenance).where(and(eq(f3AutopayPlanProvenance.d2PlanId, plan.id), eq(f3AutopayPlanProvenance.organizationId, input.organizationId), eq(f3AutopayPlanProvenance.leagueId, input.leagueId))).limit(1).for("share");
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, snapshot.policyId), eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId))).limit(1).for("share");
    const [authorization] = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.id, snapshot.authorizationId), eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId))).limit(1).for("share");
    const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.id, snapshot.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId))).limit(1).for("share");
    const [occurrence] = await tx.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.id, snapshot.triggerOccurrenceId), eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId))).limit(1).for("share");
    if (!provenance || !policy || !authorization || !activation || !occurrence
      || authorization.state !== "authorized" || authorization.authorizationVersion !== snapshot.authorizationVersion
      || authorization.authorizationFingerprint !== snapshot.authorizationFingerprint || authorization.encryptedSourceId !== snapshot.encryptedSourceId
      || authorization.encryptedCustomerId !== snapshot.encryptedCustomerId || authorization.locationId !== snapshot.locationId
      || authorization.payerBowlerId !== snapshot.payerBowlerId || authorization.policyId !== snapshot.policyId
      || authorization.policyVersion !== snapshot.policyVersion || authorization.createdByUserId !== operation.authorizingUserId
      || provenance.policyId !== snapshot.policyId || provenance.policyVersion !== snapshot.policyVersion
      || provenance.authorizationId !== snapshot.authorizationId || provenance.authorizationVersion !== snapshot.authorizationVersion
      || provenance.activationId !== snapshot.activationId || provenance.activationRevision !== snapshot.activationRevision
      || provenance.activationSourceFingerprint !== snapshot.activationSourceFingerprint || provenance.planVersion !== snapshot.planVersion
      || provenance.planFingerprint !== snapshot.planFingerprint || provenance.collectionPointOccurrenceId !== snapshot.collectionPointOccurrenceId
      || policy.state !== "approved" || policy.policyVersion !== snapshot.policyVersion || policy.policyFingerprint !== snapshot.policyFingerprint
      || !policy.collectionPoints.some((point) => point.occurrenceId === snapshot.collectionPointOccurrenceId)
      || activation.currentRevision !== snapshot.activationRevision || activation.sourceFingerprint !== snapshot.activationSourceFingerprint
      || activation.state !== "active" || activation.completenessMarker !== true
      || !["published", "locked"].includes(occurrence.lifecycle) || !["scheduled", "completed"].includes(occurrence.status)
      || new Date(occurrence.startAt).toISOString() !== new Date(snapshot.triggerStartAt).toISOString()) return false;
    try { await requireLiveF1ActivationEvidence(tx, { organizationId: input.organizationId, leagueId: input.leagueId }, activation); } catch { return false; }
    const itemRows = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId))).orderBy(asc(occurrenceCollectionPlanItems.itemIndex)).for("share");
    const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items as Array<{ obligationId: string; occurrenceId: string; bowlerId: number; amountMinor: number; currency: string; itemIndex: number }> : [];
    if (itemRows.length !== snapshotItems.length || itemRows.some((row, index) => {
      const expected = snapshotItems[index];
      return !expected || row.itemIndex !== expected.itemIndex || row.obligationId !== expected.obligationId || row.occurrenceId !== expected.occurrenceId || row.bowlerId !== expected.bowlerId || row.amountMinor !== expected.amountMinor || row.currency !== expected.currency;
    })) return false;
    const authorizedItems = authorization.authorizedItems
      .filter((item) => item.collectionPointOccurrenceId === snapshot.collectionPointOccurrenceId)
      .sort((left, right) => left.itemIndex - right.itemIndex);
    if (authorizedItems.length !== snapshotItems.length || authorizedItems.some((item, index) => {
      const expected = snapshotItems[index];
      return !expected || item.collectionPointOccurrenceId !== snapshot.collectionPointOccurrenceId
        || item.itemIndex !== expected.itemIndex || item.obligationId !== expected.obligationId
        || item.occurrenceId !== expected.occurrenceId || item.bowlerId !== expected.bowlerId
        || item.amountMinor !== expected.amountMinor;
    })) return false;
    const obligationIds = snapshotItems.map((item) => item.obligationId);
    const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligations.id, obligationIds),
    )).for("update");
    if (obligations.length !== obligationIds.length) return false;
    const activeAllocations = await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status, refundedAt: payments.refundedAt, disputedAt: payments.disputedAt, paymentOperationId: payments.paymentOperationId }).from(paymentOccurrenceAllocations)
      .innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId))
      .where(and(
        eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
        eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
        inArray(paymentOccurrenceAllocations.obligationId, obligationIds),
        eq(paymentOccurrenceAllocations.state, "active"),
      )).for("share");
    const allocationOperationIds = [...new Set(activeAllocations.map((row) => row.paymentOperationId).filter((id): id is string => id !== null))];
    const disputedOperationIds = allocationOperationIds.length
      ? new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, allocationOperationIds)))).map((row) => row.operationId))
      : new Set<string>();
    if (activeAllocations.some((row) => row.status !== "paid" || row.refundedAt !== null || row.disputedAt !== null || (row.paymentOperationId !== null && disputedOperationIds.has(row.paymentOperationId)))) return false;
    const paidByObligation = new Map<string, number>();
    for (const row of activeAllocations) if (row.status === "paid") paidByObligation.set(row.obligationId, (paidByObligation.get(row.obligationId) ?? 0) + row.amountMinor);
    const otherReservations = await tx.select({ obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId, amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor }).from(paymentOperationOccurrenceSnapshotAllocations)
      .innerJoin(paymentOperations, and(eq(paymentOperations.id, paymentOperationOccurrenceSnapshotAllocations.operationId), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId)))
      .where(and(inArray(paymentOperationOccurrenceSnapshotAllocations.obligationId, obligationIds), ne(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id), inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"]))).for("share");
    const otherPlanReservations = await tx.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems)
      .innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId), eq(occurrenceCollectionPlans.state, "ready")))
      .where(and(inArray(occurrenceCollectionPlanItems.obligationId, obligationIds), ne(occurrenceCollectionPlanItems.planId, plan.id))).for("share");
    const reservedByObligation = new Map<string, number>();
    for (const row of [...otherReservations, ...otherPlanReservations]) reservedByObligation.set(row.obligationId, (reservedByObligation.get(row.obligationId) ?? 0) + row.amountMinor);
    const obligationById = new Map(obligations.map((row) => [row.id, row]));
    for (const item of snapshotItems) {
      const obligation = obligationById.get(item.obligationId);
      const paid = paidByObligation.get(item.obligationId) ?? 0;
      const reserved = reservedByObligation.get(item.obligationId) ?? 0;
      if (!obligation || obligation.occurrenceId !== item.occurrenceId || obligation.bowlerId !== item.bowlerId || obligation.currency !== item.currency
        || ["voided", "settled", "refunded", "disputed", "review_required"].includes(obligation.state)
        || paid + reserved + item.amountMinor !== obligation.amountMinor
        || (paid === 0 && obligation.state !== "open")
        || (paid > 0 && paid < obligation.amountMinor && obligation.state !== "partially_settled")) return false;
    }
    const expectedBowlers = [...new Set(snapshotItems.map((item) => item.bowlerId))].sort((a, b) => a - b);
    const covered = [...new Set(authorization.coveredBowlerIds)].sort((a, b) => a - b);
    if (covered.length !== expectedBowlers.length || covered.some((id, index) => id !== expectedBowlers[index]) || !authorization.collectionPointOccurrenceIds.includes(snapshot.collectionPointOccurrenceId)) return false;
    const memberships = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, expectedBowlers))).for("share");
    if (new Set(memberships.map((row) => row.bowlerId)).size !== expectedBowlers.length) return false;
    const links = await tx.select({ a: bowlerPaymentLinks.bowlerAId, b: bowlerPaymentLinks.bowlerBId }).from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(eq(bowlerPaymentLinks.bowlerAId, authorization.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, authorization.payerBowlerId)))).for("share");
    const linkedPartners = new Set(links.map((row) => row.a === authorization.payerBowlerId ? row.b : row.a));
    if (expectedBowlers.some((id) => id !== authorization.payerBowlerId && (!authorization.acceptedPartnerIds.includes(id) || !linkedPartners.has(id)))) return false;
    const [payer] = await tx.select({ paymentCustomerId: bowlers.paymentCustomerId, paymentProviderLocationId: bowlers.paymentProviderLocationId }).from(bowlers).where(and(eq(bowlers.id, authorization.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1).for("share");
    let customerId: string;
    try { customerId = (snapshot.encryptedCustomerId ? decrypt(snapshot.encryptedCustomerId) : null) ?? ""; } catch { return false; }
    if (!payer || !customerId || payer.paymentCustomerId !== customerId || payer.paymentProviderLocationId !== snapshot.locationId) return false;
    const [location] = await tx.select({ squareCredentials: locations.squareCredentials }).from(locations).where(and(eq(locations.id, snapshot.locationId), eq(locations.organizationId, input.organizationId))).limit(1).for("share");
    const locationCredentials = locationSquareCredentialsSchema.safeParse(location?.squareCredentials);
    if (!locationCredentials.success || locationCredentials.data?.locationId !== snapshot.providerLocationId) return false;
    const claimedAt = (input.now ?? new Date()).toISOString();
    const [claimed] = await tx.update(paymentOperations).set({ dispatchClaimedAt: claimedAt, updatedAt: claimedAt }).where(and(eq(paymentOperations.id, operation.id), eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.status, "leased"), eq(paymentOperations.leaseToken, input.leaseToken), isNull(paymentOperations.dispatchClaimedAt))).returning({ id: paymentOperations.id });
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
        dispatchClaimedAt: sql`CASE
          WHEN ${paymentOperations.operationType} = 'canonical_autopay_charge'
          THEN NULL
          ELSE ${paymentOperations.dispatchClaimedAt}
        END`,
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
      if (transitioned.operationType === "canonical_autopay_charge") {
        await cancelCanonicalPlanAfterDefinitiveFailure(tx, transitioned, now, "ATTEMPTS_EXHAUSTED");
      }
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
      dispatchClaimedAt: sql`CASE
        WHEN ${paymentOperations.operationType} = 'canonical_autopay_charge'
        THEN NULL
        ELSE ${paymentOperations.dispatchClaimedAt}
      END`,
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
    if (transitioned.operationType === "canonical_autopay_charge" && input.status === "failed_terminal") {
      await cancelCanonicalPlanAfterDefinitiveFailure(tx, transitioned, now, errorCode ?? "F4_PROVIDER_REQUEST_REJECTED");
    }
    if (transitioned.operationType === "canonical_autopay_charge" && input.status === "action_required" && transitioned.leagueId !== null) {
      const [canonicalSnapshot] = await tx.select({ authorizationId: canonicalAutopayExecutionSnapshots.authorizationId }).from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, transitioned.id), eq(canonicalAutopayExecutionSnapshots.organizationId, transitioned.organizationId), eq(canonicalAutopayExecutionSnapshots.leagueId, transitioned.leagueId))).limit(1).for("share");
      if (canonicalSnapshot) {
        const planRows = await tx.select({ plan: occurrenceCollectionPlans }).from(occurrenceCollectionPlans).innerJoin(f3AutopayPlanProvenance, and(eq(f3AutopayPlanProvenance.d2PlanId, occurrenceCollectionPlans.id), eq(f3AutopayPlanProvenance.organizationId, occurrenceCollectionPlans.organizationId), eq(f3AutopayPlanProvenance.leagueId, occurrenceCollectionPlans.leagueId))).where(and(eq(occurrenceCollectionPlans.organizationId, transitioned.organizationId), eq(occurrenceCollectionPlans.leagueId, transitioned.leagueId), eq(f3AutopayPlanProvenance.authorizationId, canonicalSnapshot.authorizationId), eq(occurrenceCollectionPlans.state, "ready"))).for("update");
        for (const row of planRows) {
          const plan = row.plan;
          const [superseded] = await tx.update(occurrenceCollectionPlans).set({ state: "superseded", currentRevision: plan.currentRevision + 1, updatedAt: now }).where(and(eq(occurrenceCollectionPlans.id, plan.id), eq(occurrenceCollectionPlans.organizationId, transitioned.organizationId), eq(occurrenceCollectionPlans.leagueId, transitioned.leagueId), eq(occurrenceCollectionPlans.state, "ready"), eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision))).returning();
          if (!superseded) throw new PaymentOperationImmutableMismatchError();
          const planItems = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, transitioned.organizationId), eq(occurrenceCollectionPlanItems.leagueId, transitioned.leagueId)));
          await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: transitioned.organizationId, leagueId: transitioned.leagueId, planId: plan.id, revisionNumber: superseded.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: { state: plan.state, plan, items: planItems }, afterSnapshot: { state: superseded.state, plan: superseded, items: planItems, actionRequiredOperationId: transitioned.id }, recordedByUserId: plan.recordedByUserId, createdAt: now });
          await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now }).where(and(eq(paymentOperations.organizationId, transitioned.organizationId), eq(paymentOperations.leagueId, transitioned.leagueId), eq(paymentOperations.operationType, "canonical_autopay_charge"), eq(paymentOperations.canonicalPlanId, plan.id), or(inArray(paymentOperations.status, ["pending", "retry_scheduled"]), and(eq(paymentOperations.status, "leased"), isNull(paymentOperations.dispatchClaimedAt)))));
        }
      }
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

async function cancelCanonicalPlanAfterDefinitiveFailure(
  tx: PaymentOperationTransaction,
  operation: PaymentOperation,
  now: string,
  reason: string,
): Promise<void> {
  if (operation.operationType !== "canonical_autopay_charge" || operation.leagueId === null || operation.canonicalPlanId === null) return;
  const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(
    eq(occurrenceCollectionPlans.id, operation.canonicalPlanId),
    eq(occurrenceCollectionPlans.organizationId, operation.organizationId),
    eq(occurrenceCollectionPlans.leagueId, operation.leagueId),
  )).limit(1).for("update");
  if (!plan || plan.state !== "ready") return;
  const revisionNumber = plan.currentRevision + 1;
  const [cancelled] = await tx.update(occurrenceCollectionPlans).set({ state: "cancelled", currentRevision: revisionNumber, updatedAt: now }).where(and(
    eq(occurrenceCollectionPlans.id, plan.id),
    eq(occurrenceCollectionPlans.organizationId, operation.organizationId),
    eq(occurrenceCollectionPlans.leagueId, operation.leagueId),
    eq(occurrenceCollectionPlans.state, "ready"),
    eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision),
  )).returning();
  if (!cancelled) throw new PaymentOperationImmutableMismatchError();
  const items = await tx.select().from(occurrenceCollectionPlanItems).where(and(
    eq(occurrenceCollectionPlanItems.planId, plan.id),
    eq(occurrenceCollectionPlanItems.organizationId, operation.organizationId),
    eq(occurrenceCollectionPlanItems.leagueId, operation.leagueId),
  ));
  await tx.insert(occurrenceCollectionPlanRevisions).values({
    organizationId: operation.organizationId,
    leagueId: operation.leagueId,
    planId: plan.id,
    revisionNumber,
    snapshotSchemaVersion: 1,
    beforeSnapshot: { state: plan.state, plan, items },
    afterSnapshot: { state: "cancelled", reason, operationId: operation.id, plan: cancelled, items },
    recordedByUserId: plan.recordedByUserId,
    createdAt: now,
  });
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

/**
 * Terminalize deterministic F4 evidence drift and release the exact D2
 * reservation in one serialized transaction. Provider-uncertain outcomes do
 * not use this path: they remain reconciliation_required with their identity.
 */
export async function recordCanonicalAutopayPreDispatchFailure(
  input: LeasedPaymentOperationInput & { errorCode?: string | null },
): Promise<PaymentOperation | undefined> {
  validateLeaseToken(input.leaseToken);
  const now = toIso(input.now ?? new Date(), "now");
  const errorCode = validateErrorDetails("invalid_request", input.errorCode);
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ leagueId: paymentOperations.leagueId, canonicalPlanId: paymentOperations.canonicalPlanId, operationType: paymentOperations.operationType }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId))).limit(1);
    if (candidate?.operationType !== "canonical_autopay_charge" || candidate.leagueId === null || candidate.canonicalPlanId === null) return undefined;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${candidate.leagueId}::integer)`);
    const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, candidate.canonicalPlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, candidate.leagueId))).limit(1).for("update");
    const [operation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId), eq(paymentOperations.operationType, "canonical_autopay_charge"))).limit(1).for("update");
    if (!operation || operation.status !== "leased" || operation.leaseToken !== input.leaseToken) return undefined;
    const [failed] = await tx.update(paymentOperations).set({ status: "failed_terminal", nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, errorClassification: "invalid_request", errorCode, completedAt: now, updatedAt: now }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId), eq(paymentOperations.status, "leased"), eq(paymentOperations.leaseToken, input.leaseToken))).returning();
    if (!failed) return undefined;
    if (plan?.state === "ready") {
      const [cancelled] = await tx.update(occurrenceCollectionPlans).set({ state: "cancelled", currentRevision: plan.currentRevision + 1, updatedAt: now }).where(and(eq(occurrenceCollectionPlans.id, plan.id), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, candidate.leagueId), eq(occurrenceCollectionPlans.state, "ready"), eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision))).returning();
      if (!cancelled) throw new PaymentOperationImmutableMismatchError();
      const items = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, candidate.leagueId)));
      await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: input.organizationId, leagueId: candidate.leagueId, planId: plan.id, revisionNumber: cancelled.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: { state: plan.state, plan, items }, afterSnapshot: { state: cancelled.state, plan: cancelled, items, reason: errorCode }, recordedByUserId: plan.recordedByUserId, createdAt: now });
    }
    return failed;
  });
}

export type FinalizePaymentOperationSuccessInput = LeasedPaymentOperationInput & {
  providerObjectId: string;
  providerOrderId?: string | null;
  paymentRows?: PaymentOperationLinkedPaymentInput[];
};

// F2 supplement evidence must be checked before the operation transition or
// linked payment inserts. Webhook reconciliation catches immutable mismatch
// as a bounded inbox failure; preflighting here keeps that failure from
// committing a succeeded operation/payment without its occurrence evidence.
async function validateInteractiveOccurrenceSupplementBeforeWrites(
  tx: PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<void> {
  const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
    .where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id))
    .limit(1).for("share");
  if (!supplement) return;
  if (operation.authorizingUserId === null || supplement.amountMinor !== operation.amountMinor || supplement.currency !== operation.currency) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const snapshotAllocations = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations)
    .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id))
    .orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
  if (snapshotAllocations.length !== supplement.allocationCount
    || snapshotAllocations.reduce((sum, row) => sum + row.amountMinor, 0) !== operation.amountMinor) {
    throw new PaymentOperationImmutableMismatchError();
  }
  try {
    const semantic = validatePaymentOperationOccurrenceSnapshot({
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: supplement.snapshotVersion,
      operationId: operation.id,
      operationType: operation.operationType,
      organizationId: operation.organizationId,
      leagueId: supplement.leagueId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      allocations: snapshotAllocations.map((row) => ({
        allocationIndex: row.allocationIndex,
        organizationId: row.organizationId,
        leagueId: row.leagueId,
        occurrenceId: row.occurrenceId,
        bowlerId: row.bowlerId,
        obligationId: row.obligationId,
        amountMinor: row.amountMinor,
        currency: row.currency,
      })),
    });
    if (fingerprintPaymentOperationOccurrenceSnapshot(semantic) !== supplement.snapshotFingerprint) {
      throw new PaymentOperationImmutableMismatchError();
    }
  } catch (error) {
    if (error instanceof PaymentOperationImmutableMismatchError) throw error;
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
}

/**
 * F4 has a stronger completion contract than the legacy occurrence
 * supplement: a canonical operation is not complete until its exact plan,
 * allocations, obligation states, and revision evidence are committed in
 * the same transaction as the succeeded operation and linked payments.
 */
async function verifyCanonicalAutopayCompletionInTransaction(
  tx: PaymentOperationTransaction,
  operation: PaymentOperation,
): Promise<void> {
  if (operation.operationType !== "canonical_autopay_charge" || operation.leagueId === null || operation.canonicalPlanId === null) throw new PaymentOperationImmutableMismatchError();
  const [snapshot] = await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, operation.id), eq(canonicalAutopayExecutionSnapshots.organizationId, operation.organizationId), eq(canonicalAutopayExecutionSnapshots.leagueId, operation.leagueId))).limit(1).for("share");
  const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, operation.canonicalPlanId), eq(occurrenceCollectionPlans.organizationId, operation.organizationId), eq(occurrenceCollectionPlans.leagueId, operation.leagueId))).limit(1).for("share");
  if (!snapshot || !plan || plan.state !== "fulfilled") throw new PaymentOperationImmutableMismatchError();
  const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id), eq(paymentOperationOccurrenceSnapshots.organizationId, operation.organizationId), eq(paymentOperationOccurrenceSnapshots.leagueId, operation.leagueId))).limit(1).for("share");
  if (!supplement || supplement.amountMinor !== operation.amountMinor || supplement.currency !== operation.currency) throw new PaymentOperationImmutableMismatchError();
  const allocations = await tx.select().from(paymentOccurrenceAllocations).where(and(eq(paymentOccurrenceAllocations.organizationId, operation.organizationId), eq(paymentOccurrenceAllocations.leagueId, operation.leagueId), sql`${paymentOccurrenceAllocations.allocationKey} LIKE ${`payment-operation:${operation.id}:%`}`));
  const supplementAllocations = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id), eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, operation.organizationId), eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, operation.leagueId))).orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
  if (allocations.length !== supplementAllocations.length || allocations.some((allocation) => allocation.state !== "active" || !supplementAllocations.some((item) => allocation.allocationKey === `payment-operation:${operation.id}:${item.allocationIndex}` && allocation.obligationId === item.obligationId && allocation.amountMinor === item.amountMinor && allocation.currency === item.currency))) throw new PaymentOperationImmutableMismatchError();
  const allocationRevisionRows = allocations.length === 0 ? [] : await tx.select({ allocationId: paymentOccurrenceAllocationRevisions.allocationId, revisionNumber: paymentOccurrenceAllocationRevisions.revisionNumber }).from(paymentOccurrenceAllocationRevisions).where(and(eq(paymentOccurrenceAllocationRevisions.organizationId, operation.organizationId), eq(paymentOccurrenceAllocationRevisions.leagueId, operation.leagueId), inArray(paymentOccurrenceAllocationRevisions.allocationId, allocations.map((allocation) => allocation.id))));
  const allocationRevisionKeys = new Set(allocationRevisionRows.map((row) => `${row.allocationId}:${row.revisionNumber}`));
  if (allocations.some((allocation) => !allocationRevisionKeys.has(`${allocation.id}:${allocation.currentRevision}`))) throw new PaymentOperationImmutableMismatchError();
  const obligationIds = supplementAllocations.map((item) => item.obligationId);
  const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, operation.organizationId), eq(bowlerOccurrenceObligations.leagueId, operation.leagueId), inArray(bowlerOccurrenceObligations.id, obligationIds))).for("share");
  if (obligations.length !== obligationIds.length || obligations.some((obligation) => obligation.state !== "settled")) throw new PaymentOperationImmutableMismatchError();
  const obligationRevisionRows = await tx.select({ obligationId: bowlerOccurrenceObligationRevisions.obligationId, revisionNumber: bowlerOccurrenceObligationRevisions.revisionNumber }).from(bowlerOccurrenceObligationRevisions).where(and(eq(bowlerOccurrenceObligationRevisions.organizationId, operation.organizationId), eq(bowlerOccurrenceObligationRevisions.leagueId, operation.leagueId), inArray(bowlerOccurrenceObligationRevisions.obligationId, obligationIds)));
  const obligationRevisionKeys = new Set(obligationRevisionRows.map((row) => `${row.obligationId}:${row.revisionNumber}`));
  if (obligations.some((obligation) => !obligationRevisionKeys.has(`${obligation.id}:${obligation.currentRevision}`))) throw new PaymentOperationImmutableMismatchError();
  const [revision] = await tx.select({ id: occurrenceCollectionPlanRevisions.id }).from(occurrenceCollectionPlanRevisions).where(and(eq(occurrenceCollectionPlanRevisions.organizationId, operation.organizationId), eq(occurrenceCollectionPlanRevisions.leagueId, operation.leagueId), eq(occurrenceCollectionPlanRevisions.planId, plan.id), eq(occurrenceCollectionPlanRevisions.revisionNumber, plan.currentRevision))).limit(1);
  if (!revision) throw new PaymentOperationImmutableMismatchError();
}

async function finalizeCanonicalAutopayInTransaction(
  tx: PaymentOperationTransaction,
  operation: PaymentOperation,
  paymentRows: PaymentOperationLinkedPaymentInput[] | undefined,
  now: string,
): Promise<void> {
  if (operation.operationType !== "canonical_autopay_charge") return;
  if (operation.leagueId === null || operation.canonicalPlanId === null) {
    throw new PaymentOperationImmutableMismatchError();
  }
  if (operation.authorizingUserId === null) throw new PaymentOperationImmutableMismatchError();
  const [storedSnapshot] = await tx.select().from(canonicalAutopayExecutionSnapshots)
    .where(and(
      eq(canonicalAutopayExecutionSnapshots.operationId, operation.id),
      eq(canonicalAutopayExecutionSnapshots.organizationId, operation.organizationId),
      eq(canonicalAutopayExecutionSnapshots.leagueId, operation.leagueId),
    )).limit(1).for("update");
  if (!storedSnapshot) throw new PaymentOperationImmutableMismatchError();
  let snapshot: ReturnType<typeof validateF4ExecutionSnapshot>;
  try {
    snapshot = validateF4ExecutionSnapshot({
      contractVersion: "canonical-autopay-execution/1",
      snapshotVersion: storedSnapshot.snapshotVersion,
      operationId: storedSnapshot.operationId,
      organizationId: storedSnapshot.organizationId,
      leagueId: storedSnapshot.leagueId,
      d2PlanId: storedSnapshot.d2PlanId,
      collectionPointOccurrenceId: storedSnapshot.collectionPointOccurrenceId,
      triggerOccurrenceId: storedSnapshot.triggerOccurrenceId,
      triggerStartAt: new Date(storedSnapshot.triggerStartAt).toISOString(),
      payerBowlerId: storedSnapshot.payerBowlerId,
      locationId: storedSnapshot.locationId,
      providerLocationId: storedSnapshot.providerLocationId,
      activationId: storedSnapshot.activationId,
      activationRevision: storedSnapshot.activationRevision,
      activationSourceFingerprint: storedSnapshot.activationSourceFingerprint,
      policyId: storedSnapshot.policyId,
      policyVersion: storedSnapshot.policyVersion,
      policyFingerprint: storedSnapshot.policyFingerprint,
      authorizationId: storedSnapshot.authorizationId,
      authorizationVersion: storedSnapshot.authorizationVersion,
      authorizationFingerprint: storedSnapshot.authorizationFingerprint,
      planVersion: storedSnapshot.planVersion,
      planFingerprint: storedSnapshot.planFingerprint,
      amountMinor: storedSnapshot.amountMinor,
      currency: storedSnapshot.currency,
      items: storedSnapshot.items,
      encryptedSourceId: storedSnapshot.encryptedSourceId,
      encryptedCustomerId: storedSnapshot.encryptedCustomerId,
      snapshotFingerprint: storedSnapshot.snapshotFingerprint,
    });
  } catch (error) {
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  if (
    snapshot.operationId !== operation.id
    || snapshot.amountMinor !== operation.amountMinor
    || snapshot.currency !== operation.currency
    || snapshot.d2PlanId !== operation.canonicalPlanId
      || snapshot.triggerOccurrenceId !== operation.triggerOccurrenceId
  ) throw new PaymentOperationImmutableMismatchError();

  const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
    .where(and(
      eq(paymentOperationOccurrenceSnapshots.operationId, operation.id),
      eq(paymentOperationOccurrenceSnapshots.organizationId, operation.organizationId),
      eq(paymentOperationOccurrenceSnapshots.leagueId, operation.leagueId),
    )).limit(1).for("update");
  if (!supplement || supplement.amountMinor !== operation.amountMinor || supplement.currency !== operation.currency) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const supplementAllocations = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations)
    .where(and(
      eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id),
      eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, operation.organizationId),
      eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, operation.leagueId),
    )).orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
  if (supplementAllocations.length !== supplement.allocationCount) throw new PaymentOperationImmutableMismatchError();
  try {
    const semantic = validatePaymentOperationOccurrenceSnapshot({
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: supplement.snapshotVersion,
      operationId: operation.id,
      operationType: "canonical_autopay_charge",
      organizationId: operation.organizationId,
      leagueId: operation.leagueId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      allocations: supplementAllocations.map((row) => ({
        allocationIndex: row.allocationIndex,
        organizationId: row.organizationId,
        leagueId: row.leagueId,
        occurrenceId: row.occurrenceId,
        bowlerId: row.bowlerId,
        obligationId: row.obligationId,
        amountMinor: row.amountMinor,
        currency: row.currency,
      })),
    });
    if (fingerprintPaymentOperationOccurrenceSnapshot(semantic) !== supplement.snapshotFingerprint) throw new Error("occurrence fingerprint mismatch");
  } catch (error) {
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  if (supplementAllocations.length !== snapshot.items.length || supplementAllocations.some((row, index) => {
    const item = snapshot.items[index];
    return !item || row.allocationIndex !== item.itemIndex || row.obligationId !== item.obligationId
      || row.occurrenceId !== item.occurrenceId || row.bowlerId !== item.bowlerId
      || row.amountMinor !== item.amountMinor || row.currency !== item.currency;
  })) throw new PaymentOperationImmutableMismatchError();
  const [triggerOccurrence] = await tx.select({ startAt: leagueOccurrences.startAt, lifecycle: leagueOccurrences.lifecycle, status: leagueOccurrences.status }).from(leagueOccurrences).where(and(
    eq(leagueOccurrences.id, snapshot.triggerOccurrenceId),
    eq(leagueOccurrences.organizationId, operation.organizationId),
    eq(leagueOccurrences.leagueId, operation.leagueId),
  )).limit(1).for("share");
  if (!triggerOccurrence || new Date(triggerOccurrence.startAt).getTime() !== new Date(snapshot.triggerStartAt).getTime() || !["published", "locked"].includes(triggerOccurrence.lifecycle) || !["scheduled", "completed"].includes(triggerOccurrence.status)) throw new PaymentOperationImmutableMismatchError();

  const linkedPayments = await tx.select().from(payments)
    .where(eq(payments.paymentOperationId, operation.id));
  const rowsByBowler = new Map<number, Payment>();
  for (const payment of linkedPayments) {
    if (payment.status !== "paid" || payment.leagueId !== operation.leagueId || payment.paidByUserId !== operation.authorizingUserId || payment.lineageAmount !== null || payment.prizeFundAmount !== null || payment.receiptEmailMissing !== true) throw new PaymentOperationImmutableMismatchError();
    if (rowsByBowler.has(payment.bowlerId)) throw new PaymentOperationImmutableMismatchError();
    rowsByBowler.set(payment.bowlerId, payment);
  }
  const expectedByBowler = new Map<number, number>();
  for (const item of snapshot.items) expectedByBowler.set(item.bowlerId, (expectedByBowler.get(item.bowlerId) ?? 0) + item.amountMinor);
  if (rowsByBowler.size !== expectedByBowler.size || [...expectedByBowler].some(([bowlerId, amount]) => rowsByBowler.get(bowlerId)?.amount !== amount)) {
    throw new PaymentOperationImmutableMismatchError();
  }

  const [plan] = await tx.select().from(occurrenceCollectionPlans)
    .where(and(
      eq(occurrenceCollectionPlans.id, operation.canonicalPlanId),
      eq(occurrenceCollectionPlans.organizationId, operation.organizationId),
      eq(occurrenceCollectionPlans.leagueId, operation.leagueId),
    )).limit(1).for("update");
  if (!plan) throw new PaymentOperationImmutableMismatchError();
  const planItems = await tx.select().from(occurrenceCollectionPlanItems)
    .where(and(
      eq(occurrenceCollectionPlanItems.planId, plan.id),
      eq(occurrenceCollectionPlanItems.organizationId, operation.organizationId),
      eq(occurrenceCollectionPlanItems.leagueId, operation.leagueId),
    )).orderBy(asc(occurrenceCollectionPlanItems.itemIndex));
  const obligationIds = snapshot.items.map((item) => item.obligationId);
  const obligations = await tx.select().from(bowlerOccurrenceObligations)
    .where(and(
      eq(bowlerOccurrenceObligations.organizationId, operation.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, operation.leagueId),
      inArray(bowlerOccurrenceObligations.id, obligationIds),
    )).for("update");
  const dispatchOwned = operation.dispatchClaimedAt !== null;
  if (obligations.length !== obligationIds.length || planItems.length !== snapshot.items.length || (plan.state !== "ready" && !(dispatchOwned && plan.state === "superseded"))) {
    throw new PaymentOperationImmutableMismatchError();
  }
  if (planItems.some((planItem, index) => {
    const item = snapshot.items[index];
    return !item || planItem.itemIndex !== item.itemIndex || planItem.obligationId !== item.obligationId
      || planItem.occurrenceId !== item.occurrenceId || planItem.bowlerId !== item.bowlerId
      || planItem.amountMinor !== item.amountMinor || planItem.currency !== item.currency;
  })) throw new PaymentOperationImmutableMismatchError();
  const obligationById = new Map(obligations.map((row) => [row.id, row]));
  const activeAllocationRows = await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status, refundedAt: payments.refundedAt, disputedAt: payments.disputedAt, paymentOperationId: payments.paymentOperationId }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, operation.organizationId), eq(paymentOccurrenceAllocations.leagueId, operation.leagueId), inArray(paymentOccurrenceAllocations.obligationId, obligationIds), eq(paymentOccurrenceAllocations.state, "active"))).for("share");
  const allocationOperationIds = [...new Set(activeAllocationRows.map((row) => row.paymentOperationId).filter((id): id is string => id !== null))];
  const disputeOperationIds = allocationOperationIds.length ? new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, operation.organizationId), inArray(paymentDisputes.paymentOperationId, allocationOperationIds)))).map((row) => row.operationId)) : new Set<string>();
  if (activeAllocationRows.some((row) => row.status !== "paid" || row.refundedAt !== null || row.disputedAt !== null || (row.paymentOperationId !== null && disputeOperationIds.has(row.paymentOperationId)))) throw new PaymentOperationImmutableMismatchError();
  const paidBeforeRows = activeAllocationRows.filter((row) => row.status === "paid").map((row) => ({ obligationId: row.obligationId, amountMinor: row.amountMinor }));
  const paidBefore = new Map<string, number>();
  for (const row of paidBeforeRows) paidBefore.set(row.obligationId, (paidBefore.get(row.obligationId) ?? 0) + row.amountMinor);
  for (const item of snapshot.items) {
    const obligation = obligationById.get(item.obligationId);
    if (!obligation || obligation.occurrenceId !== item.occurrenceId || obligation.bowlerId !== item.bowlerId
      || obligation.currency !== item.currency
      || ["voided", "refunded", "disputed", "review_required"].includes(obligation.state)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    if ((paidBefore.get(item.obligationId) ?? 0) + item.amountMinor !== obligation.amountMinor) throw new PaymentOperationImmutableMismatchError();
  }

  for (const row of supplementAllocations) {
    const payment = rowsByBowler.get(row.bowlerId);
    if (!payment) throw new PaymentOperationImmutableMismatchError();
    const allocationKey = `payment-operation:${operation.id}:${row.allocationIndex}`;
    const [created] = await tx.insert(paymentOccurrenceAllocations).values({
      organizationId: operation.organizationId,
      leagueId: operation.leagueId,
      paymentId: payment.id,
      obligationId: row.obligationId,
      occurrenceId: row.occurrenceId,
      bowlerId: row.bowlerId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      state: "active",
      allocationKey,
      currentRevision: 1,
      recordedByUserId: plan.recordedByUserId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (created) {
      await tx.insert(paymentOccurrenceAllocationRevisions).values({
        organizationId: operation.organizationId,
        leagueId: operation.leagueId,
        allocationId: created.id,
        revisionNumber: 1,
        snapshotSchemaVersion: 1,
        beforeSnapshot: null,
        afterSnapshot: { state: "active", amountMinor: row.amountMinor, currency: row.currency, paymentId: payment.id, obligationId: row.obligationId, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId },
        recordedByUserId: plan.recordedByUserId,
        createdAt: now,
      });
    } else {
      const [existing] = await tx.select().from(paymentOccurrenceAllocations).where(and(
        eq(paymentOccurrenceAllocations.organizationId, operation.organizationId),
        eq(paymentOccurrenceAllocations.leagueId, operation.leagueId),
        eq(paymentOccurrenceAllocations.allocationKey, allocationKey),
      )).limit(1).for("share");
      if (!existing || existing.paymentId !== payment.id || existing.obligationId !== row.obligationId || existing.occurrenceId !== row.occurrenceId || existing.bowlerId !== row.bowlerId || existing.amountMinor !== row.amountMinor || existing.currency !== row.currency || existing.state !== "active") throw new PaymentOperationImmutableMismatchError();
      const [existingRevision] = await tx.select({ id: paymentOccurrenceAllocationRevisions.id }).from(paymentOccurrenceAllocationRevisions).where(and(
        eq(paymentOccurrenceAllocationRevisions.organizationId, operation.organizationId),
        eq(paymentOccurrenceAllocationRevisions.leagueId, operation.leagueId),
        eq(paymentOccurrenceAllocationRevisions.allocationId, existing.id),
        eq(paymentOccurrenceAllocationRevisions.revisionNumber, existing.currentRevision),
      )).limit(1);
      if (!existingRevision) throw new PaymentOperationImmutableMismatchError();
    }
  }
  for (const obligation of obligations) {
    const [totals] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentOccurrenceAllocations.amountMinor}), 0)` })
      .from(paymentOccurrenceAllocations)
      .innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId))
      .where(and(
        eq(paymentOccurrenceAllocations.organizationId, operation.organizationId),
        eq(paymentOccurrenceAllocations.leagueId, operation.leagueId),
        eq(paymentOccurrenceAllocations.obligationId, obligation.id),
        eq(paymentOccurrenceAllocations.state, "active"),
        eq(payments.status, "paid"),
      ));
    const state = Number(totals?.total ?? 0) >= obligation.amountMinor ? "settled" : "partially_settled";
    if (state !== obligation.state) {
      const beforeSnapshot = { ...obligation, state: obligation.state };
      const revisionNumber = obligation.currentRevision + 1;
      const [updated] = await tx.update(bowlerOccurrenceObligations).set({ state, currentRevision: revisionNumber, updatedAt: now })
        .where(and(eq(bowlerOccurrenceObligations.id, obligation.id), eq(bowlerOccurrenceObligations.organizationId, operation.organizationId), eq(bowlerOccurrenceObligations.leagueId, operation.leagueId), eq(bowlerOccurrenceObligations.currentRevision, obligation.currentRevision))).returning();
      if (!updated) throw new PaymentOperationImmutableMismatchError();
      await tx.insert(bowlerOccurrenceObligationRevisions).values({
        organizationId: operation.organizationId,
        leagueId: operation.leagueId,
        obligationId: obligation.id,
        revisionNumber,
        snapshotSchemaVersion: 1,
        beforeSnapshot,
        afterSnapshot: { ...updated, state },
        recordedByUserId: plan.recordedByUserId,
        createdAt: now,
      });
    }
  }
  const nextRevision = plan.currentRevision + 1;
  const [fulfilled] = await tx.update(occurrenceCollectionPlans).set({ state: "fulfilled", currentRevision: nextRevision, updatedAt: now })
    .where(and(eq(occurrenceCollectionPlans.id, plan.id), eq(occurrenceCollectionPlans.organizationId, operation.organizationId), eq(occurrenceCollectionPlans.leagueId, operation.leagueId), dispatchOwned ? inArray(occurrenceCollectionPlans.state, ["ready", "superseded"]) : eq(occurrenceCollectionPlans.state, "ready"), eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision))).returning();
  if (!fulfilled) throw new PaymentOperationImmutableMismatchError();
  await tx.insert(occurrenceCollectionPlanRevisions).values({
    organizationId: operation.organizationId,
    leagueId: operation.leagueId,
    planId: plan.id,
    revisionNumber: nextRevision,
    snapshotSchemaVersion: 1,
    beforeSnapshot: { state: plan.state, plan, items: planItems },
    afterSnapshot: { state: "fulfilled", operationId: operation.id, snapshotFingerprint: snapshot.snapshotFingerprint, plan: fulfilled, items: planItems },
    recordedByUserId: plan.recordedByUserId,
    createdAt: now,
  });
}

async function finalizeInteractiveOccurrenceAllocations(
  tx: PaymentOperationTransaction,
  operation: PaymentOperation,
  paymentRows: PaymentOperationLinkedPaymentInput[] | undefined,
  now: string,
): Promise<void> {
  const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
    .where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id))
    .limit(1).for("update");
  if (!supplement) return;
  if (operation.authorizingUserId === null || supplement.amountMinor !== operation.amountMinor || supplement.currency !== operation.currency) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const snapshotAllocations = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations)
    .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id))
    .orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
  if (snapshotAllocations.length !== supplement.allocationCount
    || snapshotAllocations.reduce((sum, row) => sum + row.amountMinor, 0) !== operation.amountMinor) {
    throw new PaymentOperationImmutableMismatchError();
  }
  try {
    const semantic = validatePaymentOperationOccurrenceSnapshot({
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: supplement.snapshotVersion,
      operationId: operation.id,
      operationType: operation.operationType,
      organizationId: operation.organizationId,
      leagueId: supplement.leagueId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      allocations: snapshotAllocations.map((row) => ({
        allocationIndex: row.allocationIndex,
        organizationId: row.organizationId,
        leagueId: row.leagueId,
        occurrenceId: row.occurrenceId,
        bowlerId: row.bowlerId,
        obligationId: row.obligationId,
        amountMinor: row.amountMinor,
        currency: row.currency,
      })),
    });
    if (fingerprintPaymentOperationOccurrenceSnapshot(semantic) !== supplement.snapshotFingerprint) {
      throw new PaymentOperationImmutableMismatchError();
    }
  } catch (error) {
    if (error instanceof PaymentOperationImmutableMismatchError) throw error;
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  const linkedPayments = await tx.select().from(payments)
    .where(eq(payments.paymentOperationId, operation.id));
  const byBowler = new Map(linkedPayments.map((row) => [row.bowlerId, row]));
  const snapshotByBowler = new Map<number, number>();
  for (const row of snapshotAllocations) snapshotByBowler.set(row.bowlerId, (snapshotByBowler.get(row.bowlerId) ?? 0) + row.amountMinor);
  if (byBowler.size !== snapshotByBowler.size || [...snapshotByBowler].some(([bowlerId, amountMinor]) => byBowler.get(bowlerId)?.amount !== amountMinor)) {
    throw new PaymentOperationImmutableMismatchError();
  }
  const obligationIds = [...new Set(snapshotAllocations.map((row) => row.obligationId))];
  const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(
    eq(bowlerOccurrenceObligations.organizationId, operation.organizationId),
    inArray(bowlerOccurrenceObligations.id, obligationIds),
  )).for("update");
  if (obligations.length !== obligationIds.length) throw new PaymentOperationImmutableMismatchError();
  for (const row of snapshotAllocations) {
    const payment = byBowler.get(row.bowlerId);
    if (!payment || payment.status !== "paid" || payment.amount < row.amountMinor) {
      throw new PaymentOperationImmutableMismatchError();
    }
    const allocationKey = `payment-operation:${operation.id}:${row.allocationIndex}`;
    const [created] = await tx.insert(paymentOccurrenceAllocations).values({
      organizationId: operation.organizationId,
      leagueId: supplement.leagueId,
      paymentId: payment.id,
      obligationId: row.obligationId,
      occurrenceId: row.occurrenceId,
      bowlerId: row.bowlerId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      state: "active",
      allocationKey,
      currentRevision: 1,
      recordedByUserId: operation.authorizingUserId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (created) {
      await tx.insert(paymentOccurrenceAllocationRevisions).values({
        organizationId: operation.organizationId,
        leagueId: supplement.leagueId,
        allocationId: created.id,
        revisionNumber: 1,
        snapshotSchemaVersion: 1,
        beforeSnapshot: null,
        afterSnapshot: {
          state: "active", amountMinor: row.amountMinor, currency: row.currency,
          paymentId: payment.id, obligationId: row.obligationId,
          occurrenceId: row.occurrenceId, bowlerId: row.bowlerId,
        },
        recordedByUserId: operation.authorizingUserId,
        createdAt: now,
      });
    }
  }
  for (const obligation of obligations) {
    const [totals] = await tx.select({ total: sql<number>`COALESCE(SUM(${paymentOccurrenceAllocations.amountMinor}), 0)` })
      .from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(
        eq(paymentOccurrenceAllocations.obligationId, obligation.id),
        eq(paymentOccurrenceAllocations.state, "active"),
        eq(payments.status, "paid"),
      ));
    const total = Number(totals?.total ?? 0);
    const state = total >= obligation.amountMinor ? "settled" : total > 0 ? "partially_settled" : "open";
    if (state !== obligation.state) {
      const beforeSnapshot = {
        occurrenceId: obligation.occurrenceId,
        bowlerId: obligation.bowlerId,
        purpose: obligation.purpose,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        dueAt: obligation.dueAt,
        pastDueAt: obligation.pastDueAt,
        state: obligation.state,
        billingTermId: obligation.billingTermId,
        billingTermVersion: obligation.billingTermVersion,
      };
      const afterSnapshot = { ...beforeSnapshot, state };
      const nextRevision = obligation.currentRevision + 1;
      const [updated] = await tx.update(bowlerOccurrenceObligations).set({
        state,
        currentRevision: nextRevision,
        updatedAt: now,
      }).where(and(
        eq(bowlerOccurrenceObligations.id, obligation.id),
        eq(bowlerOccurrenceObligations.organizationId, operation.organizationId),
        eq(bowlerOccurrenceObligations.currentRevision, obligation.currentRevision),
      )).returning({ id: bowlerOccurrenceObligations.id });
      if (!updated) throw new PaymentOperationImmutableMismatchError();
      await tx.insert(bowlerOccurrenceObligationRevisions).values({
        organizationId: operation.organizationId,
        leagueId: obligation.leagueId,
        obligationId: obligation.id,
        revisionNumber: nextRevision,
        snapshotSchemaVersion: 1,
        beforeSnapshot,
        afterSnapshot,
        recordedByUserId: operation.authorizingUserId,
        createdAt: now,
      });
    }
  }
}

/**
 * Transaction-scoped success finalization. Interactive setup uses this to
 * commit the provider outcome, exact payment allocations, future schedule,
 * and setup completion atomically after the provider call.
 */
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
    const [supplement] = await tx.select({ operationId: paymentOperationOccurrenceSnapshots.operationId })
      .from(paymentOperationOccurrenceSnapshots)
      .where(eq(paymentOperationOccurrenceSnapshots.operationId, input.operationId))
      .limit(1);
    if (supplement) {
      const [interactiveSnapshot] = await tx.select({ requestKind: interactivePaymentOperationSnapshots.requestKind })
        .from(interactivePaymentOperationSnapshots)
        .where(eq(interactivePaymentOperationSnapshots.operationId, input.operationId))
        .limit(1);
      if (interactiveSnapshot?.requestKind === "order") throw new PaymentOperationImmutableMismatchError();
    }
  }
  const preflightOperation = await lockCanonicalMutationScope(tx, input.organizationId, input.operationId);
  if (preflightOperation) {
    if (preflightOperation.operationType === "canonical_autopay_charge") {
      // The canonical finalizer repeats the immutable validation immediately
      // before writes and owns plan/allocation completion atomically.
    } else {
      await validateInteractiveOccurrenceSupplementBeforeWrites(tx, preflightOperation);
    }
  }

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
    if (transitioned.operationType === "canonical_autopay_charge") {
      await finalizeCanonicalAutopayInTransaction(tx, transitioned, input.paymentRows, now);
    } else {
      await finalizeInteractiveOccurrenceAllocations(tx, transitioned, input.paymentRows, now);
    }
    await deactivatePaidInFullSchedule(tx, input.operationId, now);
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
    if (existing.operationType === "canonical_autopay_charge") await verifyCanonicalAutopayCompletionInTransaction(tx, existing);
    return existing;
  }
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

function scheduledWebhookPaymentRows(
  operation: PaymentOperation,
  snapshot: ScheduledPaymentSemanticSnapshot,
  input: ProviderWebhookCompletionEvidence,
): PaymentOperationLinkedPaymentInput[] {
  const combinedChargeGroupId = snapshot.allocations.length > 1 ? operation.id : null;
  return snapshot.allocations.map((allocation) => ({
    allocationIndex: allocation.allocationIndex,
    values: {
      bowlerId: allocation.bowlerId,
      leagueId: snapshot.leagueId,
      amount: allocation.amountMinor,
      lineageAmount: allocation.lineageAmountMinor,
      prizeFundAmount: allocation.prizeFundAmountMinor,
      weekOf: snapshot.billingCycleAt,
      status: "paid" as const,
      type: providerNameToPaymentType(snapshot.providerName),
      providerPaymentId: input.providerPaymentId,
      receiptUrl: input.receiptUrl ?? undefined,
      receiptNumber: input.receiptNumber ?? undefined,
      receiptEmailMissing: snapshot.buyerEmail === null,
      notes: allocation.notes,
      paidByUserId: allocation.paidByUserId,
      combinedChargeGroupId,
    },
  }));
}

function interactiveWebhookPaymentRows(
  operation: PaymentOperation,
  snapshot: InteractivePaymentSemanticSnapshot,
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

function canonicalWebhookPaymentRows(
  operation: PaymentOperation,
  snapshot: typeof canonicalAutopayExecutionSnapshots.$inferSelect,
  input: ProviderWebhookCompletionEvidence,
  weekOf: string,
): PaymentOperationLinkedPaymentInput[] {
  const items = snapshot.items as Array<{ itemIndex: number; bowlerId: number; amountMinor: number }>;
  const combinedChargeGroupId = new Set(items.map((item) => item.bowlerId)).size > 1 ? operation.id : null;
  const byBowler = new Map<number, number>();
  for (const item of items) byBowler.set(item.bowlerId, (byBowler.get(item.bowlerId) ?? 0) + item.amountMinor);
  return [...byBowler.entries()].sort(([a], [b]) => a - b).map(([bowlerId, amount], allocationIndex) => ({
    allocationIndex,
    values: {
      bowlerId,
      leagueId: snapshot.leagueId,
      amount,
      // F4 does not synthesize a lineage/prize split or actor identity.
      lineageAmount: null,
      prizeFundAmount: null,
      weekOf,
      status: "paid" as const,
      type: providerNameToPaymentType(operation.providerName),
      providerPaymentId: input.providerPaymentId,
      receiptUrl: input.receiptUrl ?? undefined,
      receiptNumber: input.receiptNumber ?? undefined,
      receiptEmailMissing: true,
      notes: null,
      paidByUserId: operation.authorizingUserId,
      combinedChargeGroupId,
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
  if (!operation || !["scheduled_charge", "interactive_charge", "canonical_autopay_charge"].includes(operation.operationType)) {
    throw new PaymentOperationNotFoundError();
  }
  if (
    operation.providerName !== "square"
    || operation.amountMinor !== input.amountMinor
    || operation.currency !== input.currency
    || (operation.providerObjectId !== null && operation.providerObjectId !== input.providerObjectId)
    || (operation.providerOrderId !== null && operation.providerOrderId !== input.providerOrderId)
  ) throw new PaymentOperationImmutableMismatchError();

  let rows: PaymentOperationLinkedPaymentInput[];
  if (operation.operationType === "scheduled_charge") {
    const snapshot = await loadScheduledPaymentOperationSnapshot(tx, operation);
    if (
      !snapshot
      || snapshot.locationId !== input.locationId
      || (snapshot.providerLocationId !== null
        && snapshot.providerLocationId !== input.providerLocationId)
    ) throw new PaymentOperationImmutableMismatchError();
    rows = scheduledWebhookPaymentRows(operation, snapshot, input);
  } else if (operation.operationType === "interactive_charge") {
    const snapshot = await loadInteractivePaymentOperationSnapshot(tx, operation);
    if (
      !snapshot
      || snapshot.locationId !== input.locationId
      || (snapshot.providerLocationId !== null
        && snapshot.providerLocationId !== input.providerLocationId)
    ) throw new PaymentOperationImmutableMismatchError();
    rows = interactiveWebhookPaymentRows(operation, snapshot, input);
  } else {
    const [snapshot] = await tx.select().from(canonicalAutopayExecutionSnapshots)
      .where(and(
        eq(canonicalAutopayExecutionSnapshots.operationId, operation.id),
        eq(canonicalAutopayExecutionSnapshots.organizationId, operation.organizationId),
      )).limit(1).for("share");
    const [occurrence] = await tx.select({ startAt: leagueOccurrences.startAt })
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.id, snapshot?.triggerOccurrenceId ?? "00000000-0000-0000-0000-000000000000"),
        eq(leagueOccurrences.organizationId, operation.organizationId),
        eq(leagueOccurrences.leagueId, operation.leagueId ?? -1),
      )).limit(1).for("share");
    if (!snapshot || !occurrence || snapshot.locationId !== input.locationId
      || (snapshot.providerLocationId !== input.providerLocationId)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    rows = canonicalWebhookPaymentRows(operation, snapshot, input, occurrence.startAt);
  }

  if (operation.status === "succeeded") {
    if (operation.providerObjectId !== input.providerObjectId) {
      throw new PaymentOperationImmutableMismatchError();
    }
    if (operation.operationType === "canonical_autopay_charge") await verifyCanonicalAutopayCompletionInTransaction(tx, operation);
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
} | {
  kind: "canonical_plan";
  organizationId: number;
  leagueId: number;
  d2PlanId: string;
  dueAt: string;
} | {
  kind: "schedule";
  organizationId: number;
  paymentScheduleId: number;
  dueAt: string;
};

/** Exported so PostgreSQL plan tests exercise the exact production query. */
export function buildNextPaymentOperationWakeQuery() {
  return sql`
    WITH next_schedule AS (
      SELECT
        'schedule'::text AS kind,
        ${leagues.organizationId} AS organization_id,
        ${paymentSchedules.id}::text AS work_id,
        NULL::text AS operation_type,
        NULL::text AS status,
        NULL::integer AS attempt_count,
        NULL::integer AS league_id,
        ${paymentSchedules.nextPaymentDate} AS due_at
      FROM ${paymentSchedules}
      INNER JOIN ${leagues} ON ${paymentSchedules.leagueId} = ${leagues.id}
      WHERE ${paymentSchedules.active} = true
        AND ${leagues.organizationId} IS NOT NULL
      ORDER BY ${paymentSchedules.nextPaymentDate} ASC
      LIMIT 1
    ), next_operation AS (
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
        (${paymentOperations.operationType} <> 'canonical_autopay_charge'
          OR ${sql.raw(canonicalF3AutopayEnabled && canonicalF4AutopayExecutionEnabled ? "TRUE" : "FALSE")})
        AND (
          (${paymentOperations.status} IN ('pending', 'provider_unknown', 'retry_scheduled')
            AND ${paymentOperations.nextAttemptAt} IS NOT NULL)
          OR (${paymentOperations.status} = 'leased'
            AND ${paymentOperations.leaseExpiresAt} IS NOT NULL)
        )
      )
      ORDER BY due_at ASC, ${paymentOperations.id} ASC
      LIMIT 1
    ), next_canonical_plan AS (
      SELECT
        'canonical_plan'::text AS kind,
        ${occurrenceCollectionPlans.organizationId} AS organization_id,
        ${occurrenceCollectionPlans.id}::text AS work_id,
        NULL::text AS operation_type,
        NULL::text AS status,
        NULL::integer AS attempt_count,
        ${occurrenceCollectionPlans.leagueId} AS league_id,
        ${leagueOccurrences.startAt} AS due_at
      FROM ${occurrenceCollectionPlans}
      INNER JOIN ${leagueOccurrences} ON ${occurrenceCollectionPlans.triggerOccurrenceId} = ${leagueOccurrences.id}
        AND ${occurrenceCollectionPlans.organizationId} = ${leagueOccurrences.organizationId}
        AND ${occurrenceCollectionPlans.leagueId} = ${leagueOccurrences.leagueId}
      INNER JOIN f3_autopay_plan_provenance canonical_provenance ON canonical_provenance.d2_plan_id = ${occurrenceCollectionPlans.id}
        AND canonical_provenance.organization_id = ${occurrenceCollectionPlans.organizationId}
        AND canonical_provenance.league_id = ${occurrenceCollectionPlans.leagueId}
      LEFT JOIN ${paymentOperations} AS canonical_operation ON canonical_operation.organization_id = ${occurrenceCollectionPlans.organizationId}
        AND canonical_operation.league_id = ${occurrenceCollectionPlans.leagueId}
        AND canonical_operation.canonical_plan_id = ${occurrenceCollectionPlans.id}
        AND canonical_operation.operation_type = 'canonical_autopay_charge'
      WHERE ${sql.raw(canonicalF3AutopayEnabled && canonicalF4AutopayExecutionEnabled ? "TRUE" : "FALSE")}
        AND ${occurrenceCollectionPlans.state} = 'ready'
        AND ${occurrenceCollectionPlans.triggerOccurrenceId} IS NOT NULL
        AND ${leagueOccurrences.lifecycle} IN ('published', 'locked')
        AND ${leagueOccurrences.status} IN ('scheduled', 'completed')
        AND canonical_operation.id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM canonical_autopay_execution_snapshots blocked_snapshot
          INNER JOIN payment_operations blocked_operation ON blocked_operation.id = blocked_snapshot.operation_id
            AND blocked_operation.organization_id = blocked_snapshot.organization_id
            AND blocked_operation.league_id = blocked_snapshot.league_id
          WHERE blocked_snapshot.authorization_id = canonical_provenance.authorization_id
            AND blocked_snapshot.organization_id = canonical_provenance.organization_id
            AND blocked_snapshot.league_id = canonical_provenance.league_id
            AND blocked_operation.operation_type = 'canonical_autopay_charge'
            AND blocked_operation.status IN ('action_required', 'leased', 'provider_unknown', 'reconciliation_required')
        )
      ORDER BY ${leagueOccurrences.startAt} ASC, ${occurrenceCollectionPlans.id} ASC
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
    FROM (
      SELECT * FROM next_schedule
      UNION ALL
      SELECT * FROM next_operation
      UNION ALL
      SELECT * FROM next_canonical_plan
    ) AS scheduled_payment_work
    ORDER BY scheduled_payment_work.due_at ASC
    LIMIT 1
  `;
}

/** One indexed query for the earliest schedule preparation or operation work. */
export async function getNextPaymentOperationWake(): Promise<PaymentOperationWake | undefined> {
  const result = await db.execute<{
    kind: "operation" | "schedule" | "canonical_plan";
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
  if (row.kind === "canonical_plan") {
    if (row.league_id === null) throw new PaymentOperationValidationError("canonical plan wake row is incomplete");
    return {
      kind: "canonical_plan",
      organizationId: Number(row.organization_id),
      leagueId: Number(row.league_id),
      d2PlanId: row.work_id,
      dueAt: row.due_at,
    };
  }
  if (row.kind === "schedule") {
    return {
      kind: "schedule",
      organizationId: Number(row.organization_id),
      paymentScheduleId: Number(row.work_id),
      dueAt: row.due_at,
    };
  }
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
    const [current] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
    )).limit(1).for("update");
    if (current?.operationType === "canonical_autopay_charge") {
      if (current.status !== "reconciliation_required" || current.leaseToken !== input.leaseToken) return undefined;
      const [reclaimed] = await tx.update(paymentOperations).set({
        status: "leased",
        nextAttemptAt: null,
        leaseOwner: "explicit-reconciliation",
        leaseExpiresAt: new Date(new Date(now).getTime() + PAYMENT_OPERATION_MAX_LEASE_MS).toISOString(),
        errorClassification: null,
        errorCode: null,
        completedAt: null,
        updatedAt: now,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "reconciliation_required"),
        eq(paymentOperations.leaseToken, input.leaseToken),
      )).returning();
      if (!reclaimed) return undefined;
      return finalizePaymentOperationSuccessInTransaction(tx, {
        organizationId: input.organizationId,
        operationId: reclaimed.id,
        leaseToken: input.leaseToken,
        providerObjectId: input.providerObjectId,
        providerOrderId: input.providerOrderId,
        paymentRows: input.paymentRows,
        now: input.now,
      });
    }
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
    await insertLinkedPaymentRows(tx, input.organizationId, input.operationId, input.paymentRows);
    await deactivatePaidInFullSchedule(tx, input.operationId, now);
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
export async function hasNonterminalScheduledPaymentOperation(input: {
  organizationId: number;
  paymentScheduleId: number;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: paymentOperations.id })
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.operationType, "scheduled_charge"),
      eq(paymentOperations.paymentScheduleId, input.paymentScheduleId),
      inArray(paymentOperations.status, [
        "pending",
        "leased",
        "provider_unknown",
        "retry_scheduled",
        "reconciliation_required",
      ]),
    ))
    .limit(1);
  return row !== undefined;
}

export interface LegacyScheduledPaymentCycleBlock {
  operationId: string;
  status: PaymentOperation["status"];
  scope: "exact_cycle" | "in_flight" | "uncertain";
}

/**
 * Called only while the exact-cycle PostgreSQL advisory lock is held. Exact
 * identity always wins; a lease or uncertain older outcome also blocks a
 * rollback-era legacy dispatch, while definite older outcomes do not.
 */
export async function getLegacyScheduledPaymentCycleBlock(input: {
  organizationId: number;
  paymentScheduleId: number;
  billingCycleAt: string | Date;
}): Promise<LegacyScheduledPaymentCycleBlock | undefined> {
  const billingCycleAt = input.billingCycleAt instanceof Date
    ? toIso(input.billingCycleAt, "billingCycleAt")
    : storedTimestampToIso(input.billingCycleAt);
  if (billingCycleAt === null) {
    throw new PaymentOperationValidationError("billingCycleAt must be a valid timestamp");
  }
  const [row] = await db
    .select({
      operationId: paymentOperations.id,
      status: paymentOperations.status,
      exactCycle: sql<boolean>`${paymentOperations.billingCycleAt} = ${billingCycleAt}::timestamp`,
    })
    .from(paymentOperations)
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.operationType, "scheduled_charge"),
      eq(paymentOperations.paymentScheduleId, input.paymentScheduleId),
      or(
        sql`${paymentOperations.billingCycleAt} = ${billingCycleAt}::timestamp`,
        eq(paymentOperations.status, "leased"),
        inArray(paymentOperations.status, ["provider_unknown", "reconciliation_required"]),
      ),
    ))
    .orderBy(asc(paymentOperations.createdAt))
    .limit(1);
  if (!row) return undefined;
  return {
    operationId: row.operationId,
    status: row.status,
    scope: row.exactCycle
      ? "exact_cycle"
      : row.status === "leased"
        ? "in_flight"
        : "uncertain",
  };
}

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
