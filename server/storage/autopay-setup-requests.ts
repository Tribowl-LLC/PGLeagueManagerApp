import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AUTOPAY_SETUP_SNAPSHOT_VERSION,
  autopaySetupRequests,
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  payments,
  users,
  type AutopaySetupRequest,
  type AutopaySetupSnapshot,
  type PaymentOperation,
  type PaymentSchedule,
} from "@shared/schema";
import { db } from "../db.js";
import {
  buildPaymentOperationIdentity,
  canonicalizePaymentOperationInput,
} from "../services/payment-operation-idempotency.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import {
  createOrGetInteractivePaymentOperation,
  finalizePaymentOperationSuccessInTransaction,
  type FinalizePaymentOperationSuccessInput,
  type PaymentOperationLinkedPaymentInput,
  type PaymentOperationTransaction,
} from "./payment-operations.js";
import { lockLeagueSchedule } from "./league-schedule-lock.js";
import {
  assertNoOccurrenceReferenceConflict,
  logOccurrenceCompatibility,
  occurrenceCompatibilityTransactionTime,
  resolveCanonicalOccurrenceCompatibility,
} from "../services/canonical-occurrence-compatibility.js";

export const AUTOPAY_SETUP_REQUEST_FINGERPRINT_PREFIX = "lvautopaysetup:v1:" as const;

export type AutopaySetupSnapshotInput = Omit<
  AutopaySetupSnapshot,
  | "snapshotVersion"
  | "organizationId"
  | "payerBowlerId"
  | "leagueId"
  | "sourceFingerprint"
>;

export interface CreateOrGetAutopaySetupRequestInput {
  organizationId: number;
  payerBowlerId: number;
  leagueId: number;
  quoteFingerprint: string;
  sourceId: string;
  customerId?: string | null;
  buyerEmail?: string | null;
  snapshot: AutopaySetupSnapshotInput;
  now?: Date;
}

export interface AutopaySetupRequestWithOperation {
  request: AutopaySetupRequest;
  operation: PaymentOperation | null;
}

export class AutopaySetupRequestNotFoundError extends Error {
  constructor() {
    super("Auto-pay setup request not found");
    this.name = "AutopaySetupRequestNotFoundError";
  }
}

export class AutopaySetupRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutopaySetupRequestValidationError";
  }
}

export class AutopaySetupRequestImmutableMismatchError extends Error {
  constructor() {
    super("Existing auto-pay setup request does not match the immutable input");
    this.name = "AutopaySetupRequestImmutableMismatchError";
  }
}

export class AutopaySetupRequestInvalidTransitionError extends Error {
  constructor(status: string) {
    super(`Auto-pay setup request cannot transition from ${status}`);
    this.name = "AutopaySetupRequestInvalidTransitionError";
  }
}

function positiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AutopaySetupRequestValidationError(`${label} must be a positive integer`);
  }
}

function exactUtcTimestamp(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AutopaySetupRequestValidationError(`${label} must be an exact UTC timestamp`);
  }
}

