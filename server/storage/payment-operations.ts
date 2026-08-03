import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
  scheduledPaymentOperationAllocations,
  scheduledPaymentOperationLineItems,
  scheduledPaymentOperationSnapshots,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationLineItems,
  interactivePaymentOperationSnapshots,
  users,
  PAYMENT_OPERATION_ERROR_CLASSIFICATIONS,
  PAYMENT_OPERATION_MAX_ATTEMPTS,
  PAYMENT_OPERATION_MAX_LEASE_MS,
  PAYMENT_OPERATION_MAX_RETRY_DELAY_MS,
  type PaymentOperation,
  type PaymentOperationErrorClassification,
} from "@shared/schema";
import { db } from "../db.js";
import {
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
  reconstructInteractivePaymentSnapshot,
  type InteractivePaymentSemanticSnapshot,
} from "../services/interactive-payment-operation-snapshot.js";

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
}

export interface CreateOrGetInteractivePaymentOperationInput {
  organizationId: number;
  targetKey: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  now?: Date;
}

export interface CreateOrGetGeneralInteractivePaymentOperationInput {
  organizationId: number;
  requestKey: string;
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
export const GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH =
  INTERACTIVE_REQUEST_KEY_MAX_LENGTH;

interface ErrorOutcomeInput extends LeasedPaymentOperationInput {
  errorCode?: string | null;
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

/**
 * Creates dormant durable intent for one interactive charge. This primitive
 * does not acquire a lease or call a provider; an explicit executor must do
 * both in a later behavior-cutover release.
 */
export async function createOrGetInteractivePaymentOperation(
  input: CreateOrGetInteractivePaymentOperationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const identity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "interactive_charge",
    targetKey: input.targetKey,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
  });
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
  return createOrGetInteractivePaymentOperation({
    organizationId: input.organizationId,
    targetKey: buildGeneralInteractiveTargetKey(input.requestKey),
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerName: input.providerName,
    now: input.now,
  }, existingTransaction);
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
      .select({ id: paymentSchedules.id })
      .from(paymentSchedules)
      .innerJoin(leagues, eq(paymentSchedules.leagueId, leagues.id))
      .where(and(
        eq(paymentSchedules.id, input.paymentScheduleId),
        eq(leagues.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("share");
    if (!owned) throw new PaymentOperationNotFoundError();

    const [created] = await tx
      .insert(paymentOperations)
      .values({
        organizationId: request.organizationId,
        operationType: request.operationType,
        targetKey: request.targetKey,
        paymentScheduleId: request.paymentScheduleId,
        billingCycleAt: request.billingCycleAt,
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
    if (!existing || !immutableScheduledOperationMatches(existing, identity)) {
      throw new PaymentOperationImmutableMismatchError();
    }
    return existing;
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

  let stored: InteractivePaymentSemanticSnapshot | undefined;
  try {
    stored = await loadInteractivePaymentOperationSnapshot(transaction, operation);
  } catch (error) {
    throw new PaymentOperationImmutableMismatchError({ cause: error });
  }
  if (!stored || encrypted.snapshotFingerprint !== fingerprintInteractivePaymentSnapshot(stored)) {
    throw new PaymentOperationImmutableMismatchError();
  }
  return stored;
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
      attemptCount: sql`${paymentOperations.attemptCount} + 1`,
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
      lt(paymentOperations.attemptCount, PAYMENT_OPERATION_MAX_ATTEMPTS),
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

export async function schedulePaymentOperationRetry(
  input: ErrorOutcomeInput & {
    nextAttemptAt: Date;
    errorClassification: PaymentOperationErrorClassification;
  },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const nextAttemptAt = validateFutureDueAt(input.nextAttemptAt, nowDate, "nextAttemptAt");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const updated = await db.transaction(async (tx) => {
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

async function recordTerminalErrorOutcome(
  input: ErrorOutcomeInput & {
    status: "action_required" | "failed_terminal";
    errorClassification: PaymentOperationErrorClassification;
  },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateFailedPaymentRows(input.failedPaymentRows);
  if (input.providerOrderId != null) validateProviderOrderId(input.providerOrderId);
  const now = toIso(input.now ?? new Date(), "now");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const updated = await db.transaction(async (tx) => {
    const [transitioned] = await tx
      .update(paymentOperations)
      .set({
        status: input.status,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
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
    return existing;
  }
  throw new PaymentOperationInvalidTransitionError(existing.status);
}

export async function finalizePaymentOperationSuccess(
  input: FinalizePaymentOperationSuccessInput,
): Promise<PaymentOperation> {
  return db.transaction((tx) => finalizePaymentOperationSuccessInTransaction(tx, input));
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
        CASE
          WHEN ${paymentOperations.status} = 'leased' THEN ${paymentOperations.leaseExpiresAt}
          ELSE ${paymentOperations.nextAttemptAt}
        END AS due_at
      FROM ${paymentOperations}
      WHERE (
        ${paymentOperations.status} IN ('pending', 'provider_unknown', 'retry_scheduled')
        AND ${paymentOperations.nextAttemptAt} IS NOT NULL
      ) OR (
        ${paymentOperations.status} = 'leased'
        AND ${paymentOperations.leaseExpiresAt} IS NOT NULL
      )
      ORDER BY due_at ASC
      LIMIT 1
    )
    SELECT
      kind,
      organization_id,
      work_id,
      operation_type,
      status,
      attempt_count,
      (due_at AT TIME ZONE 'UTC')::text AS due_at
    FROM (
      SELECT * FROM next_schedule
      UNION ALL
      SELECT * FROM next_operation
    ) AS scheduled_payment_work
    ORDER BY scheduled_payment_work.due_at ASC
    LIMIT 1
  `;
}

/** One indexed query for the earliest schedule preparation or operation work. */
export async function getNextPaymentOperationWake(): Promise<PaymentOperationWake | undefined> {
  const result = await db.execute<{
    kind: "operation" | "schedule";
    organization_id: number;
    work_id: string;
    operation_type: PaymentOperation["operationType"] | null;
    status: PaymentOperation["status"] | null;
    attempt_count: number | null;
    due_at: string;
  }>(buildNextPaymentOperationWakeQuery());
  const row = result.rows[0];
  if (!row) return undefined;
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
