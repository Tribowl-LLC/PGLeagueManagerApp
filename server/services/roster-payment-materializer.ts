import { and, asc, desc, eq, inArray, isNotNull, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagueOccurrenceRevisions,
  leagues,
  autopayConsentPartners,
  autopayConsents,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentObligationOwnerRevisions,
  paymentAllocations,
  refundAllocationAdjustments,
  paymentDisputes,
  paymentVoids,
  payments,
  refundPaymentOperationSnapshots,
  rotatingCreditRefunds,
  paymentOperationRosterSnapshotItems,
  paymentOperationStandingAutopayBindings,
  paymentOperations,
  rotatingOccurrenceAssignments,
  teamPaymentPolicies,
  teamPaymentSlots,
  teams,
  type TeamPaymentPolicy,
} from "@shared/schema";
import type * as schema from "@shared/schema";
import { calculateRosterPaymentTiming } from "@shared/roster-payment-contract";
import { appendTeamPaymentObligationOwnerInTransaction, resolvePaymentObligationOwnersInTransaction } from "./roster-obligation-owners.js";

type PaymentOperationTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

/**
 * Return the authoritative timing for a roster obligation. Weekly leagues
 * use the occurrence start and the versioned three-hour grace. Upfront
 * leagues deliberately share one due instant: the first roster materializing
 * transaction records its PostgreSQL transaction timestamp in every created
 * obligation, and later occurrences derive that same instant from the
 * existing upfront evidence. This keeps upfront timing automatic without
 * recreating a financial activation entity or UI.
 */
export async function deriveRosterPaymentTimingInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; paymentMode: "weekly" | "upfront"; occurrenceStartAt: string },
): Promise<{ dueAt: string; pastDueAt: string }> {
  const occurrenceStart = new Date(input.occurrenceStartAt);
  if (!Number.isFinite(occurrenceStart.getTime())) throw new Error("INVALID_OCCURRENCE_START");
  if (input.paymentMode === "weekly") {
    return calculateRosterPaymentTiming(occurrenceStart);
  }

  // `past_due_at = due_at` identifies the clean-slate upfront timing without
  // consulting any retired activation table. Include voided rows so a safe
  // responsibility correction cannot silently move the league's season due
  // instant after immutable evidence was written.
  const [existing] = await tx.select({ dueAt: paymentObligations.dueAt })
    .from(paymentObligations)
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      sql`${paymentObligations.pastDueAt} = ${paymentObligations.dueAt}`,
    ))
    .orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.id))
    .limit(1)
    .for("share");
  if (existing?.dueAt) {
    const dueAt = new Date(existing.dueAt).toISOString();
    return { dueAt, pastDueAt: dueAt };
  }

  // A repairable upfront default can temporarily have no obligation row. Keep
  // the league's established due instant from its responsibility history so
  // the missing row is repaired in place instead of versioning the
  // responsibility against a fresh transaction timestamp. The same equality
  // discriminator excludes weekly grace-timed responsibilities.
  const [existingResponsibility] = await tx.select({ dueAt: occurrencePaymentResponsibilities.dueAt })
    .from(occurrencePaymentResponsibilities)
    .where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      sql`${occurrencePaymentResponsibilities.pastDueAt} = ${occurrencePaymentResponsibilities.dueAt}`,
    ))
    .orderBy(asc(occurrencePaymentResponsibilities.dueAt), asc(occurrencePaymentResponsibilities.id))
    .limit(1)
    .for("share");
  if (existingResponsibility?.dueAt) {
    const dueAt = new Date(existingResponsibility.dueAt).toISOString();
    return { dueAt, pastDueAt: dueAt };
  }

  const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS upfront_due_at`);
  const timestamp = (timestampResult.rows[0] as { upfront_due_at?: string } | undefined)?.upfront_due_at;
  if (!timestamp) throw new Error("UPFRONT_DUE_TIMESTAMP_UNAVAILABLE");
  const dueAt = new Date(timestamp).toISOString();
  return { dueAt, pastDueAt: dueAt };
}

/** Revoke standing consent and fence its pending work when a payer or
 * accepted partner leaves the league. This primitive is deliberately DB-only
 * so bowler/membership lifecycle writes can call it under the league lock. */
export async function revokeStandingAutopayForBowlerInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; bowlerId: number; now?: string; includePartner?: boolean },
): Promise<void> {
  const revokedAt = input.now ?? new Date().toISOString();
  const consents = await tx.select({ consent: autopayConsents }).from(autopayConsents).where(and(
    eq(autopayConsents.organizationId, input.organizationId),
    eq(autopayConsents.leagueId, input.leagueId),
    input.includePartner === false
      ? eq(autopayConsents.payerBowlerId, input.bowlerId)
      : or(
        eq(autopayConsents.payerBowlerId, input.bowlerId),
        sql`EXISTS (SELECT 1 FROM autopay_consent_partners cp WHERE cp.consent_id = ${autopayConsents.id} AND cp.organization_id = ${input.organizationId} AND cp.league_id = ${input.leagueId} AND cp.partner_bowler_id = ${input.bowlerId})`,
      ),
  )).orderBy(asc(autopayConsents.id)).for("update");
  for (const { consent } of consents) {
    const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, and(
      eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id),
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
      eq(paymentOperationStandingAutopayBindings.consentId, consent.id),
      eq(paymentOperationStandingAutopayBindings.consentVersion, consent.consentVersion),
    )).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "standing_autopay_charge"),
    )).orderBy(asc(paymentOperations.id)).for("update");
    for (const { operation } of operations) {
      if (["pending", "leased", "retry_scheduled"].includes(operation.status) && operation.dispatchClaimedAt === null && operation.providerObjectId === null) {
        await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
          eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
          eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
          eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        ));
        await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, dispatchClaimedAt: null, completedAt: revokedAt, updatedAt: revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
      } else if (["pending", "leased", "retry_scheduled", "provider_unknown"].includes(operation.status) && (operation.dispatchClaimedAt !== null || operation.providerObjectId !== null)) {
        await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "PARTICIPANT_INACTIVE_AFTER_DISPATCH", updatedAt: revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
      }
    }
    await tx.update(autopayConsents).set({ state: "revoked", revokedAt }).where(and(eq(autopayConsents.id, consent.id), eq(autopayConsents.state, "active")));
  }
}

export async function assertOpenRosterEvidenceCanBeReplaced(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
  responsibilityId: string,
  existingObligations?: Array<typeof paymentObligations.$inferSelect>,
): Promise<Array<typeof paymentObligations.$inferSelect>> {
  const obligations = existingObligations ?? await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    eq(paymentObligations.responsibilityId, responsibilityId),
  )).for("update");
  await assertOpenRosterEvidenceCanBeReplacedForIds(tx, input, obligations);
  return obligations;
}

/**
 * Check all replacement evidence in one locked read set. Schedule edits can
 * touch hundreds of roster responsibilities, so the single-responsibility
 * guard above delegates here rather than multiplying identical allocation,
 * snapshot, and provider-operation queries.
 */
async function assertOpenRosterEvidenceCanBeReplacedForIds(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
  obligations: readonly (typeof paymentObligations.$inferSelect)[],
): Promise<void> {
  if (obligations.some((row) => row.state !== "open")) throw new Error("PAID_EVIDENCE_LOCKED");
  const obligationIds = obligations.map((row) => row.id);
  if (obligationIds.length === 0) return;

  const allocations = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    inArray(paymentAllocations.obligationId, obligationIds),
    eq(paymentAllocations.state, "active"),
  )).for("update");
  if (allocations.length > 0) throw new Error("PAID_EVIDENCE_LOCKED");

  const reservedEvidence = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
    inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"] as const),
  )).for("update");
  if (reservedEvidence.length > 0) throw new Error("RESERVED_EVIDENCE_LOCKED");

  // A provider-bound operation is immutable evidence even if its snapshot
  // item was not left in the live reserved state. This keeps roster changes
  // fail-closed around dispatch races and unknown provider outcomes.
  const providerEvidence = await tx.select({ id: paymentOperations.id }).from(paymentOperationRosterSnapshotItems)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, paymentOperationRosterSnapshotItems.operationId),
      eq(paymentOperations.organizationId, paymentOperationRosterSnapshotItems.organizationId),
      eq(paymentOperations.leagueId, paymentOperationRosterSnapshotItems.leagueId),
    )).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
      or(
        isNotNull(paymentOperations.providerObjectId),
        isNotNull(paymentOperations.dispatchClaimedAt),
        eq(paymentOperations.status, "provider_unknown"),
      ),
    )).for("update");
  if (providerEvidence.length > 0) throw new Error("RESERVED_EVIDENCE_LOCKED");
}

/** Owner conversion preserves paid allocations, but unresolved provider or
 * review evidence cannot safely change ownership while an outcome is unknown. */
async function assertRotatingOwnerConversionEvidenceClear(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
  obligations: readonly (typeof paymentObligations.$inferSelect)[],
): Promise<void> {
  const eligibleIds = obligations
    .filter((row) => row.state === "open" || row.state === "partially_settled")
    .map((row) => row.id);
  if (eligibleIds.length === 0) return;
  const allocations = await tx.select({ id: paymentAllocations.id, paymentId: paymentAllocations.paymentId, state: paymentAllocations.state, reviewRequired: paymentAllocations.reviewRequired })
    .from(paymentAllocations)
    .where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(paymentAllocations.obligationId, eligibleIds),
    )).for("update");
  if (allocations.some((allocation) => allocation.reviewRequired || allocation.state !== "active")) throw new Error("ROTATING_OWNER_REVIEW_REQUIRED");
  const allocationIds = allocations.map((allocation) => allocation.id);
  const refundAdjustments = allocationIds.length === 0 ? [] : await tx.select({ id: refundAllocationAdjustments.id }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId),
    eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocationIds),
  )).for("update");
  if (refundAdjustments.length > 0) throw new Error("ROTATING_OWNER_REFUND_EVIDENCE_PRESENT");

  const reserved = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems)
    .where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
      inArray(paymentOperationRosterSnapshotItems.obligationId, eligibleIds),
    )).for("update");
  if (reserved.length > 0) throw new Error("RESERVED_EVIDENCE_LOCKED");

  const unresolvedRosterOperations = await tx.select({ id: paymentOperations.id }).from(paymentOperationRosterSnapshotItems)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, paymentOperationRosterSnapshotItems.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, eligibleIds),
      inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "action_required", "reconciliation_required"] as const),
    )).for("update");
  if (unresolvedRosterOperations.length > 0) throw new Error("RESERVED_EVIDENCE_LOCKED");

  const paymentIds = [...new Set(allocations.map((allocation) => allocation.paymentId))];
  if (paymentIds.length === 0) return;
  const paymentRows = await tx.select({ id: payments.id, operationId: payments.paymentOperationId, disputeId: payments.disputeId, disputedAt: payments.disputedAt, status: payments.status, refundedAt: payments.refundedAt, squareRefundId: payments.squareRefundId })
    .from(payments).where(and(
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
      inArray(payments.id, paymentIds),
    )).for("update");
  if (paymentRows.length !== paymentIds.length || paymentRows.some((payment) => payment.disputeId !== null || payment.disputedAt !== null || payment.status !== "paid" || payment.refundedAt !== null || payment.squareRefundId !== null)) {
    throw new Error("ROTATING_OWNER_REVIEW_REQUIRED");
  }
  const [voidEvidence, creditRefundEvidence] = await Promise.all([
    tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, input.organizationId),
      eq(paymentVoids.leagueId, input.leagueId),
      inArray(paymentVoids.paymentId, paymentIds),
    )).limit(1).for("update"),
    tx.select({ id: rotatingCreditRefunds.id }).from(rotatingCreditRefunds).where(and(
      eq(rotatingCreditRefunds.organizationId, input.organizationId),
      eq(rotatingCreditRefunds.leagueId, input.leagueId),
      inArray(rotatingCreditRefunds.paymentId, paymentIds),
    )).limit(1).for("update"),
  ]);
  if (voidEvidence.length > 0 || creditRefundEvidence.length > 0) throw new Error("ROTATING_OWNER_REFUND_EVIDENCE_PRESENT");
  const paymentOperationIds = [...new Set(paymentRows.flatMap((payment) => payment.operationId ? [payment.operationId] : []))];
  const unresolvedPayments = paymentOperationIds.length === 0 ? [] : await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    inArray(paymentOperations.id, paymentOperationIds),
    inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "action_required", "reconciliation_required"] as const),
  )).for("update");
  const unresolvedRefunds = await tx.select({ id: paymentOperations.id }).from(refundPaymentOperationSnapshots)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).where(and(
      eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
      inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
    )).for("update");
  if (unresolvedRefunds.length > 0) throw new Error("ROTATING_OWNER_REFUND_EVIDENCE_PRESENT");
  const disputeEvidence = paymentOperationIds.length === 0 ? [] : await tx.select({ id: paymentDisputes.id }).from(paymentDisputes).where(and(
    eq(paymentDisputes.organizationId, input.organizationId),
    inArray(paymentDisputes.paymentOperationId, paymentOperationIds),
  )).for("update");
  if (unresolvedPayments.length > 0 || unresolvedRefunds.length > 0 || disputeEvidence.length > 0) {
    throw new Error("ROTATING_OWNER_REVIEW_REQUIRED");
  }
}

type MaterializeRosterOccurrencesInput = {
  organizationId: number;
  leagueId: number;
  occurrenceIds: readonly string[];
  actorUserId: number;
  teamId?: number;
  /**
   * Schedule edits reschedule every current responsibility and retain its
   * resolved payer/component facts. Roster saves replace only open default
   * evidence and leave explicit substitute/split overrides authoritative.
   */
  mode?: "reschedule" | "roster";
};

type RosterMaterializationPlan = {
  occurrence: typeof leagueOccurrences.$inferSelect;
  team: typeof teams.$inferSelect;
  slot: typeof teamPaymentSlots.$inferSelect;
  current: typeof occurrencePaymentResponsibilities.$inferSelect | undefined;
  currentObligations: Array<typeof paymentObligations.$inferSelect>;
  kind: "main" | "vacant" | "rotating" | null;
  mainBowlerId: number | null;
  payerBowlerId: number | null;
  policy: TeamPaymentPolicy;
  dueAt: string;
  pastDueAt: string;
  action: "none" | "void" | "create" | "repair" | "reschedule";
};

function materializationSlotKey(occurrenceId: string, teamId: number, slotIndex: number, positionIndex: number): string {
  return `${occurrenceId}:${teamId}:${slotIndex}:${positionIndex}`;
}

function materializationVersionKey(plan: RosterMaterializationPlan, version: number): string {
  return materializationSlotKey(plan.occurrence.id, plan.team.id, plan.slot.slotIndex, plan.slot.slotIndex) + `:${version}`;
}

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime === rightTime
    : left === right;
}

function sameCanonicalPlacementFromSnapshot(snapshot: unknown, occurrence: typeof leagueOccurrences.$inferSelect): boolean {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const previous = snapshot as Record<string, unknown>;
  return previous.authoritativeLocalDate === occurrence.authoritativeLocalDate
    && previous.authoritativeLocalStartTime === occurrence.authoritativeLocalStartTime
    && previous.timezone === occurrence.timezone
    && typeof previous.startAt === "string"
    && sameInstant(previous.startAt, occurrence.startAt)
    && previous.selectedUtcOffsetMinutes === occurrence.selectedUtcOffsetMinutes
    && previous.foldResolution === occurrence.foldResolution;
}

/** Materialize a single occurrence using the shared batched primitive. */
export async function materializeRosterPaymentOccurrenceInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; occurrenceId: string; actorUserId: number; reschedule?: boolean; teamId?: number },
): Promise<boolean> {
  return materializeRosterPaymentOccurrencesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    occurrenceIds: [input.occurrenceId],
    actorUserId: input.actorUserId,
    teamId: input.teamId,
    mode: input.reschedule ? "reschedule" : "roster",
  });
}

/**
 * Reschedule one or more published occurrences under the caller's league lock.
 * Canonical schedule edits use this shared primitive with their complete update
 * set, so roster evidence is read and guarded once instead of once per
 * responsibility. Missing eligible defaults are still created, and an
 * invalidated open default is still voided, matching the single-occurrence
 * reschedule contract.
 */
export async function materializeRosterPaymentOccurrencesInTransaction(
  tx: PaymentOperationTransaction,
  input: MaterializeRosterOccurrencesInput,
): Promise<boolean> {
  const mode = input.mode ?? "reschedule";
  const occurrenceIds = [...new Set(input.occurrenceIds)];
  if (occurrenceIds.length === 0) return false;
  const [league] = await tx.select({
    payingLineupSize: leagues.payingLineupSize,
    weeklyFee: leagues.weeklyFee,
    paymentMode: leagues.paymentMode,
  }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league?.payingLineupSize) return false;
  const occurrences = await tx.select().from(leagueOccurrences).where(and(
    eq(leagueOccurrences.organizationId, input.organizationId),
    eq(leagueOccurrences.leagueId, input.leagueId),
    inArray(leagueOccurrences.id, occurrenceIds),
    inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
    inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
  )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.id));
  if (occurrences.length === 0) return false;

  const rosterTeams = await tx.select().from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true))).orderBy(asc(teams.id));
  const selectedTeams = rosterTeams.filter((team) => input.teamId === undefined || team.id === input.teamId);
  if (selectedTeams.length === 0) return false;
  const selectedTeamIds = selectedTeams.map((team) => team.id);
  const rosterRows = await tx.select().from(teamPaymentSlots).where(and(
    eq(teamPaymentSlots.organizationId, input.organizationId),
    eq(teamPaymentSlots.leagueId, input.leagueId),
    inArray(teamPaymentSlots.teamId, selectedTeamIds),
  )).orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
  const rosterRowsByTeam = new Map<number, Array<typeof teamPaymentSlots.$inferSelect>>();
  for (const row of rosterRows) {
    const rows = rosterRowsByTeam.get(row.teamId) ?? [];
    rows.push(row);
    rosterRowsByTeam.set(row.teamId, rows);
  }
  const activeMainRows = await tx.select({ bowlerId: bowlers.id, teamId: bowlerLeagues.teamId }).from(bowlers)
    .innerJoin(bowlerLeagues, and(
      eq(bowlerLeagues.bowlerId, bowlers.id),
      eq(bowlerLeagues.leagueId, input.leagueId),
      eq(bowlerLeagues.active, true),
    )).where(and(eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true)));
  const activeMainKeys = new Set(activeMainRows.map((row) => `${row.teamId}:${row.bowlerId}`));
  const policies = await tx.select().from(teamPaymentPolicies).where(and(
    eq(teamPaymentPolicies.organizationId, input.organizationId),
    eq(teamPaymentPolicies.leagueId, input.leagueId),
    inArray(teamPaymentPolicies.teamId, selectedTeamIds),
  ));
  const policiesByTeam = new Map<number, TeamPaymentPolicy>(policies.map((row) => [row.teamId, row.defaultPolicy]));

  // Current rows drive the action plan; history provides the next version/key
  // for a newly materialized slot. Lock the complete set once and in a stable
  // order so concurrent schedule writers cannot observe different versions.
  const responsibilityRows = await tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    inArray(occurrencePaymentResponsibilities.occurrenceId, occurrences.map((row) => row.id)),
    inArray(occurrencePaymentResponsibilities.teamId, selectedTeamIds),
  )).orderBy(
    asc(occurrencePaymentResponsibilities.occurrenceId),
    asc(occurrencePaymentResponsibilities.teamId),
    asc(occurrencePaymentResponsibilities.slotIndex),
    asc(occurrencePaymentResponsibilities.positionIndex),
    desc(occurrencePaymentResponsibilities.version),
    asc(occurrencePaymentResponsibilities.id),
  ).for("update");
  const currentBySlot = new Map<string, typeof occurrencePaymentResponsibilities.$inferSelect>();
  const latestBySlot = new Map<string, typeof occurrencePaymentResponsibilities.$inferSelect>();
  for (const row of responsibilityRows) {
    const key = materializationSlotKey(row.occurrenceId, row.teamId, row.slotIndex, row.positionIndex);
    if (row.state === "active" && !currentBySlot.has(key)) currentBySlot.set(key, row);
    if (!latestBySlot.has(key)) latestBySlot.set(key, row);
  }
  const currentRows = [...currentBySlot.values()];
  const currentIds = currentRows.map((row) => row.id);
  const obligations = currentIds.length === 0 ? [] : await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, currentIds),
  )).orderBy(asc(paymentObligations.responsibilityId), asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.id)).for("update");
  const obligationsByResponsibility = new Map<string, Array<typeof paymentObligations.$inferSelect>>();
  for (const obligation of obligations) {
    const rows = obligationsByResponsibility.get(obligation.responsibilityId) ?? [];
    rows.push(obligation);
    obligationsByResponsibility.set(obligation.responsibilityId, rows);
  }
  const currentOwners = await resolvePaymentObligationOwnersInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    obligations,
  });
  const teamOwnedOpenResponsibilityIds = new Set(obligations.flatMap((obligation) => {
    const owner = currentOwners.get(obligation.id);
    return owner?.kind === "team" && (obligation.state === "open" || obligation.state === "partially_settled")
      ? [obligation.responsibilityId]
      : [];
  }));

  const placementUnchangedByOccurrence = new Map<string, boolean>();
  if (mode === "reschedule") {
    const currentCommandIds = [...new Set(occurrences.map((row) => row.lastCommandId).filter((id): id is string => id !== null))];
    const revisions = currentCommandIds.length === 0 ? [] : await tx.select({
      occurrenceId: leagueOccurrenceRevisions.occurrenceId,
      commandId: leagueOccurrenceRevisions.commandId,
      revisionNumber: leagueOccurrenceRevisions.revisionNumber,
      beforeSnapshot: leagueOccurrenceRevisions.beforeSnapshot,
    }).from(leagueOccurrenceRevisions).where(and(
      eq(leagueOccurrenceRevisions.organizationId, input.organizationId),
      eq(leagueOccurrenceRevisions.leagueId, input.leagueId),
      inArray(leagueOccurrenceRevisions.occurrenceId, occurrences.map((row) => row.id)),
      inArray(leagueOccurrenceRevisions.commandId, currentCommandIds),
    )).for("share");
    const revisionByOccurrence = new Map(revisions.map((revision) => [
      `${revision.occurrenceId}:${revision.commandId}:${revision.revisionNumber}`,
      revision,
    ]));
    for (const occurrence of occurrences) {
      const revision = occurrence.lastCommandId === null
        ? undefined
        : revisionByOccurrence.get(`${occurrence.id}:${occurrence.lastCommandId}:${occurrence.currentRevision}`);
      const priorSnapshot = revision?.beforeSnapshot ?? null;
      placementUnchangedByOccurrence.set(occurrence.id, sameCanonicalPlacementFromSnapshot(priorSnapshot, occurrence));
    }
  }

  const timingByOccurrence = new Map<string, { dueAt: string; pastDueAt: string }>();
  if (league.paymentMode === "upfront") {
    const firstOccurrence = occurrences[0];
    if (!firstOccurrence) return false;
    const timing = await deriveRosterPaymentTimingInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentMode: league.paymentMode,
      occurrenceStartAt: firstOccurrence.startAt,
    });
    for (const occurrence of occurrences) timingByOccurrence.set(occurrence.id, timing);
  } else {
    for (const occurrence of occurrences) timingByOccurrence.set(occurrence.id, calculateRosterPaymentTiming(new Date(occurrence.startAt)));
  }

  const plans: RosterMaterializationPlan[] = [];
  for (const occurrence of occurrences) {
    const timing = timingByOccurrence.get(occurrence.id);
    if (!timing) throw new Error("ROSTER_PAYMENT_TIMING_UNAVAILABLE");
    for (const team of selectedTeams) {
      const policy = policiesByTeam.get(team.id) ?? "main_pays_full";
      for (const slot of rosterRowsByTeam.get(team.id) ?? []) {
        const kind = slot.occupant === "vacant"
          ? "vacant" as const
          : slot.occupant === "rotating"
            ? "rotating" as const
          : slot.occupant === "main" && slot.mainBowlerId !== null && activeMainKeys.has(`${team.id}:${slot.mainBowlerId}`)
            ? "main" as const
            : null;
        const mainBowlerId = kind === "main" ? slot.mainBowlerId : null;
        const payerBowlerId = mainBowlerId;
        const current = currentBySlot.get(materializationSlotKey(occurrence.id, team.id, slot.slotIndex, slot.slotIndex));
        const currentObligations = current ? obligationsByResponsibility.get(current.id) ?? [] : [];
        const currentIsOverride = current !== undefined && (current.responsibilityKind === "substitute" || current.responsibilityKind === "split");
        const unchanged = current !== undefined && !currentIsOverride && kind !== null
          && (mode === "reschedule" || !teamOwnedOpenResponsibilityIds.has(current.id))
          && (mode !== "reschedule" || placementUnchangedByOccurrence.get(occurrence.id) === true)
          && current.responsibilityKind === kind
          && current.mainBowlerId === mainBowlerId
          && current.substituteBowlerId === null
          && current.payerBowlerId === payerBowlerId
          && current.policy === policy
          && sameInstant(current.dueAt, timing.dueAt)
          && sameInstant(current.pastDueAt, timing.pastDueAt);
        const hasNonOpenEvidence = currentObligations.some((row) => row.state !== "open");
        const rotatingConversion = slot.occupant === "rotating" && current !== undefined
          && current.responsibilityKind !== "vacant";
        const fullySettledCurrent = currentObligations.length > 0 && currentObligations.every((row) => row.state === "settled");
        let action: RosterMaterializationPlan["action"] = "none";
        if (current === undefined) {
          action = kind === null ? "none" : "create";
        } else if (slot.occupant === "rotating" && current?.responsibilityKind === "vacant" && mode === "roster") {
          // A prior empty slot has no payer or money to transfer. Retire only
          // that zero-value responsibility and create a real rotating share.
          action = "reschedule";
        } else if (rotatingConversion && mode === "roster") {
          // A roster conversion changes current ownership on each existing
          // open/partial obligation in place; it must retain the historical
          // responsibility and every tender allocation attached to it.
          action = currentObligations.length === 0 ? "repair" : "none";
        } else if (rotatingConversion && mode === "reschedule") {
          // Identical canonical placement needs no responsibility version,
          // including when an owner revision makes the usual shape compare
          // differ. A real placement change proceeds only to the evidence
          // guard below; settled, assigned, or paid dates remain locked.
          action = placementUnchangedByOccurrence.get(occurrence.id) === true ? "none" : "reschedule";
        } else if (rotatingConversion && fullySettledCurrent) {
          // Closed historical dates retain their fixed-payer owner.
          action = "none";
        } else if (unchanged) {
          // A responsibility can survive a partial/manual repair without its
          // expected default obligation. Recreate only a wholly absent open
          // default obligation; never reopen or infer from settled evidence.
          action = mode === "roster"
            && (kind === "main" || kind === "rotating")
            && currentObligations.length === 0
            ? "repair"
            : "none";
        } else if (mode === "roster" && currentIsOverride) {
          // Explicit substitute/split decisions are occurrence evidence, not
          // defaults. A roster save must not rewrite them.
          action = "none";
        } else if (mode === "roster" && hasNonOpenEvidence) {
          // Settled or partially settled history is immutable. The changed
          // slot applies to later occurrences while this occurrence retains
          // its original financial evidence.
          action = "none";
        } else if (currentIsOverride || kind !== null) {
          action = "reschedule";
        } else if (!currentIsOverride) {
          action = mode === "reschedule" && hasNonOpenEvidence ? "none" : "void";
        }
        plans.push({ occurrence, team, slot, current, currentObligations, kind, mainBowlerId, payerBowlerId, policy, dueAt: timing.dueAt, pastDueAt: timing.pastDueAt, action });
      }
    }
  }

  const rotatingReschedulePlans = plans.filter((plan) => mode === "reschedule"
    && plan.action === "reschedule"
    && plan.slot.occupant === "rotating"
    && plan.current !== undefined
    && plan.current.responsibilityKind !== "vacant");
  if (rotatingReschedulePlans.length > 0) {
    const assignmentRows = await tx.select({
      occurrenceId: rotatingOccurrenceAssignments.occurrenceId,
      teamId: rotatingOccurrenceAssignments.teamId,
      slotIndex: rotatingOccurrenceAssignments.slotIndex,
    }).from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, [...new Set(rotatingReschedulePlans.map((plan) => plan.occurrence.id))]),
      inArray(rotatingOccurrenceAssignments.teamId, [...new Set(rotatingReschedulePlans.map((plan) => plan.team.id))]),
      inArray(rotatingOccurrenceAssignments.slotIndex, [...new Set(rotatingReschedulePlans.map((plan) => plan.slot.slotIndex))]),
    )).for("update");
    const assignmentKeys = new Set(assignmentRows.map((row) => materializationSlotKey(row.occurrenceId, row.teamId, row.slotIndex, row.slotIndex)));
    if (rotatingReschedulePlans.some((plan) => assignmentKeys.has(materializationSlotKey(plan.occurrence.id, plan.team.id, plan.slot.slotIndex, plan.slot.slotIndex)))) {
      throw new Error("ROTATING_SCHEDULE_EVIDENCE_LOCKED");
    }

    const rotatingObligations = rotatingReschedulePlans.flatMap((plan) => plan.currentObligations);
    const rotatingObligationIds = [...new Set(rotatingObligations.map((obligation) => obligation.id))];
    if (rotatingObligations.some((obligation) => obligation.state !== "open")) {
      throw new Error("ROTATING_SCHEDULE_EVIDENCE_LOCKED");
    }
    if (rotatingObligationIds.length > 0) {
      const allocationEvidence = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        inArray(paymentAllocations.obligationId, rotatingObligationIds),
      )).for("update");
      if (allocationEvidence.length > 0) throw new Error("ROTATING_SCHEDULE_EVIDENCE_LOCKED");
      await assertOpenRosterEvidenceCanBeReplacedForIds(tx, input, rotatingObligations);
    }

    const linkedOperations = await tx.select({
      status: paymentOperations.status,
      dispatchClaimedAt: paymentOperations.dispatchClaimedAt,
      providerObjectId: paymentOperations.providerObjectId,
    }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      inArray(paymentOperations.triggerOccurrenceId, [...new Set(rotatingReschedulePlans.map((plan) => plan.occurrence.id))]),
    )).for("update");
    if (linkedOperations.some((operation) => operation.dispatchClaimedAt !== null
      || operation.providerObjectId !== null
      || ["pending", "leased", "provider_unknown", "retry_scheduled", "succeeded", "action_required", "reconciliation_required"].includes(operation.status))) {
      throw new Error("ROTATING_SCHEDULE_EVIDENCE_LOCKED");
    }
  }

  // A current fixed Main responsibility can be converted in place only when
  // its existing liability is one ordinary full-week component. Substitution
  // and split evidence requires an explicit financial reconciliation; silently
  // relabeling its components would distort the rotating slot's standard fee.
  const conversionPlans = plans.filter((plan) => plan.slot.occupant === "rotating"
    && plan.current !== undefined
    && plan.current.responsibilityKind !== "vacant"
    && mode === "roster"
    && plan.currentObligations.some((obligation) => {
      const owner = currentOwners.get(obligation.id);
      return owner?.kind === "bowler" && (obligation.state === "open" || obligation.state === "partially_settled");
    }));
  for (const plan of conversionPlans) {
    const currentObligations = plan.currentObligations;
    if (plan.current?.responsibilityKind !== "main" && plan.current?.responsibilityKind !== "rotating") {
      throw new Error("ROTATING_CONVERSION_RESPONSIBILITY_UNSUPPORTED");
    }
    const effectiveObligations = currentObligations.filter((obligation) => obligation.state !== "voided");
    if (currentObligations.length > 0 && effectiveObligations.length === 0) {
      throw new Error("ROTATING_CONVERSION_VOIDED_OBLIGATION");
    }
    if (effectiveObligations.length > 1 || effectiveObligations.some((obligation) => obligation.component !== "full")) {
      throw new Error("ROTATING_CONVERSION_COMPONENTS_UNSUPPORTED");
    }
    const transitioningObligations = effectiveObligations.filter((obligation) => {
      const owner = currentOwners.get(obligation.id);
      return owner?.kind === "bowler" && (obligation.state === "open" || obligation.state === "partially_settled");
    });
    await assertRotatingOwnerConversionEvidenceClear(tx, input, transitioningObligations);
    for (const obligation of transitioningObligations) {
      try {
        await appendTeamPaymentObligationOwnerInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          obligationId: obligation.id,
          teamId: plan.team.id,
          actorUserId: input.actorUserId,
          reason: "rotating_conversion",
        });
      } catch (error) {
        if (error instanceof Error && error.name === "PaymentObligationOwnerError") throw new Error("ROTATING_OWNER_EVIDENCE_INVALID");
        throw error;
      }
    }
  }

  const guardPlans = plans.filter((plan) => plan.action === "reschedule" || plan.action === "void");
  const guardIds = guardPlans.flatMap((plan) => plan.current ? [plan.current.id] : []);
  const guardObligations = guardPlans.flatMap((plan) => plan.currentObligations);
  await assertOpenRosterEvidenceCanBeReplacedForIds(tx, input, guardObligations);

  const voidIds = guardIds;
  if (voidIds.length > 0) {
    await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, voidIds),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.responsibilityId, voidIds),
      eq(paymentObligations.state, "open"),
    ));
  }

  const insertPlans = plans.filter((plan) => plan.action === "create" || plan.action === "reschedule");
  const responsibilityInsertPlans = insertPlans.map((plan) => {
    const current = plan.current;
    const latest = latestBySlot.get(materializationSlotKey(plan.occurrence.id, plan.team.id, plan.slot.slotIndex, plan.slot.slotIndex));
    const version = current && plan.action === "reschedule"
      ? current.version + 1
      : Math.max(current?.version ?? 0, latest?.version ?? 0) + 1;
    // A retained substitute/split responsibility can remain authoritative even
    // when its current slot no longer has an eligible default occupant. Its
    // existing kind is copied by the reschedule branch below; only a new
    // default needs a resolved roster kind.
    const materializationKind = plan.kind ?? plan.current?.responsibilityKind;
    if (materializationKind === undefined) throw new Error("RESPONSIBILITY_KIND_UNAVAILABLE");
    return {
      plan,
      version,
      values: mode === "reschedule" && current && plan.action === "reschedule"
        ? {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: plan.occurrence.id,
          teamId: current.teamId,
          slotId: current.slotId,
          slotIndex: current.slotIndex,
          positionIndex: current.positionIndex,
          responsibilityKey: current.responsibilityKey,
          version,
          state: "active" as const,
          responsibilityKind: current.responsibilityKind,
          mainBowlerId: current.mainBowlerId,
          substituteBowlerId: current.substituteBowlerId,
          payerBowlerId: current.payerBowlerId,
          lineagePayerBowlerId: current.lineagePayerBowlerId,
          prizePayerBowlerId: current.prizePayerBowlerId,
          policy: current.policy,
          amountMinor: current.amountMinor,
          lineageAmountMinor: current.lineageAmountMinor,
          prizeFundAmountMinor: current.prizeFundAmountMinor,
          currency: current.currency,
          dueAt: plan.dueAt,
          pastDueAt: plan.pastDueAt,
          assignmentNote: current.assignmentNote,
          recordedByUserId: input.actorUserId,
        }
        : {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: plan.occurrence.id,
          teamId: plan.team.id,
          slotId: plan.slot.id,
          slotIndex: plan.slot.slotIndex,
          positionIndex: plan.slot.slotIndex,
          ...(latest ? { responsibilityKey: latest.responsibilityKey } : {}),
          version,
          state: "active" as const,
          responsibilityKind: materializationKind,
          mainBowlerId: plan.mainBowlerId,
          substituteBowlerId: null,
          payerBowlerId: plan.payerBowlerId,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          policy: plan.policy,
          amountMinor: materializationKind === "main" || materializationKind === "rotating" ? league.weeklyFee : 0,
          currency: "USD",
          dueAt: plan.dueAt,
          pastDueAt: plan.pastDueAt,
          assignmentNote: "roster_default",
          recordedByUserId: input.actorUserId,
        },
    };
  });
  const insertedResponsibilities: Array<typeof occurrencePaymentResponsibilities.$inferSelect> = [];
  for (let index = 0; index < responsibilityInsertPlans.length; index += 500) {
    const inserted = await tx.insert(occurrencePaymentResponsibilities)
      .values(responsibilityInsertPlans.slice(index, index + 500).map((item) => item.values))
      .returning();
    insertedResponsibilities.push(...inserted);
  }
  const insertedByPlan = new Map<string, typeof occurrencePaymentResponsibilities.$inferSelect>();
  for (const responsibility of insertedResponsibilities) {
    const key = materializationSlotKey(responsibility.occurrenceId, responsibility.teamId, responsibility.slotIndex, responsibility.positionIndex) + `:${responsibility.version}`;
    insertedByPlan.set(key, responsibility);
  }

  const obligationInsertValues = responsibilityInsertPlans.flatMap((item) => {
    const responsibility = insertedByPlan.get(materializationVersionKey(item.plan, item.version));
    if (!responsibility) throw new Error("RESPONSIBILITY_VERSION_FAILED");
    if (mode === "reschedule" && item.plan.action === "reschedule") {
      return item.plan.currentObligations.map((obligation) => ({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: item.plan.occurrence.id,
        responsibilityId: responsibility.id,
        component: obligation.component,
        payerBowlerId: obligation.payerBowlerId,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        dueAt: item.plan.dueAt,
        pastDueAt: item.plan.pastDueAt,
        state: "open" as const,
        createdByUserId: input.actorUserId,
      }));
    }
    return (item.plan.payerBowlerId !== null || item.plan.kind === "rotating") && league.weeklyFee > 0 ? [{
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      occurrenceId: item.plan.occurrence.id,
      responsibilityId: responsibility.id,
      component: "full" as const,
      payerBowlerId: item.plan.payerBowlerId,
      amountMinor: league.weeklyFee,
      currency: "USD",
      dueAt: item.plan.dueAt,
      pastDueAt: item.plan.pastDueAt,
      state: "open" as const,
      createdByUserId: input.actorUserId,
    }] : [];
  });
  const insertedObligations: Array<typeof paymentObligations.$inferSelect> = [];
  for (let index = 0; index < obligationInsertValues.length; index += 500) {
    const inserted = await tx.insert(paymentObligations).values(obligationInsertValues.slice(index, index + 500)).returning();
    insertedObligations.push(...inserted);
  }
  const teamIdByResponsibilityId = new Map<string, number>([
    ...insertedResponsibilities.map((responsibility) => [responsibility.id, responsibility.teamId] as const),
    ...plans.flatMap((plan) => plan.current ? [[plan.current.id, plan.current.teamId] as const] : []),
  ]);
  const newTeamOwnerRows = insertedObligations.filter((obligation) => obligation.payerBowlerId === null).map((obligation) => {
    const teamId = teamIdByResponsibilityId.get(obligation.responsibilityId);
    if (teamId === undefined) throw new Error("ROTATING_OWNER_TEAM_MISSING");
    return {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligationId: obligation.id,
      revisionNumber: 1,
      ownerKind: "team" as const,
      ownerBowlerId: null,
      ownerTeamId: teamId,
      reason: "rotating_materialization" as const,
      recordedByUserId: input.actorUserId,
    };
  });
  for (let index = 0; index < newTeamOwnerRows.length; index += 500) {
    await tx.insert(paymentObligationOwnerRevisions).values(newTeamOwnerRows.slice(index, index + 500));
  }

  // A missing default obligation is repairable without issuing a new
  // responsibility version. This path intentionally accepts only a current
  // default Main with no obligation rows, so it cannot reopen voided/settled
  // evidence or manufacture a payment for an explicit override/VACANT slot.
  const repairPlans = plans.filter((plan) => plan.action === "repair"
    && plan.current !== undefined
    && (plan.payerBowlerId !== null || plan.kind === "rotating")
    && league.weeklyFee > 0);
  const repairObligationValues = repairPlans.flatMap((plan) => {
    const current = plan.current;
    if (!current) return [];
    return [{
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      occurrenceId: plan.occurrence.id,
      responsibilityId: current.id,
      component: "full" as const,
      payerBowlerId: plan.payerBowlerId,
      amountMinor: league.weeklyFee,
      currency: "USD",
      dueAt: plan.dueAt,
      pastDueAt: plan.pastDueAt,
      state: "open" as const,
      createdByUserId: input.actorUserId,
    }];
  });
  for (let index = 0; index < repairObligationValues.length; index += 500) {
    const inserted = await tx.insert(paymentObligations).values(repairObligationValues.slice(index, index + 500)).returning();
    const ownerRows = inserted.filter((obligation) => obligation.payerBowlerId === null).map((obligation) => {
      const plan = repairPlans.find((candidate) => candidate.current?.id === obligation.responsibilityId);
      if (!plan || plan.slot.occupant !== "rotating") throw new Error("ROTATING_OWNER_TEAM_MISSING");
      return {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        obligationId: obligation.id,
        revisionNumber: 1,
        ownerKind: "team" as const,
        ownerBowlerId: null,
        ownerTeamId: plan.team.id,
        reason: "rotating_materialization" as const,
        recordedByUserId: input.actorUserId,
      };
    });
    if (ownerRows.length > 0) await tx.insert(paymentObligationOwnerRevisions).values(ownerRows);
  }
  return true;
}