function setupRequestIdFromDigest(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(chars[16] ?? "0", 16) % 4];
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function validateSnapshot(snapshot: AutopaySetupSnapshot): void {
  positiveId(snapshot.organizationId, "snapshot.organizationId");
  positiveId(snapshot.payerBowlerId, "snapshot.payerBowlerId");
  positiveId(snapshot.leagueId, "snapshot.leagueId");
  positiveId(snapshot.locationId, "snapshot.locationId");
  if (snapshot.snapshotVersion !== AUTOPAY_SETUP_SNAPSHOT_VERSION) {
    throw new AutopaySetupRequestValidationError("snapshotVersion is unsupported");
  }
  if (snapshot.providerName !== "square" || snapshot.currency !== "USD") {
    throw new AutopaySetupRequestValidationError("setup provider or currency is unsupported");
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot.sourceFingerprint)) {
    throw new AutopaySetupRequestValidationError("sourceFingerprint is invalid");
  }
  if (!Number.isSafeInteger(snapshot.immediateAmountMinor) || snapshot.immediateAmountMinor < 0) {
    throw new AutopaySetupRequestValidationError("immediateAmountMinor is invalid");
  }
  if (!Number.isSafeInteger(snapshot.firstAutomaticAmountMinor) || snapshot.firstAutomaticAmountMinor < 0) {
    throw new AutopaySetupRequestValidationError("firstAutomaticAmountMinor is invalid");
  }
  if (!Number.isSafeInteger(snapshot.recurringAmountMinor) || snapshot.recurringAmountMinor <= 0) {
    throw new AutopaySetupRequestValidationError("recurringAmountMinor is invalid");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(snapshot.competitionStartTime)) {
    throw new AutopaySetupRequestValidationError("competitionStartTime is invalid");
  }
  if (snapshot.timezone.length === 0 || snapshot.timezone.trim() !== snapshot.timezone) {
    throw new AutopaySetupRequestValidationError("timezone is invalid");
  }

  const additionalIds = snapshot.additionalBowlerIds;
  if (
    additionalIds.some((id) => !Number.isSafeInteger(id) || id <= 0 || id === snapshot.payerBowlerId)
    || new Set(additionalIds).size !== additionalIds.length
    || [...additionalIds].sort((left, right) => left - right).some((id, index) => id !== additionalIds[index])
  ) {
    throw new AutopaySetupRequestValidationError("additionalBowlerIds must be unique and sorted");
  }

  const allowedBowlerIds = new Set([snapshot.payerBowlerId, ...additionalIds]);
  const occurrenceKeys = new Set<string>();
  let allocationTotal = 0;
  let previousAllocation: AutopaySetupSnapshot["allocations"][number] | undefined;
  for (const [index, allocation] of snapshot.allocations.entries()) {
    if (allocation.allocationIndex !== index) {
      throw new AutopaySetupRequestValidationError("allocation indexes must be contiguous");
    }
    positiveId(allocation.bowlerId, "allocation.bowlerId");
    if (!allowedBowlerIds.has(allocation.bowlerId)) {
      throw new AutopaySetupRequestValidationError("allocation bowler is not a setup payee");
    }
    exactUtcTimestamp(allocation.occurrenceAt, "allocation.occurrenceAt");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(allocation.localDate)) {
      throw new AutopaySetupRequestValidationError("allocation.localDate is invalid");
    }
    if (allocation.classification !== "past_due" && allocation.classification !== "due_today") {
      throw new AutopaySetupRequestValidationError("allocation.classification is invalid");
    }
    if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) {
      throw new AutopaySetupRequestValidationError("allocation.amountMinor is invalid");
    }
    for (const [label, value] of [
      ["allocation.lineageAmountMinor", allocation.lineageAmountMinor],
      ["allocation.prizeFundAmountMinor", allocation.prizeFundAmountMinor],
    ] as const) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new AutopaySetupRequestValidationError(`${label} is invalid`);
      }
    }
    const key = `${allocation.bowlerId}:${allocation.occurrenceAt}`;
    if (occurrenceKeys.has(key)) {
      throw new AutopaySetupRequestValidationError("allocations must be unique per bowler occurrence");
    }
    occurrenceKeys.add(key);
    allocationTotal += allocation.amountMinor;
    if (!Number.isSafeInteger(allocationTotal)) {
      throw new AutopaySetupRequestValidationError("allocation total exceeds the safe integer range");
    }
    if (
      previousAllocation
      && (
        allocation.occurrenceAt < previousAllocation.occurrenceAt
        || (
          allocation.occurrenceAt === previousAllocation.occurrenceAt
          && allocation.bowlerId < previousAllocation.bowlerId
        )
      )
    ) {
      throw new AutopaySetupRequestValidationError("allocations must be ordered by occurrence and bowler");
    }
    previousAllocation = allocation;
  }
  if (allocationTotal !== snapshot.immediateAmountMinor) {
    throw new AutopaySetupRequestValidationError("allocation total does not match immediate amount");
  }

  if (snapshot.firstAutomaticAt === null) {
    if (snapshot.firstAutomaticLocalDate !== null || snapshot.firstAutomaticAmountMinor !== 0) {
      throw new AutopaySetupRequestValidationError("empty first automatic occurrence is inconsistent");
    }
  } else {
    exactUtcTimestamp(snapshot.firstAutomaticAt, "firstAutomaticAt");
    if (
      snapshot.firstAutomaticAmountMinor <= 0
      || !snapshot.firstAutomaticLocalDate
      || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.firstAutomaticLocalDate)
    ) {
      throw new AutopaySetupRequestValidationError("first automatic occurrence is inconsistent");
    }
  }

  if (snapshot.immediateAmountMinor === 0) {
    if (snapshot.requestKind !== null || snapshot.lineItems.length !== 0) {
      throw new AutopaySetupRequestValidationError("zero-dollar setup cannot contain charge material");
    }
  } else if (snapshot.requestKind === "direct") {
    if (snapshot.lineItems.length !== 0) {
      throw new AutopaySetupRequestValidationError("direct charge cannot contain order line items");
    }
  } else if (snapshot.requestKind === "order") {
    if (snapshot.lineItems.length === 0) {
      throw new AutopaySetupRequestValidationError("order charge requires line items");
    }
    for (const lineItem of snapshot.lineItems) {
      if (
        !lineItem.catalogObjectId
        || lineItem.catalogObjectId.length > 255
        || lineItem.catalogObjectId.trim() !== lineItem.catalogObjectId
        || !/^[1-9][0-9]*$/.test(lineItem.quantity)
      ) {
        throw new AutopaySetupRequestValidationError("order line item is invalid");
      }
    }
  } else {
    throw new AutopaySetupRequestValidationError("positive setup requires a charge request kind");
  }
}

