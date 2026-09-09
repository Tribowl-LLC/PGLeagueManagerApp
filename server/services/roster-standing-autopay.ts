import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, ne, or, sql } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerLeagues,
  bowlerPaymentLinks,
  bowlers,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  financialCommands,
  leagueOccurrences,
  leagues,
  occurrencePaymentResponsibilities,
  paymentAllocations,
  refundAllocationAdjustments,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  refundPaymentOperationSnapshots,
  teams,
  users,
  type PaymentOperation,
} from "@shared/schema";
import type {
  StandingAutopayConsentRequest,
  StandingAutopayQuoteWire,
  StandingAutopayRevokeRequest,
} from "@shared/standing-autopay-contract";
import { buildPaymentOperationIdentity, canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { db } from "../db.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { rosterStandingAutopayEnabled, scheduledPaymentExecutionMode } from "../config.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { validateRosterSnapshotForDispatchInTransaction } from "./roster-payment-finalizer.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";

const CONSENT_FP_PREFIX = "lvstandingconsent:v1:";
const PARTNER_FP_PREFIX = "lvpartnerlink:v1:";
const CUTOFF_FP_PREFIX = "lvstandingcutoff:v1:";
const COMMAND_CONSENT = "standing_autopay_consent";
const COMMAND_REVOKE = "standing_autopay_revoke";
const COMMAND_CUTOFF = "standing_autopay_cutoff";
let rearmStandingAutopayWake: () => Promise<void> = async () => undefined;

export function configureStandingAutopayRuntime(input: { rearm: () => Promise<void> }): void {
  rearmStandingAutopayWake = input.rearm;
}

export async function notifyStandingAutopayMutation(): Promise<void> {
  await rearmStandingAutopayWake();
}

export class StandingAutopayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "StandingAutopayError";
  }
}

export class StandingAutopayReplay extends StandingAutopayError {
  constructor(public readonly result: unknown) {
    super("IDEMPOTENCY_REPLAY", "The standing automatic-payment command was already applied", 200);
  }
}

type StandingTx = PaymentOperationTransaction;

function digest(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex")}`;
}

function iso(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StandingAutopayError("INVALID_TIMESTAMP", "The standing cutoff timestamp is invalid", 422);
  return parsed.toISOString();
}

async function providerLocationIdentity(provider: Awaited<ReturnType<typeof getPaymentProvider>>): Promise<string> {
  const resolve = provider.getProviderLocationId;
  if (typeof resolve !== "function") throw new StandingAutopayError("PAYMENT_PROVIDER_IDENTITY_UNAVAILABLE", "The payment provider location identity is unavailable", 422);
  const value = (await resolve.call(provider)).trim();
  if (!value) throw new StandingAutopayError("PAYMENT_PROVIDER_IDENTITY_UNAVAILABLE", "The payment provider location identity is unavailable", 422);
  return value;
}

async function beginCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; actorUserId: number; commandType: string; key: string; fingerprint: string },
): Promise<void> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  )).limit(1).for("update");
  if (existing) {
    if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== input.fingerprint) {
      throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
    }
    if (existing.state === "applied" && existing.result !== null) throw new StandingAutopayReplay(existing.result);
    if (existing.state === "failed") throw new StandingAutopayError(existing.errorCode ?? "COMMAND_FAILED", "The standing command previously failed");
    return;
  }
  await tx.insert(financialCommands).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: input.commandType,
    idempotencyKey: input.key,
    requestFingerprint: input.fingerprint,
    state: "accepted",
  });
}

async function applyCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; commandType: string; key: string; result: unknown },
): Promise<void> {
  await tx.update(financialCommands).set({ state: "applied", result: input.result }).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  ));
}

async function leagueFor(tx: StandingTx, organizationId: number, leagueId: number) {
  const [league] = await tx.select().from(leagues).where(and(eq(leagues.organizationId, organizationId), eq(leagues.id, leagueId))).limit(1);
  if (!league) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.payingLineupSize === null) throw new StandingAutopayError("ROSTER_PAYMENTS_REQUIRED", "Standing automatic payments require a roster-configured league");
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are weekly only for upfront leagues", 422);
  return league;
}

async function activeMembership(tx: StandingTx, organizationId: number, leagueId: number, bowlerIds: number[]): Promise<boolean> {
  if (bowlerIds.length === 0) return false;
  const rows = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(
    eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true),
  )).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, bowlerIds)));
  return new Set(rows.map((row) => row.bowlerId)).size === new Set(bowlerIds).size;
}

function linkFingerprint(link: Pick<typeof bowlerPaymentLinks.$inferSelect, "id" | "bowlerAId" | "bowlerBId" | "organizationId" | "status" | "respondedAt">): string {
  return digest(PARTNER_FP_PREFIX, {
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  });
}

async function consentPartners(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId: string; consentVersion: number; payerBowlerId: number }): Promise<Array<typeof autopayConsentPartners.$inferSelect>> {
  const rows = await tx.select({ evidence: autopayConsentPartners, link: bowlerPaymentLinks }).from(autopayConsentPartners).innerJoin(bowlerPaymentLinks, and(
    eq(bowlerPaymentLinks.id, autopayConsentPartners.paymentLinkId), eq(bowlerPaymentLinks.organizationId, input.organizationId),
  )).where(and(
    eq(autopayConsentPartners.organizationId, input.organizationId), eq(autopayConsentPartners.leagueId, input.leagueId),
    eq(autopayConsentPartners.consentId, input.consentId), eq(autopayConsentPartners.consentVersion, input.consentVersion),
  )).orderBy(asc(autopayConsentPartners.partnerBowlerId)).for("update");
  for (const row of rows) {
    if (row.link.status !== "accepted" || row.evidence.linkFingerprint !== linkFingerprint(row.link)) throw new StandingAutopayError("PARTNER_AUTHORIZATION_CHANGED", "An accepted payment partner authorization changed");
    if (![row.link.bowlerAId, row.link.bowlerBId].includes(input.payerBowlerId) || ![row.link.bowlerAId, row.link.bowlerBId].includes(row.evidence.partnerBowlerId) || row.link.bowlerAId === row.link.bowlerBId) throw new StandingAutopayError("PARTNER_AUTHORIZATION_INVALID", "The standing partner authorization is invalid");
  }
  return rows.map((row) => row.evidence);
}

