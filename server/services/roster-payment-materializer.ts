import { and, asc, desc, eq, inArray, isNotNull, or, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagues,
  autopayConsentPartners,
  autopayConsents,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentAllocations,
  paymentOperationRosterSnapshotItems,
  paymentOperationStandingAutopayBindings,
  paymentOperations,
  teamPaymentPolicies,
  teamPaymentSlots,
  teams,
} from "@shared/schema";
import type * as schema from "@shared/schema";
import { calculateRosterPaymentTiming } from "@shared/roster-payment-contract";

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
  input: { organizationId: number; leagueId: number; bowlerId: number; now?: string },
): Promise<void> {
  const revokedAt = input.now ?? new Date().toISOString();
  const consents = await tx.select({ consent: autopayConsents }).from(autopayConsents).where(and(
    eq(autopayConsents.organizationId, input.organizationId),
    eq(autopayConsents.leagueId, input.leagueId),
    or(
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
  if (obligations.some((row) => row.state !== "open")) throw new Error("PAID_EVIDENCE_LOCKED");
  const obligationIds = obligations.map((row) => row.id);
  if (obligationIds.length === 0) return obligations;

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
  return obligations;
}

/**
 * Database-only publication hook for a configured roster occurrence. It is kept
 * free of the provider factory and app db singleton so schedule operators can
 * use it inside their existing transaction without importing payment I/O.
 */
export async function materializeRosterPaymentOccurrenceInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; occurrenceId: string; actorUserId: number; reschedule?: boolean; teamId?: number },
): Promise<boolean> {
  const [league] = await tx.select({
    payingLineupSize: leagues.payingLineupSize,
    weeklyFee: leagues.weeklyFee,
    paymentMode: leagues.paymentMode,
  }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league?.payingLineupSize) return false;
  const [occurrence] = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt })
    .from(leagueOccurrences).where(and(
      eq(leagueOccurrences.id, input.occurrenceId),
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"] as const),
      inArray(leagueOccurrences.status, ["scheduled", "completed"] as const),
    )).limit(1);
  if (!occurrence) return false;
  const rosterTeams = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true)));
  const selectedTeams = rosterTeams.filter((team) => input.teamId === undefined || team.id === input.teamId);
  if (selectedTeams.length === 0) return false;
  const rosterRows = await tx.select().from(teamPaymentSlots)
    .where(and(eq(teamPaymentSlots.organizationId, input.organizationId), eq(teamPaymentSlots.leagueId, input.leagueId)))
    .orderBy(asc(teamPaymentSlots.teamId), asc(teamPaymentSlots.slotIndex));
  const activeMainRows = await tx.select({ bowlerId: bowlers.id, teamId: bowlerLeagues.teamId }).from(bowlers)
    .innerJoin(bowlerLeagues, and(
      eq(bowlerLeagues.bowlerId, bowlers.id),
      eq(bowlerLeagues.leagueId, input.leagueId),
      eq(bowlerLeagues.active, true),
    )).where(and(
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlers.active, true),
    ));
  const activeMainKeys = new Set(activeMainRows.map((row) => `${row.teamId}:${row.bowlerId}`));
  const policies = await tx.select().from(teamPaymentPolicies).where(and(eq(teamPaymentPolicies.organizationId, input.organizationId), eq(teamPaymentPolicies.leagueId, input.leagueId)));
  const active = await tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  const timing = await deriveRosterPaymentTimingInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    paymentMode: league.paymentMode,
    occurrenceStartAt: occurrence.startAt,
  });
  const { dueAt, pastDueAt } = timing;
  for (const team of selectedTeams) {
    for (const slot of rosterRows.filter((row) => row.teamId === team.id)) {
      const policy = policies.find((row) => row.teamId === team.id)?.defaultPolicy ?? "main_pays_full";
      const kind = slot.occupant === "vacant"
        ? "vacant" as const
        : slot.occupant === "main" && slot.mainBowlerId !== null && activeMainKeys.has(`${team.id}:${slot.mainBowlerId}`)
          ? "main" as const
          : null;
      const mainBowlerId = kind === "main" ? slot.mainBowlerId : null;
      const payerBowlerId = mainBowlerId;
      const current = active.find((row) => row.teamId === team.id && row.slotIndex === slot.slotIndex && row.positionIndex === slot.slotIndex);
      const currentIsOverride = current !== undefined && (current.responsibilityKind === "substitute" || current.responsibilityKind === "split");
      if (current && !currentIsOverride && kind !== null && current.responsibilityKind === kind && current.mainBowlerId === mainBowlerId && current.substituteBowlerId === null && current.payerBowlerId === payerBowlerId && current.policy === policy && current.dueAt === dueAt && current.pastDueAt === pastDueAt) continue;
      if (current && input.reschedule && (currentIsOverride || kind !== null)) {
        // A safe future schedule correction preserves the resolved payer and
        // component facts while issuing a new responsibility/obligation
        // version with the corrected due instants. The caller has already
        // taken the league lock and checked that these rows are open,
        // unallocated, and unreserved; repeat the checks here because this
        // primitive is also called by publication/restore paths.
        const currentObligations = await tx.select().from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.responsibilityId, current.id),
        )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.id)).for("update");
        await assertOpenRosterEvidenceCanBeReplaced(tx, input, current.id, currentObligations);
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
          eq(occurrencePaymentResponsibilities.id, current.id),
          eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
          eq(occurrencePaymentResponsibilities.state, "active"),
        ));
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
          eq(paymentObligations.responsibilityId, current.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.state, "open"),
        ));
        const [rescheduledResponsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: occurrence.id,
          teamId: current.teamId,
          slotId: current.slotId,
          slotIndex: current.slotIndex,
          positionIndex: current.positionIndex,
          responsibilityKey: current.responsibilityKey,
          version: current.version + 1,
          state: "active",
          responsibilityKind: current.responsibilityKind,
          mainBowlerId: current.mainBowlerId,
          substituteBowlerId: current.substituteBowlerId,
          payerBowlerId: current.payerBowlerId,
          lineagePayerBowlerId: current.lineagePayerBowlerId,
          prizePayerBowlerId: current.prizePayerBowlerId,
          policy: current.policy,
          amountMinor: current.amountMinor,
          currency: current.currency,
          dueAt,
          pastDueAt,
          assignmentNote: current.assignmentNote,
          recordedByUserId: input.actorUserId,
        }).returning();
        if (!rescheduledResponsibility) throw new Error("RESPONSIBILITY_VERSION_FAILED");
        for (const obligation of currentObligations) {
          await tx.insert(paymentObligations).values({
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            occurrenceId: occurrence.id,
            responsibilityId: rescheduledResponsibility.id,
            component: obligation.component,
            payerBowlerId: obligation.payerBowlerId,
            amountMinor: obligation.amountMinor,
            currency: obligation.currency,
            dueAt,
            pastDueAt,
            state: "open",
            createdByUserId: input.actorUserId,
          });
        }
        continue;
      }
      if (currentIsOverride) continue;
      if (current) {
        const currentObligations = await tx.select().from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.responsibilityId, current.id),
        )).for("update");
        // Settled/voided responsibility history is immutable. A roster
        // invalidation must not rewrite that evidence or fail the membership
        // mutation; leave the historical version in place and continue with
        // future/open occurrences. Reserved evidence remains a hard fence.
        if (currentObligations.some((row) => row.state !== "open")) continue;
        await assertOpenRosterEvidenceCanBeReplaced(tx, input, current.id, currentObligations);
        await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
          eq(occurrencePaymentResponsibilities.id, current.id),
          eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
          eq(occurrencePaymentResponsibilities.state, "active"),
        ));
        await tx.update(paymentObligations).set({ state: "voided", voidedAt: new Date().toISOString() }).where(and(
          eq(paymentObligations.responsibilityId, current.id),
          eq(paymentObligations.organizationId, input.organizationId),
          eq(paymentObligations.leagueId, input.leagueId),
          eq(paymentObligations.state, "open"),
        ));
      }
      if (kind === null) continue;
      const [latestResponsibility] = await tx.select({ version: occurrencePaymentResponsibilities.version, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey })
        .from(occurrencePaymentResponsibilities)
        .where(and(
          eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
          eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
          eq(occurrencePaymentResponsibilities.teamId, team.id),
          eq(occurrencePaymentResponsibilities.slotIndex, slot.slotIndex),
          eq(occurrencePaymentResponsibilities.positionIndex, slot.slotIndex),
        )).orderBy(desc(occurrencePaymentResponsibilities.version)).limit(1).for("update");
      const nextVersion = Math.max(current?.version ?? 0, latestResponsibility?.version ?? 0) + 1;
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: occurrence.id,
        teamId: team.id,
        slotId: slot.id,
        slotIndex: slot.slotIndex,
        positionIndex: slot.slotIndex,
        ...(latestResponsibility ? { responsibilityKey: latestResponsibility.responsibilityKey } : {}),
        version: nextVersion,
        state: "active",
        responsibilityKind: kind,
        mainBowlerId,
        substituteBowlerId: null,
        payerBowlerId,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        policy,
        amountMinor: kind === "main" ? league.weeklyFee : 0,
        currency: "USD",
        dueAt,
        pastDueAt,
        assignmentNote: "roster_default",
        recordedByUserId: input.actorUserId,
      }).returning();
      if (responsibility && payerBowlerId !== null && league.weeklyFee > 0) {
        await tx.insert(paymentObligations).values({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          occurrenceId: occurrence.id,
          responsibilityId: responsibility.id,
          component: "full",
          payerBowlerId,
          amountMinor: league.weeklyFee,
          currency: "USD",
          dueAt,
          pastDueAt,
          state: "open",
          createdByUserId: input.actorUserId,
        });
      }
    }
  }
  return true;
}