async function validateTenantReferences(
  tx: PaymentOperationTransaction,
  snapshot: AutopaySetupSnapshot,
): Promise<void> {
  const bowlerIds = [snapshot.payerBowlerId, ...snapshot.additionalBowlerIds];
  const paidByUserIds = [...new Set(snapshot.allocations
    .map((allocation) => allocation.paidByUserId)
    .filter((id): id is number => id !== null))];
  // A transaction owns one pinned pg client. Keep its queries sequential:
  // pg@8 only warns when client.query() overlaps, while pg@9 will reject it.
  const ownedOrganization = await tx.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.id, snapshot.organizationId));
  const ownedLeague = await tx.select({ id: leagues.id, locationId: leagues.locationId }).from(leagues)
    .where(and(
      eq(leagues.id, snapshot.leagueId),
      eq(leagues.organizationId, snapshot.organizationId),
    ));
  const ownedLocation = await tx.select({ id: locations.id }).from(locations)
    .where(and(
      eq(locations.id, snapshot.locationId),
      eq(locations.organizationId, snapshot.organizationId),
    ));
  const ownedBowlers = await tx.select({ id: bowlers.id }).from(bowlers)
    .where(and(
      eq(bowlers.organizationId, snapshot.organizationId),
      inArray(bowlers.id, bowlerIds),
    ));
  const activeRoster = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues)
    .where(and(
      eq(bowlerLeagues.leagueId, snapshot.leagueId),
      eq(bowlerLeagues.active, true),
      inArray(bowlerLeagues.bowlerId, bowlerIds),
    ));
  const ownedUsers = paidByUserIds.length === 0
    ? []
    : await tx.select({ id: users.id }).from(users)
      .where(and(
        eq(users.organizationId, snapshot.organizationId),
        inArray(users.id, paidByUserIds),
      ));
  if (
    ownedOrganization.length !== 1
    || ownedLeague.length !== 1
    || ownedLeague[0]?.locationId !== snapshot.locationId
    || ownedLocation.length !== 1
    || ownedBowlers.length !== bowlerIds.length
    || activeRoster.length !== bowlerIds.length
    || ownedUsers.length !== paidByUserIds.length
  ) {
    throw new AutopaySetupRequestValidationError(
      "auto-pay setup references do not belong to the authorized tenant and league",
    );
  }
}