async function activeConsent(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId?: string; payerBowlerId?: number }) {
  const conditions = [eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.state, "active" as const)];
  if (input.consentId) conditions.push(eq(autopayConsents.id, input.consentId));
  if (input.payerBowlerId) conditions.push(eq(autopayConsents.payerBowlerId, input.payerBowlerId));
  const [consent] = await tx.select().from(autopayConsents).where(and(...conditions)).limit(1).for("update");
  if (!consent) return undefined;
  if (consent.paymentMode !== "weekly" || !consent.providerName || !consent.providerLocationId || !consent.encryptedSourceId || !consent.encryptedCustomerId || consent.revokedAt !== null) throw new StandingAutopayError("CONSENT_INVALID", "The standing consent is not dispatchable");
  return consent;
}

const unresolvedRefundOperationStatuses = [
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
] as const;

/** Return exact payer/occurrence keys whose retained allocation is covered by
 * a refund operation that has not reached a terminal provider outcome. The
 * check is deliberately allocation-derived: it follows the immutable refund
 * snapshot to the original payment, then the original active allocation and
 * obligation, without creating a second balance or obligation ledger. */
async function pendingRefundPayerWeekKeys(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; occurrenceIds: string[] },
): Promise<Set<string>> {
  if (input.payerBowlerIds.length === 0 || input.occurrenceIds.length === 0) return new Set();
  const rows = await tx.select({
    payerBowlerId: paymentObligations.payerBowlerId,
    occurrenceId: paymentObligations.occurrenceId,
  }).from(refundPaymentOperationSnapshots)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "refund"),
    ))
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.paymentId, refundPaymentOperationSnapshots.paymentId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
    ))
    .innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentAllocations.obligationId),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    ))
    .where(and(
      eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
      inArray(paymentOperations.status, unresolvedRefundOperationStatuses),
      inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
      inArray(paymentObligations.occurrenceId, input.occurrenceIds),
    ));
  return new Set(rows.map((row) => `${row.payerBowlerId}:${row.occurrenceId}`));
}

async function eligibleRows(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string; dueMode: "exact" | "paired"; occurrenceIds?: string[] },
): Promise<Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number; responsibilityVersion: number }>> {
  const obligations = await tx.select({ obligation: paymentObligations, responsibilityVersion: occurrencePaymentResponsibilities.version })
    .from(paymentObligations)
    .innerJoin(occurrencePaymentResponsibilities, and(
      eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ))
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
      inArray(paymentObligations.state, ["open", "partially_settled"] as const),
      gte(paymentObligations.dueAt, input.activationAt),
      ...(input.dueMode === "exact" ? [eq(paymentObligations.dueAt, input.cutoffAt)] : []),
      ...(input.occurrenceIds?.length ? [inArray(paymentObligations.occurrenceId, input.occurrenceIds)] : []),
    )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  const obligationIds = obligations.map((row) => row.obligation.id);
  const payerOccurrenceKeys = [...new Set(obligations.map((row) => `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`))];
  const allOccurrenceIds = [...new Set(obligations.map((row) => row.obligation.occurrenceId))];
  const allPayerWeekObligations = payerOccurrenceKeys.length === 0 ? [] : await tx.select({ obligation: paymentObligations }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    inArray(paymentObligations.occurrenceId, allOccurrenceIds),
  ));
  const allObligationIds = [...new Set(allPayerWeekObligations.map((row) => row.obligation.id))];
  const allocations = allObligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, allObligationIds),
  ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId), eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
  ));
  const adjustmentByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const reservedRows = obligationIds.length === 0 ? [] : await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"), inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
  ));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  const reservedByObligationId = new Map<string, number>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  for (const reservation of reservedRows) reservedByObligationId.set(reservation.obligationId, (reservedByObligationId.get(reservation.obligationId) ?? 0) + reservation.amountMinor);
  const result: Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number; responsibilityVersion: number }> = [];
  // A still-owed refund is a manual-only hold for the payer's whole
  // occurrence/week. The source component may already be settled by a later
  // cash/check/card repayment, so derive the marker from all obligations in
  // the same payer/week rather than only the currently eligible rows.
  const outstandingByPayerWeek = new Map<string, number>();
  const stillOwedByPayerWeek = new Set<string>();
  for (const row of allPayerWeekObligations) {
    const key = `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`;
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    outstandingByPayerWeek.set(key, (outstandingByPayerWeek.get(key) ?? 0) + balance.outstandingMinor);
    if ((adjustmentsByObligationId.get(row.obligation.id) ?? []).some((adjustment) => adjustment.disposition === "still_owed")) {
      stillOwedByPayerWeek.add(key);
    }
  }
  const heldPayerWeeks = new Set<string>([...stillOwedByPayerWeek].filter((key) => (outstandingByPayerWeek.get(key) ?? 0) > 0));
  for (const key of await pendingRefundPayerWeekKeys(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerIds: input.payerBowlerIds,
    occurrenceIds: allOccurrenceIds,
  })) heldPayerWeeks.add(key);
  for (const row of obligations) {
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    const reservedMinor = reservedByObligationId.get(row.obligation.id) ?? 0;
    const outstandingMinor = balance.outstandingMinor - reservedMinor;
    if (outstandingMinor > 0) result.push({ obligation: row.obligation, outstandingMinor, responsibilityVersion: row.responsibilityVersion });
  }
  return result.filter((row) => !heldPayerWeeks.has(`${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`));
}

