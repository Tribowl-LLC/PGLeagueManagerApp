import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import {
  leagues,
  paymentOperations,
  paymentSchedules,
  PAYMENT_OPERATION_ERROR_CLASSIFICATIONS,
  PAYMENT_OPERATION_MAX_ATTEMPTS,
  PAYMENT_OPERATION_MAX_LEASE_MS,
  PAYMENT_OPERATION_MAX_RETRY_DELAY_MS,
  type PaymentOperation,
  type PaymentOperationErrorClassification,
} from "@shared/schema";
import { db } from "../db.js";
import { buildPaymentOperationIdentity } from "../services/payment-operation-idempotency.js";

export class PaymentOperationNotFoundError extends Error {
  constructor() {
    super("Payment operation not found");
    this.name = "PaymentOperationNotFoundError";
  }
}

export class PaymentOperationImmutableMismatchError extends Error {
  constructor() {
    super("Existing payment operation does not match the immutable request");
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

interface ErrorOutcomeInput extends LeasedPaymentOperationInput {
  errorCode?: string | null;
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

/**
 * Concurrent callers converge on the partial recurring-cycle uniqueness
 * constraint. A conflict is returned only when every immutable field still
 * matches; amount/currency/tenant/target drift fails closed.
 */
export async function createOrGetScheduledPaymentOperation(
  input: CreateOrGetScheduledPaymentOperationInput,
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

  return db.transaction(async (tx) => {
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
  });
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
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const nextAttemptAt = validateFutureDueAt(input.nextAttemptAt, nowDate, "nextAttemptAt");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const [updated] = await db
    .update(paymentOperations)
    .set({
      status: "retry_scheduled",
      nextAttemptAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorClassification: input.errorClassification,
      errorCode,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
      lt(paymentOperations.attemptCount, PAYMENT_OPERATION_MAX_ATTEMPTS),
    ))
    .returning();
  if (!updated) return throwInvalidTransition(input.organizationId, input.operationId);
  return updated;
}

export async function recordPaymentOperationProviderUnknown(
  input: ErrorOutcomeInput & { recoveryAt: Date },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  const nowDate = input.now ?? new Date();
  const now = toIso(nowDate, "now");
  const nextAttemptAt = validateFutureDueAt(input.recoveryAt, nowDate, "recoveryAt");
  const errorCode = validateErrorDetails("provider_unknown", input.errorCode);

  const [updated] = await db
    .update(paymentOperations)
    .set({
      status: "provider_unknown",
      nextAttemptAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorClassification: "provider_unknown",
      errorCode,
      updatedAt: now,
    })
    .where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.status, "leased"),
      eq(paymentOperations.leaseToken, input.leaseToken),
    ))
    .returning();
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
  const now = toIso(input.now ?? new Date(), "now");
  const errorCode = validateErrorDetails(input.errorClassification, input.errorCode);

  const [updated] = await db
    .update(paymentOperations)
    .set({
      status: input.status,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
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
    ))
    .returning();
  if (!updated) return throwInvalidTransition(input.organizationId, input.operationId);
  return updated;
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

export async function finalizePaymentOperationSuccess(
  input: LeasedPaymentOperationInput & { providerObjectId: string },
): Promise<PaymentOperation> {
  validateLeaseToken(input.leaseToken);
  validateProviderObjectId(input.providerObjectId);
  const now = toIso(input.now ?? new Date(), "now");

  const [updated] = await db
    .update(paymentOperations)
    .set({
      status: "succeeded",
      providerObjectId: input.providerObjectId,
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
    ))
    .returning();
  if (updated) return updated;

  const existing = await getPaymentOperationForOrganization(input.organizationId, input.operationId);
  if (!existing) throw new PaymentOperationNotFoundError();
  if (
    existing.status === "succeeded"
    && existing.leaseToken === input.leaseToken
    && existing.providerObjectId === input.providerObjectId
  ) {
    return existing;
  }
  throw new PaymentOperationInvalidTransitionError(existing.status);
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