function buildRequestIdentity(input: CreateOrGetAutopaySetupRequestInput): {
  id: string;
  requestFingerprint: string;
  snapshot: AutopaySetupSnapshot;
  customerId: string | null;
  buyerEmail: string | null;
} {
  positiveId(input.organizationId, "organizationId");
  positiveId(input.payerBowlerId, "payerBowlerId");
  positiveId(input.leagueId, "leagueId");
  if (!/^lvautopayquote:v1:[0-9a-f]{64}$/.test(input.quoteFingerprint)) {
    throw new AutopaySetupRequestValidationError("quoteFingerprint is invalid");
  }
  if (!input.sourceId || input.sourceId.trim() !== input.sourceId || input.sourceId.length > 512) {
    throw new AutopaySetupRequestValidationError("sourceId is invalid");
  }
  const customerId = normalizedOptional(input.customerId);
  const buyerEmail = normalizedOptional(input.buyerEmail)?.toLowerCase() ?? null;
  const sourceFingerprint = createHash("sha256").update(input.sourceId).digest("hex");
  const snapshot: AutopaySetupSnapshot = {
    ...input.snapshot,
    snapshotVersion: AUTOPAY_SETUP_SNAPSHOT_VERSION,
    organizationId: input.organizationId,
    payerBowlerId: input.payerBowlerId,
    leagueId: input.leagueId,
    sourceFingerprint,
  };
  validateSnapshot(snapshot);
  const digest = createHash("sha256")
    .update(canonicalizePaymentOperationInput({
      quoteFingerprint: input.quoteFingerprint,
      snapshot,
      customerId,
      buyerEmail,
    }))
    .digest("hex");
  return {
    id: setupRequestIdFromDigest(digest),
    requestFingerprint: `${AUTOPAY_SETUP_REQUEST_FINGERPRINT_PREFIX}${digest}`,
    snapshot,
    customerId,
    buyerEmail,
  };
}

function storedTimestampToIso(value: string): string {
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  return new Date(includesZone ? value : `${value.replace(" ", "T")}Z`).toISOString();
}

function immutableRequestMatches(
  request: AutopaySetupRequest,
  identity: ReturnType<typeof buildRequestIdentity>,
  input: CreateOrGetAutopaySetupRequestInput,
): boolean {
  return request.id === identity.id
    && request.organizationId === input.organizationId
    && request.payerBowlerId === input.payerBowlerId
    && request.leagueId === input.leagueId
    && request.quoteFingerprint === input.quoteFingerprint
    && request.requestFingerprint === identity.requestFingerprint
    && canonicalizePaymentOperationInput(request.snapshot)
      === canonicalizePaymentOperationInput(identity.snapshot)
    && decrypt(request.encryptedSourceId) === input.sourceId
    && (request.encryptedCustomerId === null
      ? identity.customerId === null
      : decrypt(request.encryptedCustomerId) === identity.customerId)
    && (request.encryptedBuyerEmail === null
      ? identity.buyerEmail === null
      : decrypt(request.encryptedBuyerEmail) === identity.buyerEmail);
}

async function loadOperation(
  tx: PaymentOperationTransaction,
  request: AutopaySetupRequest,
): Promise<PaymentOperation | null> {
  if (request.paymentOperationId === null) return null;
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, request.organizationId),
    eq(paymentOperations.id, request.paymentOperationId),
  )).limit(1);
  if (!operation) throw new AutopaySetupRequestImmutableMismatchError();
  const identity = buildPaymentOperationIdentity({
    organizationId: request.organizationId,
    operationType: "interactive_charge",
    targetKey: `autopay-setup:${request.id}`,
    amountMinor: request.snapshot.immediateAmountMinor,
    currency: request.snapshot.currency,
    providerName: request.snapshot.providerName,
  });
  if (
    operation.operationType !== "interactive_charge"
    || operation.targetKey !== identity.normalizedRequest.targetKey
    || operation.paymentScheduleId !== null
    || operation.billingCycleAt !== null
    || operation.amountMinor !== request.snapshot.immediateAmountMinor
    || operation.currency !== request.snapshot.currency
    || operation.providerName !== request.snapshot.providerName
    || operation.requestFingerprint !== identity.requestFingerprint
    || operation.providerIdempotencyKey !== identity.providerIdempotencyKey
  ) {
    throw new AutopaySetupRequestImmutableMismatchError();
  }
  return operation;
}