/** Standing collection is deliberately current-only. Any older unpaid or
 * reserved capacity must be settled by a one-time FIFO tender first. */
async function assertNoStandingArrears(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string },
): Promise<void> {
  const rows = await tx.select({ obligation: paymentObligations }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
    eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
    lt(paymentObligations.dueAt, input.cutoffAt),
  )).for("update");
  const obligationIds = rows.map((row) => row.obligation.id);
  const allocations = obligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, obligationIds),
  ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId), eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
  ));
  const adjustmentByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  const reservations = obligationIds.length === 0 ? [] : await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"), inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
  ));
  const reservedByObligationId = new Map<string, number>();
  for (const reservation of reservations) reservedByObligationId.set(reservation.obligationId, (reservedByObligationId.get(reservation.obligationId) ?? 0) + reservation.amountMinor);
  for (const row of rows) {
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    if (balance.outstandingMinor > 0 || (reservedByObligationId.get(row.obligation.id) ?? 0) > 0) {
      throw new StandingAutopayError("ARREARS_REQUIRE_ONE_TIME_FIFO", "Standing automatic payment is blocked until older unpaid obligations are settled by a one-time FIFO payment", 409);
    }
  }
}

/** A competing cutoff may temporarily own every remaining cent. It is not a
 * durable empty decision: once that operation is canceled/reconciled, the
 * same cutoff must be discoverable again. */
async function hasOpenReservedObligations(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string; dueMode: "exact" | "paired"; occurrenceIds: string[] },
): Promise<boolean> {
  const [row] = await tx.select({ id: paymentObligations.id }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
    eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).innerJoin(paymentOperationRosterSnapshotItems, and(
    eq(paymentOperationRosterSnapshotItems.obligationId, paymentObligations.id),
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
  )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
    gte(paymentObligations.dueAt, input.activationAt),
    ...(input.dueMode === "exact" ? [eq(paymentObligations.dueAt, input.cutoffAt)] : []),
    inArray(paymentObligations.occurrenceId, input.occurrenceIds),
  )).limit(1).for("share");
  return Boolean(row);
}

type StandingCutoffGroup = {
  mode: "weekly" | "double_pay";
  /** A published paired member is never independently chargeable.  Its
   * trigger owns the cutoff; when the trigger was durably blocked, the pair
   * must remain manual rather than silently becoming a weekly charge. */
  suppressed?: boolean;
  groupId: string | null;
  groupRevision: number | null;
  groupFingerprint: string | null;
  triggerOccurrenceId: string;
  pairedOccurrenceId: string | null;
  triggerMemberId: string | null;
  pairedMemberId: string | null;
  occurrenceIds: string[];
  triggerOccurrenceRevision: number;
};

/** Resolve one exact published trigger. A double-pay is all-or-nothing: the
 * group identity and both member identities are captured before obligations
 * are selected. */
async function groupForCutoff(tx: StandingTx, input: { organizationId: number; leagueId: number; cutoffAt: string }): Promise<StandingCutoffGroup> {
  const occurrence = (await tx.select({ id: leagueOccurrences.id, currentRevision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), eq(leagueOccurrences.startAt, input.cutoffAt))).limit(1))[0];
  if (!occurrence) throw new StandingAutopayError("TRIGGER_OCCURRENCE_MISSING", "The standing cutoff occurrence is unavailable", 409);
  const members = await tx.select({ group: canonicalCollectionGroups, member: canonicalCollectionGroupMembers }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
    eq(canonicalCollectionGroupMembers.groupId, canonicalCollectionGroups.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true),
  )).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.state, "published"), eq(canonicalCollectionGroupMembers.occurrenceId, occurrence.id))).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal)).for("share");
  const trigger = members.find((row) => row.member.role === "trigger");
  if (!trigger) {
    const paired = members.find((row) => row.member.role === "paired");
    return {
      mode: "weekly",
      suppressed: Boolean(paired),
      groupId: null,
      groupRevision: null,
      groupFingerprint: null,
      triggerOccurrenceId: occurrence.id,
      triggerOccurrenceRevision: occurrence.currentRevision,
      pairedOccurrenceId: null,
      triggerMemberId: null,
      pairedMemberId: paired?.member.id ?? null,
      occurrenceIds: [occurrence.id],
    };
  }
  const allMembers = await tx.select({ group: canonicalCollectionGroups, member: canonicalCollectionGroupMembers }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
    eq(canonicalCollectionGroupMembers.groupId, trigger.group.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true),
  )).where(and(eq(canonicalCollectionGroups.id, trigger.group.id), eq(canonicalCollectionGroups.state, "published"))).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal)).for("share");
  const paired = allMembers.find((row) => row.member.role === "paired");
  if (allMembers.length !== 2 || !paired) throw new StandingAutopayError("DOUBLE_PAY_GROUP_INVALID", "The published double-pay group is incomplete", 409);
  return { mode: "double_pay", groupId: trigger.group.id, groupRevision: trigger.group.currentRevision, groupFingerprint: trigger.group.fingerprint, triggerOccurrenceId: trigger.member.occurrenceId, triggerOccurrenceRevision: occurrence.currentRevision, pairedOccurrenceId: paired.member.occurrenceId, triggerMemberId: trigger.member.id, pairedMemberId: paired.member.id, occurrenceIds: [trigger.member.occurrenceId, paired.member.occurrenceId] };
}

/** Revoke a consent while the league lock is held.  Replacement and explicit
 * revoke share this fence so a pre-dispatch reservation can never strand the
 * cutoff for the next consent version. */
async function revokeConsentAndStopOperationsInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; consent: typeof autopayConsents.$inferSelect; revokedAt: string },
) {
  const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id)).where(and(
    eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "standing_autopay_charge"), eq(paymentOperationStandingAutopayBindings.consentId, input.consent.id), eq(paymentOperationStandingAutopayBindings.consentVersion, input.consent.consentVersion),
  )).orderBy(asc(paymentOperations.id)).for("update");
  await tx.update(autopayConsents).set({ state: "revoked", revokedAt: input.revokedAt }).where(and(eq(autopayConsents.id, input.consent.id), eq(autopayConsents.state, "active")));
  for (const { operation } of operations) {
    if (["pending", "leased", "retry_scheduled"].includes(operation.status) && operation.dispatchClaimedAt === null && operation.providerObjectId === null) {
      await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.operationId, operation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
      await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, dispatchClaimedAt: null, errorClassification: null, errorCode: null, completedAt: input.revokedAt, updatedAt: input.revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
    } else if (["leased", "provider_unknown", "retry_scheduled", "pending"].includes(operation.status) && (operation.dispatchClaimedAt !== null || operation.providerObjectId !== null)) {
      await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "CONSENT_REVOKED_AFTER_DISPATCH", updatedAt: input.revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
    }
  }
  return { ...input.consent, state: "revoked" as const, revokedAt: input.revokedAt };
}

async function latestActionableStandingOperation(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number },
  consent: typeof autopayConsents.$inferSelect | undefined,
  payerBowlerId: number,
): Promise<"scheduled_payment_declined" | null> {
  if (!consent) return null;
  const [row] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).innerJoin(
    paymentOperationStandingAutopayBindings,
    and(
      eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id),
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
    ),
  ).innerJoin(
    autopayConsents,
    and(
      eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId),
      eq(autopayConsents.consentVersion, paymentOperationStandingAutopayBindings.consentVersion),
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      eq(autopayConsents.payerBowlerId, payerBowlerId),
    ),
  ).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "standing_autopay_charge"),
    eq(paymentOperations.status, "action_required"),
    sql`EXISTS (
      SELECT 1
      FROM payment_operation_roster_snapshot_items snapshot_item
      INNER JOIN payment_obligations obligation
        ON obligation.id = snapshot_item.obligation_id
       AND obligation.organization_id = snapshot_item.organization_id
       AND obligation.league_id = snapshot_item.league_id
      WHERE snapshot_item.organization_id = ${input.organizationId}
        AND snapshot_item.league_id = ${input.leagueId}
        AND snapshot_item.operation_id = ${paymentOperations.id}
        AND obligation.state IN ('open', 'partially_settled')
        AND obligation.amount_minor > (
          SELECT COALESCE(SUM(allocation.amount_minor), 0)
          FROM payment_allocations allocation
          WHERE allocation.organization_id = ${input.organizationId}
            AND allocation.league_id = ${input.leagueId}
            AND allocation.obligation_id = obligation.id
            AND allocation.state = 'active'
        )
    )`,
  )).orderBy(
    desc(paymentOperations.completedAt),
    desc(paymentOperations.updatedAt),
    desc(paymentOperations.id),
  ).limit(1);
  if (!row) return null;
  return "scheduled_payment_declined";
}

function consentWire(
  consent: typeof autopayConsents.$inferSelect | undefined,
  partners: number[],
  organizationId: number,
  leagueId: number,
  payerBowlerId: number,
  paymentAttention: "scheduled_payment_declined" | null = null,
) {
  return {
    contractVersion: "standing-autopay-consent/1" as const,
    organizationId, leagueId, payerBowlerId,
    consentId: consent?.id ?? null,
    consentVersion: consent?.consentVersion ?? null,
    state: consent?.state ?? "none",
    paymentMode: "weekly" as const,
    partnerBowlerIds: partners,
    paymentAttention,
  };
}

export async function readStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") {
    return consentWire(undefined, [], input.organizationId, input.leagueId, input.payerBowlerId);
  }
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, input);
    const partners = consent ? await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId }) : [];
    const paymentAttention = await latestActionableStandingOperation(tx, input, consent, input.payerBowlerId);
    return consentWire(consent, partners.map((row) => row.partnerBowlerId), input.organizationId, input.leagueId, input.payerBowlerId, paymentAttention);
  });
}