async function validateCompletedPaymentAllocations(
  tx: PaymentOperationTransaction,
  request: AutopaySetupRequest,
): Promise<void> {
  if (request.paymentOperationId === null) {
    throw new AutopaySetupRequestImmutableMismatchError();
  }
  const rows = await tx.select().from(payments).where(and(
    eq(payments.paymentOperationId, request.paymentOperationId),
    eq(payments.leagueId, request.leagueId),
  )).orderBy(asc(payments.paymentOperationAllocationIndex));
  if (rows.length !== request.snapshot.allocations.length) {
    throw new AutopaySetupRequestInvalidTransitionError("payment_allocations_incomplete");
  }
  for (const [index, allocation] of request.snapshot.allocations.entries()) {
    const row = rows[index];
    if (
      !row
      || row.paymentOperationAllocationIndex !== allocation.allocationIndex
      || row.bowlerId !== allocation.bowlerId
      || row.leagueId !== request.leagueId
      || row.amount !== allocation.amountMinor
      || row.lineageAmount !== allocation.lineageAmountMinor
      || row.prizeFundAmount !== allocation.prizeFundAmountMinor
      || row.notes !== allocation.notes
      || row.paidByUserId !== allocation.paidByUserId
      || row.status !== "paid"
      || row.type !== "square"
      || storedTimestampToIso(row.weekOf) !== allocation.occurrenceAt
    ) {
      throw new AutopaySetupRequestImmutableMismatchError();
    }
  }
}

export async function createOrGetAutopaySetupRequest(
  input: CreateOrGetAutopaySetupRequestInput,
): Promise<AutopaySetupRequestWithOperation> {
  const identity = buildRequestIdentity(input);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AutopaySetupRequestValidationError("now is invalid");
  }
  const nowIso = now.toISOString();

  return db.transaction(async (tx) => {
    await validateTenantReferences(tx, identity.snapshot);
    const operation = identity.snapshot.immediateAmountMinor === 0
      ? null
      : await createOrGetInteractivePaymentOperation({
        organizationId: input.organizationId,
        targetKey: `autopay-setup:${identity.id}`,
        amountMinor: identity.snapshot.immediateAmountMinor,
        currency: identity.snapshot.currency,
        providerName: identity.snapshot.providerName,
        now,
      }, tx);

    const [created] = await tx.insert(autopaySetupRequests).values({
      id: identity.id,
      organizationId: input.organizationId,
      payerBowlerId: input.payerBowlerId,
      leagueId: input.leagueId,
      quoteFingerprint: input.quoteFingerprint,
      requestFingerprint: identity.requestFingerprint,
      paymentOperationId: operation?.id ?? null,
      encryptedSourceId: encrypt(input.sourceId),
      encryptedCustomerId: identity.customerId === null ? null : encrypt(identity.customerId),
      encryptedBuyerEmail: identity.buyerEmail === null ? null : encrypt(identity.buyerEmail),
      snapshot: identity.snapshot,
      workflowStatus: "pending",
      createdAt: nowIso,
      updatedAt: nowIso,
    }).onConflictDoNothing().returning();
    if (created) return { request: created, operation };

    const [existing] = await tx.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, identity.id),
    )).limit(1);
    if (!existing || !immutableRequestMatches(existing, identity, input)) {
      throw new AutopaySetupRequestImmutableMismatchError();
    }
    const existingOperation = await loadOperation(tx, existing);
    if ((existing.paymentOperationId === null) !== (existingOperation === null)) {
      throw new AutopaySetupRequestImmutableMismatchError();
    }
    return { request: existing, operation: existingOperation };
  });
}

export async function getAutopaySetupRequestForOrganization(
  organizationId: number,
  requestId: string,
): Promise<AutopaySetupRequestWithOperation | undefined> {
  const [owned] = await db.select({ request: autopaySetupRequests })
    .from(autopaySetupRequests)
    .innerJoin(leagues, and(
      eq(leagues.id, autopaySetupRequests.leagueId),
      eq(leagues.organizationId, autopaySetupRequests.organizationId),
    ))
    .innerJoin(bowlers, and(
      eq(bowlers.id, autopaySetupRequests.payerBowlerId),
      eq(bowlers.organizationId, autopaySetupRequests.organizationId),
    ))
    .where(and(
      eq(autopaySetupRequests.organizationId, organizationId),
      eq(autopaySetupRequests.id, requestId),
    )).limit(1);
  if (!owned) return undefined;
  const operation = await db.transaction((tx) => loadOperation(tx, owned.request));
  return { request: owned.request, operation };
}

export async function getAutopaySetupRequestByOperationForOrganization(
  organizationId: number,
  operationId: string,
): Promise<AutopaySetupRequest | undefined> {
  const [owned] = await db.select({ request: autopaySetupRequests })
    .from(autopaySetupRequests)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, autopaySetupRequests.paymentOperationId),
      eq(paymentOperations.organizationId, autopaySetupRequests.organizationId),
      eq(paymentOperations.operationType, "interactive_charge"),
    ))
    .innerJoin(leagues, and(
      eq(leagues.id, autopaySetupRequests.leagueId),
      eq(leagues.organizationId, autopaySetupRequests.organizationId),
    ))
    .innerJoin(bowlers, and(
      eq(bowlers.id, autopaySetupRequests.payerBowlerId),
      eq(bowlers.organizationId, autopaySetupRequests.organizationId),
    ))
    .where(and(
      eq(autopaySetupRequests.organizationId, organizationId),
      eq(autopaySetupRequests.paymentOperationId, operationId),
    )).limit(1);
  if (!owned) return undefined;
  await db.transaction((tx) => loadOperation(tx, owned.request));
  return owned.request;
}

async function ensureAutopaySetupSchedule(
  tx: PaymentOperationTransaction,
  request: AutopaySetupRequest,
): Promise<PaymentSchedule | null> {
  const { snapshot } = request;
  if (snapshot.firstAutomaticAt === null) return null;
  const sourceId = decrypt(request.encryptedSourceId);
  if (!sourceId) {
    throw new AutopaySetupRequestImmutableMismatchError();
  }
  await lockLeagueSchedule(tx, request.organizationId, request.leagueId);
  const comparison = await resolveCanonicalOccurrenceCompatibility(tx, {
    subject: "payment_schedule",
    organizationId: request.organizationId,
    leagueId: request.leagueId,
    legacyStartAt: snapshot.firstAutomaticAt,
    immediateUpfront: false,
    eligibilityNow: await occurrenceCompatibilityTransactionTime(tx),
    existingReferenceId: null,
  });
  assertNoOccurrenceReferenceConflict(comparison);
  logOccurrenceCompatibility("autopay_setup_schedule_create", comparison);
  const nextOccurrenceId = comparison.classification === "exact_match"
    ? comparison.occurrenceId
    : null;
  const [inserted] = await tx.insert(paymentSchedules).values({
    bowlerId: request.payerBowlerId,
    leagueId: request.leagueId,
    frequency: "weekly",
    amount: snapshot.recurringAmountMinor,
    nextPaymentDate: snapshot.firstAutomaticAt,
    nextOccurrenceId,
    active: true,
    paymentCardId: sourceId,
    additionalBowlerIds: snapshot.additionalBowlerIds.length > 0
      ? snapshot.additionalBowlerIds
      : null,
  }).onConflictDoNothing().returning();
  const schedule = inserted ?? await tx.select().from(paymentSchedules).where(and(
    eq(paymentSchedules.bowlerId, request.payerBowlerId),
    eq(paymentSchedules.leagueId, request.leagueId),
    eq(paymentSchedules.active, true),
  )).limit(1).then((rows) => rows[0]);
  if (
    !schedule
    || storedTimestampToIso(schedule.nextPaymentDate) !== snapshot.firstAutomaticAt
    || schedule.amount !== snapshot.recurringAmountMinor
    || schedule.frequency !== "weekly"
    || schedule.paymentCardId !== sourceId
    || (schedule.nextOccurrenceId !== null && schedule.nextOccurrenceId !== nextOccurrenceId)
    || canonicalizePaymentOperationInput(schedule.additionalBowlerIds ?? [])
      !== canonicalizePaymentOperationInput(snapshot.additionalBowlerIds)
  ) {
    throw new AutopaySetupRequestValidationError(
      "an incompatible active payment schedule already exists",
    );
  }
  return schedule;
}