export async function activateStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayConsentRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const league = await db.select({ locationId: leagues.locationId, paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).then((rows) => rows[0]);
  if (!league || league.locationId === null) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are disabled for upfront leagues", 422);
  const [payer] = await db.select().from(bowlers).where(and(eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
  const customerId = payer?.paymentCustomerId ?? null;
  if (!payer || !customerId) throw new StandingAutopayError("PAYMENT_CUSTOMER_MISMATCH", "The payment method belongs to another payer", 403);
  const provider = await getPaymentProvider(league.locationId);
  const providerName = provider.providerName;
  const providerLocationId = await providerLocationIdentity(provider);
  if (!provider.validateCardId(input.request.sourceId) || !provider.hasCardOnFile) throw new StandingAutopayError("PAYMENT_METHOD_INVALID", "The saved payment method is unavailable", 422);
  if (!(await provider.hasCardOnFile(customerId, input.request.sourceId))) throw new StandingAutopayError("PAYMENT_METHOD_NOT_OWNED", "The saved payment method is unavailable", 403);
  if (input.request.partnerBowlerIds.length > 0) throw new StandingAutopayError("PARTNERS_NOT_SUPPORTED", "Automatic payment applies to one bowler; enter shared payments separately", 422);
  const partnerIds: number[] = [];
  const commandFingerprint = digest("lvstandingcommand:v1:", { leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, sourceId: input.request.sourceId, customerId, providerName, providerLocationId, partnerIds });
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const lockedLeague = await leagueFor(tx, input.organizationId, input.leagueId);
    if (lockedLeague.locationId === null || lockedLeague.locationId !== league.locationId) throw new StandingAutopayError("LEAGUE_PROVIDER_LOCATION_CHANGED", "The league payment location changed; retry consent setup", 409);
    const lockedProvider = await getPaymentProvider(lockedLeague.locationId);
    const lockedProviderLocationId = await providerLocationIdentity(lockedProvider);
    if (lockedProvider.providerName !== providerName || lockedProviderLocationId !== providerLocationId) throw new StandingAutopayError("LEAGUE_PROVIDER_LOCATION_CHANGED", "The payment provider location changed; retry consent setup", 409);
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_CONSENT, key: input.request.commandKey, fingerprint: commandFingerprint });
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, [input.payerBowlerId, ...partnerIds]))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "Every standing payer must be an active league member", 403);
    const links = partnerIds.length === 0 ? [] : await tx.select().from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(...partnerIds.map((id) => or(and(eq(bowlerPaymentLinks.bowlerAId, input.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, id)), and(eq(bowlerPaymentLinks.bowlerAId, id), eq(bowlerPaymentLinks.bowlerBId, input.payerBowlerId))))))).for("update");
    if (links.length !== partnerIds.length) throw new StandingAutopayError("PARTNER_AUTHORIZATION_REQUIRED", "Every selected partner must have an accepted same-tenant payment link", 403);
    const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS activated_at`);
    const activatedAt = (timestampResult.rows[0] as { activated_at?: string } | undefined)?.activated_at;
    if (!activatedAt) throw new StandingAutopayError("CONSENT_TIME_UNAVAILABLE", "The standing consent could not establish its activation boundary", 503);
    const consentFingerprint = digest(CONSENT_FP_PREFIX, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, paymentMode: "weekly", providerName, providerLocationId, sourceId: input.request.sourceId, customerId, activatedAt, partners: links.map((link) => ({ bowlerAId: link.bowlerAId, bowlerBId: link.bowlerBId, id: link.id, fingerprint: linkFingerprint(link) })) });
    const [existing] = await tx.select().from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId), eq(autopayConsents.state, "active"))).limit(1).for("update");
    const nextVersion = (await tx.select({ max: sql<number>`COALESCE(MAX(${autopayConsents.consentVersion}), 0)` }).from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId))))[0]?.max ?? 0;
    const replacementRevokedAt = new Date(activatedAt).toISOString();
    if (existing) await revokeConsentAndStopOperationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consent: existing, revokedAt: replacementRevokedAt });
    const [consent] = await tx.insert(autopayConsents).values({
      organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, consentVersion: Number(nextVersion) + 1, state: "active", paymentMode: "weekly", consentFingerprint,
      providerName, providerLocationId, encryptedSourceId: encrypt(input.request.sourceId), encryptedCustomerId: encrypt(customerId), createdByUserId: input.actorUserId, activatedAt,
    }).returning();
    if (!consent) throw new StandingAutopayError("CONSENT_WRITE_FAILED", "The standing consent could not be saved", 500);
    if (links.length > 0) await tx.insert(autopayConsentPartners).values(links.map((link) => ({ organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId: link.bowlerAId === input.payerBowlerId ? link.bowlerBId : link.bowlerAId, paymentLinkId: link.id, linkFingerprint: linkFingerprint(link) })));
    const result = consentWire(consent, partnerIds, input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CONSENT, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function revokeStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayRevokeRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const fingerprint = digest("lvstandingrevoke:v1:", { leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_REVOKE, key: input.request.commandKey, fingerprint });
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    const revokedAt = new Date().toISOString();
    const revokedConsent = consent ? await revokeConsentAndStopOperationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consent, revokedAt }) : undefined;
    const result = consentWire(revokedConsent, [], input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_REVOKE, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function quoteStandingAutopay(input: { organizationId: number; leagueId: number; payerBowlerId: number }): Promise<StandingAutopayQuoteWire> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const league = await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    if (!consent) throw new StandingAutopayError("CONSENT_NOT_ACTIVE", "Standing automatic payments are not active", 404);
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId });
    const payerIds = [input.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "The standing payer is not an active league member", 403);
    const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (timestampResult.rows[0] as { as_of?: string } | undefined)?.as_of;
    if (!asOf) throw new StandingAutopayError("QUOTE_TIME_UNAVAILABLE", "The standing quote could not establish a database timestamp", 503);
    const activationAt = new Date(consent.activatedAt).toISOString();
    const [next] = await tx.select({ dueAt: paymentObligations.dueAt }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
      eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id), eq(occurrencePaymentResponsibilities.organizationId, input.organizationId), eq(occurrencePaymentResponsibilities.leagueId, input.leagueId), eq(occurrencePaymentResponsibilities.state, "active"),
    )).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.payerBowlerId, payerIds), inArray(paymentObligations.state, ["open", "partially_settled"] as const), gte(paymentObligations.dueAt, activationAt), gte(paymentObligations.dueAt, new Date(asOf).toISOString()), sql`NOT EXISTS (
      SELECT 1
        FROM canonical_collection_group_members paired_member
        INNER JOIN canonical_collection_groups paired_group
          ON paired_group.id = paired_member.group_id
         AND paired_group.organization_id = paired_member.organization_id
         AND paired_group.league_id = paired_member.league_id
       WHERE paired_member.organization_id = ${input.organizationId}
         AND paired_member.league_id = ${input.leagueId}
         AND paired_member.occurrence_id = ${paymentObligations.occurrenceId}
         AND paired_member.role = 'paired'
         AND paired_member.active = true
         AND paired_group.state = 'published'
    )`)).orderBy(asc(paymentObligations.dueAt)).limit(1);
    const cutoffAt = next?.dueAt ?? null;
    if (cutoffAt) await assertNoStandingArrears(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt: new Date(cutoffAt).toISOString() });
    const group = cutoffAt ? await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt }) : { mode: "weekly" as const, groupId: null, groupRevision: null, groupFingerprint: null, triggerOccurrenceId: "", triggerOccurrenceRevision: 0, pairedOccurrenceId: null, triggerMemberId: null, pairedMemberId: null, occurrenceIds: [] };
    if (group.suppressed) {
      return { contractVersion: "standing-autopay-quote/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt: null, collectionMode: null, amountMinor: 0, obligations: [], fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, suppressedOccurrenceId: group.triggerOccurrenceId }) };
    }
    const triggerRows = cutoffAt ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "exact", occurrenceIds: [group.triggerOccurrenceId] }) : [];
    const pairedRows = cutoffAt && group.mode === "double_pay" && group.pairedOccurrenceId ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "paired", occurrenceIds: [group.pairedOccurrenceId] }) : [];
    const rows = [...triggerRows, ...pairedRows];
    if (group.mode === "double_pay" && group.occurrenceIds.some((occurrenceId) => payerIds.some((payerBowlerId) => !rows.some((row) => row.obligation.occurrenceId === occurrenceId && row.obligation.payerBowlerId === payerBowlerId)))) throw new StandingAutopayError("DOUBLE_PAY_INCOMPLETE", "The complete double-pay group is not eligible at its trigger cutoff", 409);
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const result = { contractVersion: "standing-autopay-quote/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, collectionMode: rows.length ? group.mode : null, amountMinor, obligations: rows.map((row) => ({ obligationId: row.obligation.id, occurrenceId: row.obligation.occurrenceId, payerBowlerId: row.obligation.payerBowlerId, amountMinor: row.obligation.amountMinor, outstandingMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, collectionGroupId: group.groupId })), fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, groupId: group.groupId, rows: rows.map((row) => [row.obligation.id, row.outstandingMinor]) }) };
    void league;
    return result;
  });
}

export async function prepareStandingAutopayCutoff(input: { organizationId: number; leagueId: number; consentId: string; cutoffAt: string | Date; now?: Date }): Promise<PaymentOperation | undefined> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return undefined;
  const cutoffAt = iso(input.cutoffAt);
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: input.consentId });
    if (!consent) return undefined;
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    const payerIds = [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "A standing payer is no longer active in the league", 409);
    const activationAt = new Date(consent.activatedAt).toISOString();
    const group = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt });
    await assertNoStandingArrears(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt });
    if (group.suppressed) {
      const key = `${consent.id}:${consent.consentVersion}:${cutoffAt}:${group.triggerOccurrenceRevision}`;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, blocked: "paired_occurrence_requires_trigger", pairedOccurrenceId: group.triggerOccurrenceId, pairedMemberId: group.pairedMemberId });
      const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "blocked", reason: "paired_occurrence_requires_trigger", cutoffAt, consentId: consent.id, pairedOccurrenceId: group.triggerOccurrenceId } });
      return undefined;
    }
    // A refund provider outcome is not a balance decision. While it is still
    // unresolved, keep only this exact payer/week out of standing dispatch;
    // a failed/canceled refund becomes discoverable again automatically.
    if ((await pendingRefundPayerWeekKeys(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerIds: payerIds,
      occurrenceIds: group.occurrenceIds,
    })).size > 0) return undefined;
    const triggerRows = await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "exact", occurrenceIds: [group.triggerOccurrenceId] });
    const pairedRows = group.mode === "double_pay" && group.pairedOccurrenceId ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "paired", occurrenceIds: [group.pairedOccurrenceId] }) : [];
    const rows = [...triggerRows, ...pairedRows];
    const commandKey = `${consent.id}:${consent.consentVersion}:${cutoffAt}:${group.triggerOccurrenceRevision}`;
    if (await hasOpenReservedObligations(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: group.mode === "double_pay" ? "paired" : "exact", occurrenceIds: group.occurrenceIds })) {
      const [decided] = await tx.select().from(financialCommands).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_CUTOFF),
        eq(financialCommands.idempotencyKey, commandKey),
      )).limit(1).for("share");
      if (decided?.state === "applied" && decided.result && typeof decided.result === "object" && "operationId" in decided.result && typeof decided.result.operationId === "string") {
        const [replayed] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.id, decided.result.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("share");
        return replayed;
      }
      return undefined;
    }
    const doublePayIncomplete = group.mode === "double_pay" && group.occurrenceIds.some((occurrenceId) => payerIds.some((payerBowlerId) => !rows.some((row) => row.obligation.occurrenceId === occurrenceId && row.obligation.payerBowlerId === payerBowlerId)));
    if (doublePayIncomplete) {
      const key = commandKey;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, blocked: "double_pay_incomplete", groupId: group.groupId });
      const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "blocked", reason: "double_pay_incomplete", cutoffAt, consentId: consent.id } });
      return undefined;
    }
    if (rows.length === 0) {
      const key = commandKey;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, empty: true });
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!user) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      // A replay of a successful cutoff sees its rows reserved and therefore
      // has no eligible rows on the second pass. Return the exact durable
      // operation instead of comparing the replay against the empty/no-op
      // fingerprint.
      const [existingCutoff] = await tx.select().from(financialCommands).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_CUTOFF),
        eq(financialCommands.idempotencyKey, key),
      )).limit(1).for("share");
      if (existingCutoff?.state === "applied" && existingCutoff.result && typeof existingCutoff.result === "object") {
        const replay = existingCutoff.result as { operationId?: unknown };
        if (existingCutoff.actorUserId !== user.id) throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
        if (typeof replay.operationId === "string") {
          const [replayedOperation] = await tx.select().from(paymentOperations).where(and(
            eq(paymentOperations.organizationId, input.organizationId),
            eq(paymentOperations.leagueId, input.leagueId),
            eq(paymentOperations.id, replay.operationId),
            eq(paymentOperations.operationType, "standing_autopay_charge"),
          )).limit(1).for("share");
          return replayedOperation;
        }
        return undefined;
      }
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: user.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "no_op", cutoffAt, consentId: consent.id } });
      return undefined;
    }
    const now = input.now ?? new Date();
    const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
    if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    // Keep the durable target within the ledger's 128-byte identity limit
    // while retaining every group identity component in the fingerprint. A
    // raw UUID + collection fingerprint tuple would exceed that limit.
    const groupIdentity = digest("lvstandinggroup:v1:", {
      groupId: group.groupId,
      triggerOccurrenceId: group.triggerOccurrenceId,
      pairedOccurrenceId: group.pairedOccurrenceId,
      groupRevision: group.groupRevision,
      groupFingerprint: group.groupFingerprint,
    });
    const targetIdentity = digest("lvstandingtarget:v1:", {
      consentId: consent.id,
      consentVersion: consent.consentVersion,
      cutoffAt,
      triggerOccurrenceId: group.triggerOccurrenceId,
      groupIdentity,
    });
    // Keep the durable ledger key below its 128-byte limit even for maximum
    // tenant/league/bowler identifiers. The digest commits the tenant, league,
    // payer, cutoff, consent version, and exact collection-group identity.
    // Keep the occurrence revision as a readable final component so wake
    // discovery can distinguish an old canceled decision from a restored
    // occurrence without reimplementing the application digest in SQL.
    const targetKey = `standing-autopay:${targetIdentity}:${group.triggerOccurrenceRevision}`;
    const identity = buildPaymentOperationIdentity({ organizationId: input.organizationId, operationType: "standing_autopay_charge", targetKey, amountMinor, currency: "USD", providerName: consent.providerName ?? "square" });
    const evidenceFingerprint = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, mode: group.mode, groupId: group.groupId, groupOccurrenceIds: group.occurrenceIds, obligations: rows.map((row) => ({ id: row.obligation.id, responsibilityId: row.obligation.responsibilityId, responsibilityVersion: row.responsibilityVersion, occurrenceId: row.obligation.occurrenceId, amountMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, payerBowlerId: row.obligation.payerBowlerId })), partners: partners.map((row) => ({ partnerBowlerId: row.partnerBowlerId, paymentLinkId: row.paymentLinkId, linkFingerprint: row.linkFingerprint })) });
    try {
      await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key: commandKey, fingerprint: evidenceFingerprint });
    } catch (error) {
      if (!(error instanceof StandingAutopayReplay)) throw error;
      const replay = error.result as { operationId?: unknown };
      if (typeof replay.operationId !== "string") return undefined;
      const [replayed] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.id, replay.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("share");
      return replayed;
    }
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.targetKey, targetKey), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("update");
    if (existing) { await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: existing.id, status: existing.status, cutoffAt } }); return existing; }
    const [operation] = await tx.insert(paymentOperations).values({
      organizationId: input.organizationId, authorizingUserId: payerUser.id, operationType: "standing_autopay_charge", targetKey, triggerOccurrenceId: group.triggerOccurrenceId, leagueId: input.leagueId, amountMinor, currency: "USD", requestFingerprint: identity.requestFingerprint, providerIdempotencyKey: identity.providerIdempotencyKey, providerName: consent.providerName ?? "square", status: "pending", nextAttemptAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), attemptCount: 0,
    }).returning();
    if (!operation) throw new StandingAutopayError("OPERATION_WRITE_FAILED", "The standing payment operation could not be created", 500);
    const snapshotRows = rows.map((row, index) => ({ allocationIndex: index, obligationId: row.obligation.id, amountMinor: row.outstandingMinor, occurrenceId: row.obligation.occurrenceId, responsibilityId: row.obligation.responsibilityId, responsibilityVersion: row.responsibilityVersion, payerBowlerId: row.obligation.payerBowlerId, dueAt: row.obligation.dueAt }));
    await tx.insert(paymentOperationRosterSnapshots).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, snapshotVersion: 2, snapshotKind: "standing_autopay", collectionMode: group.mode, cutoffAt, amountMinor, currency: "USD", obligations: snapshotRows, snapshotFingerprint: evidenceFingerprint });
    await tx.insert(paymentOperationStandingAutopayBindings).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, providerName: consent.providerName ?? "square", providerLocationId: consent.providerLocationId ?? "", triggerOccurrenceId: group.triggerOccurrenceId, pairedOccurrenceId: group.pairedOccurrenceId, collectionGroupId: group.groupId, collectionGroupRevision: group.groupRevision, collectionGroupFingerprint: group.groupFingerprint, triggerMemberId: group.triggerMemberId, pairedMemberId: group.pairedMemberId, cutoffAt, collectionMode: group.mode, evidenceFingerprint });
    await tx.insert(paymentOperationRosterSnapshotItems).values(snapshotRows.map((row) => ({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: row.obligationId, allocationIndex: row.allocationIndex, amountMinor: row.amountMinor, state: "reserved" as const })));
    await tx.insert(paymentOperationStandingAutopayParticipants).values(snapshotRows.map((row) => {
      const partner = partners.find((candidate) => candidate.partnerBowlerId === row.payerBowlerId);
      return { operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, allocationIndex: row.allocationIndex, obligationId: row.obligationId, bowlerId: row.payerBowlerId, role: partner ? "partner" as const : "payer" as const, paymentLinkId: partner?.paymentLinkId ?? null, linkFingerprint: partner?.linkFingerprint ?? null, consentVersion: consent.consentVersion };
    }));
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: operation.id, status: operation.status, cutoffAt, amountMinor } });
    return operation;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function getStandingAutopayExecutionSnapshot(input: { organizationId: number; operationId: string }) {
  const [row] = await db.select({ operation: paymentOperations, binding: paymentOperationStandingAutopayBindings, snapshot: paymentOperationRosterSnapshots, consent: autopayConsents, locationId: leagues.locationId }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, and(eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id), eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId))).innerJoin(paymentOperationRosterSnapshots, and(eq(paymentOperationRosterSnapshots.operationId, paymentOperations.id), eq(paymentOperationRosterSnapshots.organizationId, input.organizationId))).innerJoin(autopayConsents, and(eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId), eq(autopayConsents.organizationId, input.organizationId))).innerJoin(leagues, and(eq(leagues.id, paymentOperations.leagueId), eq(leagues.organizationId, input.organizationId))).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1);
  if (!row) return undefined;
  const items = await db.select({ item: paymentOperationRosterSnapshotItems, obligation: paymentObligations }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId), eq(paymentObligations.organizationId, input.organizationId))).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.operationId, input.operationId))).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
  return { ...row, items, sourceId: decrypt(row.consent.encryptedSourceId ?? ""), customerId: decrypt(row.consent.encryptedCustomerId ?? "") };
}

export async function standingPaymentRows(input: { organizationId: number; operationId: string; providerPaymentId: string; providerName: string; actorUserId: number | null; receiptUrl?: string | null; receiptNumber?: string | null }) {
  const snapshot = await getStandingAutopayExecutionSnapshot(input);
  if (!snapshot) throw new StandingAutopayError("SNAPSHOT_NOT_FOUND", "The standing operation snapshot is unavailable", 409);
  const first = snapshot.items[0];
  if (!first) return [];
  return [{ allocationIndex: 0, values: { organizationId: input.organizationId, bowlerId: snapshot.consent.payerBowlerId, leagueId: snapshot.operation.leagueId ?? snapshot.binding.leagueId, amount: snapshot.operation.amountMinor, status: "paid" as const, type: snapshot.operation.providerName === "square" ? "square" as const : "credit_card" as const, providerPaymentId: input.providerPaymentId, receiptUrl: input.receiptUrl ?? undefined, receiptNumber: input.receiptNumber ?? undefined, receiptEmailMissing: false, paidByUserId: input.actorUserId, notes: "Roster standing automatic payment" } }];
}

/**
 * Recheck the whole payer/week hold immediately before standing provider I/O.
 * A still-owed refund can have its source component settled by a later manual
 * repayment while a sibling component remains unpaid; therefore the marker
 * must be resolved across every obligation for that exact payer and
 * occurrence, not from the reserved snapshot rows alone.
 */
async function validateStandingRefundHoldsForDispatchInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; operationId: string },
): Promise<void> {
  const snapshotRows = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId })
    .from(paymentOperationRosterSnapshotItems)
    .where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.operationId, input.operationId),
    ));
  if (snapshotRows.length === 0) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is unavailable");
  const reservedObligations = await tx.select({ payerBowlerId: paymentObligations.payerBowlerId, occurrenceId: paymentObligations.occurrenceId })
    .from(paymentObligations)
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, snapshotRows.map((row) => row.obligationId)),
    ));
  const payerIds = [...new Set(reservedObligations.map((row) => row.payerBowlerId))];
  const occurrenceIds = [...new Set(reservedObligations.map((row) => row.occurrenceId))];
  if (payerIds.length === 0 || occurrenceIds.length === 0) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot references no obligations");
  if ((await pendingRefundPayerWeekKeys(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerIds: payerIds,
    occurrenceIds,
  })).size > 0) {
    throw new StandingAutopayError("REFUND_OUTCOME_UNRESOLVED", "Standing automatic payment is blocked until the affected refund provider outcome is resolved", 409);
  }
  const allObligations = await tx.select({ obligation: paymentObligations }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, payerIds),
    inArray(paymentObligations.occurrenceId, occurrenceIds),
  ));
  const allObligationIds = allObligations.map((row) => row.obligation.id);
  const allocations = allObligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor })
    .from(paymentAllocations)
    .where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, allObligationIds),
    ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition })
    .from(refundAllocationAdjustments)
    .where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
    ));
  const adjustmentsByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentsByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  const totalOutstandingByKey = new Map<string, number>();
  const heldKeys = new Set<string>();
  for (const row of allObligations) {
    const key = `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`;
    const rowAdjustments = adjustmentsByObligationId.get(row.obligation.id) ?? [];
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: rowAdjustments,
    });
    totalOutstandingByKey.set(key, (totalOutstandingByKey.get(key) ?? 0) + balance.outstandingMinor);
    if (rowAdjustments.some((adjustment) => adjustment.disposition === "still_owed")) heldKeys.add(key);
  }
  for (const key of heldKeys) {
    if ((totalOutstandingByKey.get(key) ?? 0) > 0) {
      throw new StandingAutopayError("REFUND_STILL_OWED_MANUAL", "Standing automatic payment is blocked until the still-owed refund week is settled by a one-time payment", 409);
    }
  }
}

export async function validateStandingConsentForDispatchInTransaction(tx: StandingTx, input: { organizationId: number; leagueId: number; operationId: string; leagueIdAlreadyLocked?: boolean }) {
    if (!input.leagueIdAlreadyLocked) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [binding] = await tx.select().from(paymentOperationStandingAutopayBindings).where(and(eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId), eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId), eq(paymentOperationStandingAutopayBindings.operationId, input.operationId))).limit(1).for("update");
    if (!binding) throw new StandingAutopayError("STANDING_BINDING_MISSING", "The standing operation binding is unavailable");
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: binding.consentId });
    if (!consent || consent.consentVersion !== binding.consentVersion) throw new StandingAutopayError("CONSENT_REVOKED", "Standing consent changed before dispatch");
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)]))) throw new StandingAutopayError("PARTICIPANT_INACTIVE", "A standing payer is no longer active");
    const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId), eq(paymentOperationRosterSnapshots.operationId, input.operationId), eq(paymentOperationRosterSnapshots.snapshotKind, "standing_autopay"))).limit(1).for("share");
    if (!snapshot || snapshot.snapshotFingerprint !== binding.evidenceFingerprint) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is invalid");
    if (!await validateRosterSnapshotForDispatchInTransaction(tx, input)) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is unavailable");
    await validateStandingRefundHoldsForDispatchInTransaction(tx, input);
    return true;
}

export async function validateStandingConsentForDispatch(input: { organizationId: number; leagueId: number; operationId: string }) {
  return db.transaction((tx) => validateStandingConsentForDispatchInTransaction(tx, input));
}