async function markAutopaySetupCompleted(
  tx: PaymentOperationTransaction,
  request: AutopaySetupRequest,
  schedule: PaymentSchedule | null,
  now: string,
): Promise<AutopaySetupRequest> {
  const [completed] = await tx.update(autopaySetupRequests).set({
    workflowStatus: "completed",
    paymentScheduleId: schedule?.id ?? null,
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(autopaySetupRequests.organizationId, request.organizationId),
    eq(autopaySetupRequests.id, request.id),
    eq(autopaySetupRequests.workflowStatus, "pending"),
  )).returning();
  if (!completed) {
    throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
  }
  return completed;
}

export async function finalizeZeroDollarAutopaySetupRequest(input: {
  organizationId: number;
  requestId: string;
  now?: Date;
}): Promise<{ request: AutopaySetupRequest; schedule: PaymentSchedule | null }> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AutopaySetupRequestValidationError("now is invalid");
  }
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, input.requestId),
    )).limit(1).for("update");
    if (!request) throw new AutopaySetupRequestNotFoundError();
    if (request.workflowStatus === "completed") {
      const schedule = request.paymentScheduleId === null
        ? null
        : await tx.select().from(paymentSchedules)
          .where(eq(paymentSchedules.id, request.paymentScheduleId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      return { request, schedule };
    }
    if (
      request.workflowStatus !== "pending"
      || request.snapshot.immediateAmountMinor !== 0
      || request.paymentOperationId !== null
    ) {
      throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    }
    const schedule = await ensureAutopaySetupSchedule(tx, request);
    const completed = await markAutopaySetupCompleted(
      tx,
      request,
      schedule,
      now.toISOString(),
    );
    return { request: completed, schedule };
  });
}

export async function finalizeAutopaySetupOperationSuccess(
  input: Omit<FinalizePaymentOperationSuccessInput, "paymentRows"> & {
    paymentRows: PaymentOperationLinkedPaymentInput[];
  },
): Promise<{
  request: AutopaySetupRequest;
  operation: PaymentOperation;
  schedule: PaymentSchedule | null;
}> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AutopaySetupRequestValidationError("now is invalid");
  }
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.paymentOperationId, input.operationId),
    )).limit(1).for("update");
    if (!request) throw new AutopaySetupRequestNotFoundError();
    const loadedOperation = await loadOperation(tx, request);
    if (!loadedOperation) throw new AutopaySetupRequestImmutableMismatchError();
    const operation = await finalizePaymentOperationSuccessInTransaction(tx, {
      ...input,
      now,
    });
    if (request.workflowStatus === "completed") {
      const schedule = request.paymentScheduleId === null
        ? null
        : await tx.select().from(paymentSchedules)
          .where(eq(paymentSchedules.id, request.paymentScheduleId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      return { request, operation, schedule };
    }
    if (request.workflowStatus !== "pending") {
      throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    }
    await validateCompletedPaymentAllocations(tx, request);
    const schedule = await ensureAutopaySetupSchedule(tx, request);
    const completed = await markAutopaySetupCompleted(
      tx,
      request,
      schedule,
      now.toISOString(),
    );
    return { request: completed, operation, schedule };
  });
}

export async function completeAutopaySetupRequest(input: {
  organizationId: number;
  requestId: string;
  paymentScheduleId?: number | null;
  now?: Date;
}): Promise<AutopaySetupRequest> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AutopaySetupRequestValidationError("now is invalid");
  }
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, input.requestId),
    )).limit(1).for("update");
    if (!request) throw new AutopaySetupRequestNotFoundError();
    if (request.workflowStatus === "completed") return request;
    if (request.workflowStatus !== "pending") {
      throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    }

    const operation = await loadOperation(tx, request);
    if (request.snapshot.immediateAmountMinor > 0 && operation?.status !== "succeeded") {
      throw new AutopaySetupRequestInvalidTransitionError(operation?.status ?? "missing_operation");
    }
    if (request.snapshot.immediateAmountMinor > 0) {
      await validateCompletedPaymentAllocations(tx, request);
    }
    if (request.snapshot.immediateAmountMinor === 0 && operation !== null) {
      throw new AutopaySetupRequestImmutableMismatchError();
    }

    const paymentScheduleId = input.paymentScheduleId ?? null;
    if (request.snapshot.firstAutomaticAt === null) {
      if (paymentScheduleId !== null) {
        throw new AutopaySetupRequestValidationError("setup without a future occurrence cannot link a schedule");
      }
    } else {
      if (paymentScheduleId === null) {
        throw new AutopaySetupRequestValidationError("setup with a future occurrence requires a schedule");
      }
      const [schedule] = await tx.select({
        nextPaymentDate: paymentSchedules.nextPaymentDate,
        amount: paymentSchedules.amount,
        frequency: paymentSchedules.frequency,
        paymentCardId: paymentSchedules.paymentCardId,
        additionalBowlerIds: paymentSchedules.additionalBowlerIds,
      }).from(paymentSchedules)
        .innerJoin(leagues, eq(paymentSchedules.leagueId, leagues.id))
        .where(and(
          eq(paymentSchedules.id, paymentScheduleId),
          eq(paymentSchedules.bowlerId, request.payerBowlerId),
          eq(paymentSchedules.leagueId, request.leagueId),
          eq(paymentSchedules.active, true),
          eq(leagues.organizationId, input.organizationId),
        )).limit(1);
      if (
        !schedule
        || storedTimestampToIso(schedule.nextPaymentDate)
          !== request.snapshot.firstAutomaticAt
        || schedule.amount !== request.snapshot.recurringAmountMinor
        || schedule.frequency !== "weekly"
        || schedule.paymentCardId !== decrypt(request.encryptedSourceId)
        || canonicalizePaymentOperationInput(schedule.additionalBowlerIds ?? [])
          !== canonicalizePaymentOperationInput(request.snapshot.additionalBowlerIds)
      ) {
        throw new AutopaySetupRequestValidationError("payment schedule does not match the setup snapshot");
      }
    }

    const nowIso = now.toISOString();
    const [completed] = await tx.update(autopaySetupRequests).set({
      workflowStatus: "completed",
      paymentScheduleId,
      completedAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, input.requestId),
      eq(autopaySetupRequests.workflowStatus, "pending"),
    )).returning();
    if (!completed) throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    return completed;
  });
}

export async function cancelAutopaySetupRequest(input: {
  organizationId: number;
  requestId: string;
  now?: Date;
}): Promise<AutopaySetupRequest> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AutopaySetupRequestValidationError("now is invalid");
  }
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(autopaySetupRequests).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, input.requestId),
    )).limit(1).for("update");
    if (!request) throw new AutopaySetupRequestNotFoundError();
    if (request.workflowStatus === "canceled") return request;
    if (request.workflowStatus !== "pending") {
      throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    }
    const operation = await loadOperation(tx, request);
    if (operation && !["action_required", "failed_terminal", "canceled"].includes(operation.status)) {
      throw new AutopaySetupRequestInvalidTransitionError(operation.status);
    }
    const nowIso = now.toISOString();
    const [canceled] = await tx.update(autopaySetupRequests).set({
      workflowStatus: "canceled",
      canceledAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(autopaySetupRequests.organizationId, input.organizationId),
      eq(autopaySetupRequests.id, input.requestId),
      eq(autopaySetupRequests.workflowStatus, "pending"),
    )).returning();
    if (!canceled) throw new AutopaySetupRequestInvalidTransitionError(request.workflowStatus);
    return canceled;
  });
}
