import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerLeagues,
  paymentOperationStandingAutopayParticipants,
  paymentOperationRosterSnapshots,
  paymentOperationRosterSnapshotItems,
  paymentAllocations,
  paymentObligations,
  teamPaymentPolicies,
  teamPaymentPolicyRevisions,
  teams,
  leagues,
  teamPaymentSlots,
  teamPaymentSlotRevisions,
  occurrencePaymentResponsibilities,
  payments,
  scores,
  users,
  type Team,
  type InsertTeam,
  type UpdateTeam,
} from "@shared/schema";
import { lockLeagueSchedule } from './league-schedule-lock.js';
import { getPgErrorCode } from '../utils/db-errors.js';
import { cacheInvalidate } from '../utils/cache.js';

export type TeamDeletionBlockerCode =
  | "PAYMENT_ACTIVITY"
  | "PAYMENT_ALLOCATION_EVIDENCE"
  | "PAYMENT_OPERATION_EVIDENCE"
  | "AUTOPAY_ACTIVITY"
  | "SETTLED_OBLIGATION"
  | "SCORE_HISTORY"
  | "DEPENDENCY_CHANGED";

const teamDeletionBlockerMessages: Record<TeamDeletionBlockerCode, string> = {
  PAYMENT_ACTIVITY: "This team has recorded payment activity, including voided, refunded, or disputed payments.",
  PAYMENT_ALLOCATION_EVIDENCE: "This team has retained payment allocation or refund evidence.",
  PAYMENT_OPERATION_EVIDENCE: "This team has a retained, pending, reserved, failed, or provider-linked payment operation.",
  AUTOPAY_ACTIVITY: "This team has active or retained automatic-payment setup or partner activity.",
  SETTLED_OBLIGATION: "This team has an unsettled, settled, or otherwise retained payment obligation.",
  SCORE_HISTORY: "This team has score history and cannot be deleted without removing league history.",
  DEPENDENCY_CHANGED: "The team's records changed while deletion was in progress. Retry after the current operation finishes.",
};

/** A known retained dependency must be surfaced as an actionable 409. */
export class TeamDeletionRequiresArchiveError extends Error {
  readonly blockerCode: TeamDeletionBlockerCode | "FINANCIAL_EVIDENCE";

  constructor(blockerCode: TeamDeletionBlockerCode | "FINANCIAL_EVIDENCE" = "FINANCIAL_EVIDENCE") {
    const message = blockerCode === "FINANCIAL_EVIDENCE"
      ? "This team has retained financial roster or payment history. Archive it only to hide the team while preserving that evidence; archiving does not cancel dues."
      : blockerCode === "AUTOPAY_ACTIVITY"
        ? `${teamDeletionBlockerMessages[blockerCode]} Cancel the automatic-payment setup first; archiving only hides the team and does not cancel automatic payments or dues.`
        : `${teamDeletionBlockerMessages[blockerCode]} Archive the team only to hide it while preserving that evidence; archiving does not cancel dues.`;
    super(message);
    this.name = 'TeamDeletionRequiresArchiveError';
    this.blockerCode = blockerCode;
  }
}

/** The tenant checked by the route changed before the locked delete began. */
export class TeamOrganizationChangedError extends Error {
  constructor() {
    super('Team organization changed while acquiring its schedule lock');
    this.name = 'TeamOrganizationChangedError';
  }
}

export class TeamDeletionDependencyChangedError extends Error {
  readonly blockerCode = "DEPENDENCY_CHANGED" as const;

  constructor() {
    super(teamDeletionBlockerMessages.DEPENDENCY_CHANGED);
    this.name = "TeamDeletionDependencyChangedError";
  }
}

type TeamTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Renumber one league using the transaction and schedule lock already held by
 * the caller.  The temporary negative values avoid collisions with the
 * league-number unique index while the active/inactive order is rebuilt.
 */
async function renumberActiveTeamsInTransaction(tx: TeamTransaction, leagueId: number): Promise<void> {
  const allTeams = await tx
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.displayOrder, teams.number)
    .for('update');

  const activeTeams = allTeams.filter((team) => team.active);
  const inactiveTeams = allTeams.filter((team) => !team.active);

  for (let i = 0; i < allTeams.length; i++) {
    await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, allTeams[i].id));
  }
  for (let i = 0; i < activeTeams.length; i++) {
    await tx.update(teams).set({ number: i + 1, displayOrder: i }).where(eq(teams.id, activeTeams[i].id));
  }
  for (let i = 0; i < inactiveTeams.length; i++) {
    await tx.update(teams).set({ number: activeTeams.length + i + 1, displayOrder: activeTeams.length + i }).where(eq(teams.id, inactiveTeams[i].id));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotReferencesTeam(
  obligations: unknown,
  responsibilityIds: ReadonlySet<string>,
  obligationIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(obligations)) return false;
  return obligations.some((value) => {
    if (!isRecord(value)) return false;
    const obligationId = value.obligationId;
    const recordId = value.id;
    const responsibilityId = value.responsibilityId;
    return (typeof obligationId === "string" && obligationIds.has(obligationId))
      || (typeof recordId === "string" && obligationIds.has(recordId))
      || (typeof responsibilityId === "string" && responsibilityIds.has(responsibilityId));
  });
}

function addResponsibilityBowlerIds(
  ids: Set<number>,
  row: {
    mainBowlerId: number | null;
    substituteBowlerId: number | null;
    payerBowlerId: number | null;
    lineagePayerBowlerId: number | null;
    prizePayerBowlerId: number | null;
  },
): void {
  for (const id of [
    row.mainBowlerId,
    row.substituteBowlerId,
    row.payerBowlerId,
    row.lineagePayerBowlerId,
    row.prizePayerBowlerId,
  ]) {
    if (id !== null) ids.add(id);
  }
}

/**
 * Verify and remove exactly the target team's unused roster-payment setup.
 * The advisory schedule lock is held by the caller, so all roster, payment,
 * preparation, and standing-autopay writers that follow the established lock
 * protocol serialize with this read set.
 */
async function deleteUnusedTeamRows(
  tx: TeamTransaction,
  input: { organizationId: number | null; leagueId: number; teamId: number },
): Promise<void> {
  const organizationId = input.organizationId;
  const memberships = await tx.select({ id: bowlerLeagues.id, bowlerId: bowlerLeagues.bowlerId, active: bowlerLeagues.active })
    .from(bowlerLeagues)
    .where(and(
      eq(bowlerLeagues.leagueId, input.leagueId),
      eq(bowlerLeagues.teamId, input.teamId),
    ))
    .orderBy(asc(bowlerLeagues.id))
    .for("update");
  // Include inactive memberships too: deleting the team's last historical
  // association must not erase an otherwise retained payment row. Active
  // memberships are only one part of the team's financial identity.
  const relevantBowlerIds = new Set<number>(memberships.map((row) => row.bowlerId));
  const activeTargetBowlerIds = [...new Set(memberships.filter((row) => row.active).map((row) => row.bowlerId))];
  const activeLeagueMemberships = activeTargetBowlerIds.length === 0 ? [] : await tx.select({
    bowlerId: bowlerLeagues.bowlerId,
    teamId: bowlerLeagues.teamId,
  }).from(bowlerLeagues).where(and(
    eq(bowlerLeagues.leagueId, input.leagueId),
    eq(bowlerLeagues.active, true),
    inArray(bowlerLeagues.bowlerId, activeTargetBowlerIds),
  )).orderBy(asc(bowlerLeagues.bowlerId), asc(bowlerLeagues.teamId), asc(bowlerLeagues.id)).for("share");
  const activeOtherTeamBowlerIds = new Set(activeLeagueMemberships
    .filter((row) => row.teamId !== input.teamId)
    .map((row) => row.bowlerId));
  const lastTeamActiveBowlerIds = activeTargetBowlerIds.filter((bowlerId) => !activeOtherTeamBowlerIds.has(bowlerId));

  const slots = organizationId === null ? [] : await tx.select().from(teamPaymentSlots).where(and(
    eq(teamPaymentSlots.organizationId, organizationId),
    eq(teamPaymentSlots.leagueId, input.leagueId),
    eq(teamPaymentSlots.teamId, input.teamId),
  )).orderBy(asc(teamPaymentSlots.slotIndex)).for("update");
  const policies = organizationId === null ? [] : await tx.select().from(teamPaymentPolicies).where(and(
    eq(teamPaymentPolicies.organizationId, organizationId),
    eq(teamPaymentPolicies.leagueId, input.leagueId),
    eq(teamPaymentPolicies.teamId, input.teamId),
  )).orderBy(asc(teamPaymentPolicies.id)).for("update");
  const responsibilities = organizationId === null ? [] : await tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.teamId, input.teamId),
  )).orderBy(
    asc(occurrencePaymentResponsibilities.occurrenceId),
    asc(occurrencePaymentResponsibilities.slotIndex),
    asc(occurrencePaymentResponsibilities.positionIndex),
    asc(occurrencePaymentResponsibilities.version),
    asc(occurrencePaymentResponsibilities.id),
  ).for("update");
  for (const slot of slots) {
    if (slot.mainBowlerId !== null) relevantBowlerIds.add(slot.mainBowlerId);
  }
  for (const responsibility of responsibilities) addResponsibilityBowlerIds(relevantBowlerIds, responsibility);

  const responsibilityIds = responsibilities.map((row) => row.id);
  const responsibilityIdSet = new Set(responsibilityIds);
  const obligations = organizationId === null || responsibilityIds.length === 0 ? [] : await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, responsibilityIds),
  )).orderBy(
    asc(paymentObligations.responsibilityId),
    asc(paymentObligations.dueAt),
    asc(paymentObligations.id),
  ).for("update");
  const obligationIds = obligations.map((row) => row.id);
  const obligationIdSet = new Set(obligationIds);

  if (organizationId !== null) {
    if (obligations.some((row) => row.state !== "open" && row.state !== "voided")) {
      throw new TeamDeletionRequiresArchiveError("SETTLED_OBLIGATION");
    }

    const allocations = obligationIds.length === 0 ? [] : await tx.select({
      id: paymentAllocations.id,
      paymentId: paymentAllocations.paymentId,
      obligationId: paymentAllocations.obligationId,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(paymentAllocations.obligationId, obligationIds),
    )).orderBy(asc(paymentAllocations.id)).for("share");
    if (allocations.length > 0) throw new TeamDeletionRequiresArchiveError("PAYMENT_ALLOCATION_EVIDENCE");

    const snapshotItems = obligationIds.length === 0 ? [] : await tx.select({
      id: paymentOperationRosterSnapshotItems.id,
      operationId: paymentOperationRosterSnapshotItems.operationId,
    }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
    )).orderBy(asc(paymentOperationRosterSnapshotItems.id)).for("share");
    if (snapshotItems.length > 0) throw new TeamDeletionRequiresArchiveError("PAYMENT_OPERATION_EVIDENCE");

    const standingParticipants = obligationIds.length === 0 ? [] : await tx.select({ id: paymentOperationStandingAutopayParticipants.id }).from(paymentOperationStandingAutopayParticipants).where(and(
      eq(paymentOperationStandingAutopayParticipants.organizationId, organizationId),
      eq(paymentOperationStandingAutopayParticipants.leagueId, input.leagueId),
      inArray(paymentOperationStandingAutopayParticipants.obligationId, obligationIds),
    )).orderBy(asc(paymentOperationStandingAutopayParticipants.id)).for("share");
    if (standingParticipants.length > 0) throw new TeamDeletionRequiresArchiveError("PAYMENT_OPERATION_EVIDENCE");

    // Interactive snapshots persist the same immutable obligation and
    // responsibility IDs in JSON before normalized reservation items exist.
    // Inspect only those explicit IDs; targetKey/provider payloads are opaque.
    const snapshots = await tx.select({
      operationId: paymentOperationRosterSnapshots.operationId,
      obligations: paymentOperationRosterSnapshots.obligations,
    }).from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.organizationId, organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).orderBy(asc(paymentOperationRosterSnapshots.operationId));
    if (snapshots.some((snapshot) => snapshotReferencesTeam(snapshot.obligations, responsibilityIdSet, obligationIdSet))) {
      throw new TeamDeletionRequiresArchiveError("PAYMENT_OPERATION_EVIDENCE");
    }

    // Legacy payment rows do not carry a team FK. A payment with normalized
    // allocations to another team is safely unrelated; an unallocated row for
    // a current/target responsibility bowler is ambiguous and fails closed.
    const candidateBowlerIds = [...relevantBowlerIds];
    const candidatePayments = candidateBowlerIds.length === 0 ? [] : await tx.select({
      id: payments.id,
      bowlerId: payments.bowlerId,
      amount: payments.amount,
    }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, input.leagueId),
      inArray(payments.bowlerId, candidateBowlerIds),
    )).orderBy(asc(payments.id)).for("share");
    if (candidatePayments.length > 0) {
      const paymentIds = candidatePayments.map((row) => row.id);
      const paymentAllocationsForCandidates = await tx.select({
        paymentId: paymentAllocations.paymentId,
        amountMinor: paymentAllocations.amountMinor,
      }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        inArray(paymentAllocations.paymentId, paymentIds),
      ));
      const allocationTotals = new Map<number, number>();
      for (const allocation of paymentAllocationsForCandidates) {
        allocationTotals.set(
          allocation.paymentId,
          (allocationTotals.get(allocation.paymentId) ?? 0) + allocation.amountMinor,
        );
      }
      // A legacy payment has no team FK. Treat it as unrelated only when the
      // entire tender is accounted for by normalized allocations (which are
      // already checked above for target-team obligations). Any unallocated or
      // over/under-allocated remainder is ambiguous and fails closed.
      if (candidatePayments.some((payment) => (allocationTotals.get(payment.id) ?? 0) !== payment.amount)) {
        throw new TeamDeletionRequiresArchiveError("PAYMENT_ACTIVITY");
      }
    }

    // Active consent is relevant when its payer or accepted partner is a
    // target member or a bowler recorded in target-team responsibility
    // history. Historical revoked/expired consent rows remain intact and do
    // not, by themselves, make an otherwise unused team undeletable.
    const payerConsents = lastTeamActiveBowlerIds.length === 0 ? [] : await tx.select().from(autopayConsents).where(and(
      eq(autopayConsents.organizationId, organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      inArray(autopayConsents.payerBowlerId, lastTeamActiveBowlerIds),
    )).orderBy(asc(autopayConsents.id)).for("share");
    const partnerRows = lastTeamActiveBowlerIds.length === 0 ? [] : await tx.select().from(autopayConsentPartners).where(and(
      eq(autopayConsentPartners.organizationId, organizationId),
      eq(autopayConsentPartners.leagueId, input.leagueId),
      inArray(autopayConsentPartners.partnerBowlerId, lastTeamActiveBowlerIds),
    )).orderBy(asc(autopayConsentPartners.id)).for("share");
    // Partners can be accepted by a different payer bowler. Load those parent
    // consent rows explicitly before checking the version/state, otherwise an
    // active external-payer consent would be invisible to this guard.
    const partnerConsentIds = [...new Set(partnerRows.map((row) => row.consentId))];
    const partnerConsents = partnerConsentIds.length === 0 ? [] : await tx.select().from(autopayConsents).where(and(
      eq(autopayConsents.organizationId, organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      inArray(autopayConsents.id, partnerConsentIds),
    )).orderBy(asc(autopayConsents.id)).for("share");
    const consents = [...new Map([...payerConsents, ...partnerConsents].map((row) => [row.id, row])).values()];
    const consentById = new Map(consents.map((row) => [row.id, row]));
    const activePayerConsent = payerConsents.some((row) => row.state === "active");
    const activePartner = partnerRows.some((row) => consentById.get(row.consentId)?.state === "active"
      && consentById.get(row.consentId)?.consentVersion === row.consentVersion);
    if (activePayerConsent || activePartner) {
      throw new TeamDeletionRequiresArchiveError("AUTOPAY_ACTIVITY");
    }
  }

  const scoreHistory = await tx.select({ id: scores.id }).from(scores)
    .where(eq(scores.teamId, input.teamId)).limit(1).for("share");
  if (scoreHistory.length > 0) throw new TeamDeletionRequiresArchiveError("SCORE_HISTORY");

  // Existing roster-payment append-only triggers permit deletes only behind
  // this transaction-local marker. It never changes the marker globally.
  if (organizationId !== null) {
    await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
    if (obligationIds.length > 0) await tx.delete(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, obligationIds),
    ));
    if (responsibilityIds.length > 0) await tx.delete(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
    ));
    const slotIds = slots.map((row) => row.id);
    if (slotIds.length > 0) await tx.delete(teamPaymentSlotRevisions).where(and(
      eq(teamPaymentSlotRevisions.organizationId, organizationId),
      eq(teamPaymentSlotRevisions.leagueId, input.leagueId),
      inArray(teamPaymentSlotRevisions.slotId, slotIds),
    ));
    const policyIds = policies.map((row) => row.id);
    if (policyIds.length > 0) await tx.delete(teamPaymentPolicyRevisions).where(and(
      eq(teamPaymentPolicyRevisions.organizationId, organizationId),
      eq(teamPaymentPolicyRevisions.leagueId, input.leagueId),
      inArray(teamPaymentPolicyRevisions.policyId, policyIds),
    ));
    if (slotIds.length > 0) await tx.delete(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, input.leagueId),
      eq(teamPaymentSlots.teamId, input.teamId),
    ));
    if (policyIds.length > 0) await tx.delete(teamPaymentPolicies).where(and(
      eq(teamPaymentPolicies.organizationId, organizationId),
      eq(teamPaymentPolicies.leagueId, input.leagueId),
      eq(teamPaymentPolicies.teamId, input.teamId),
    ));
  }
  if (memberships.length > 0) await tx.delete(bowlerLeagues).where(and(
    eq(bowlerLeagues.leagueId, input.leagueId),
    eq(bowlerLeagues.teamId, input.teamId),
  ));
}

export async function getTeams(leagueId?: number): Promise<Team[]> {
  const query = db.select().from(teams);
  if (leagueId !== undefined) {
    return query.where(eq(teams.leagueId, leagueId)).orderBy(teams.displayOrder, teams.number);
  }
  return query.orderBy(teams.displayOrder, teams.number);
}

export async function getTeam(id: number): Promise<Team | undefined> {
  const [result] = await db.select().from(teams).where(eq(teams.id, id));
  return result;
}

export async function createTeam(team: InsertTeam, recordedByUserId?: number): Promise<Team> {
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId, payingLineupSize: leagues.payingLineupSize }).from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (!league) throw new Error('League not found');
    if (league.organizationId !== null) await lockLeagueSchedule(tx, league.organizationId, team.leagueId);
    const [result] = await tx.insert(teams).values(team).returning();
    if (result && league.organizationId !== null && league.payingLineupSize !== null) {
      const actor = recordedByUserId ?? (await tx.select({ id: users.id }).from(users).where(and(
        eq(users.organizationId, league.organizationId),
        eq(users.role, "org_admin"),
      )).orderBy(users.id).limit(1))[0]?.id;
      if (actor !== undefined) {
        await tx.insert(teamPaymentSlots).values(Array.from({ length: league.payingLineupSize }, (_, slotIndex) => ({
          organizationId: league.organizationId as number,
          leagueId: team.leagueId,
          teamId: result.id,
          slotIndex,
          lineupSize: league.payingLineupSize as number,
          occupant: "unassigned" as const,
          mainBowlerId: null,
          recordedByUserId: actor,
        })));
      }
    }
    return result;
  });
}

export async function updateTeam(id: number, team: UpdateTeam): Promise<Team> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, id)).limit(1);
    if (!current) throw new Error('Team not found');
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (league?.organizationId !== null && league) await lockLeagueSchedule(tx, league.organizationId, current.leagueId);
    const [result] = await tx.update(teams).set(team).where(eq(teams.id, id)).returning();
    return result;
  });
}

export async function deleteTeam(id: number, expectedOrganizationId?: number | null): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Bound an admin request waiting behind a roster/payment transaction;
      // PostgreSQL releases the advisory lock automatically on rollback.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);

      // The league schedule lock is acquired before the row lock and before
      // reading financial evidence. Every roster/payment mutation uses this
      // same key, so deletion cannot race a roster save or materialization.
      const [scope] = await tx
        .select({ leagueId: teams.leagueId, organizationId: leagues.organizationId })
        .from(teams)
        .innerJoin(leagues, eq(leagues.id, teams.leagueId))
        .where(eq(teams.id, id))
        .limit(1);
      if (!scope) return;

      if (expectedOrganizationId !== undefined && scope.organizationId !== expectedOrganizationId) {
        throw new TeamOrganizationChangedError();
      }

      await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);

      const [current] = await tx
        .select({ id: teams.id, leagueId: teams.leagueId, organizationId: leagues.organizationId })
        .from(teams)
        .innerJoin(leagues, eq(leagues.id, teams.leagueId))
        .where(eq(teams.id, id))
        .limit(1)
        .for('update');
      if (!current) return;

      // A team move is itself guarded by the source league's schedule lock.
      // Re-check the joined row after waiting for that lock so the delete is
      // never applied using a stale tenant/league scope.
      if (current.leagueId !== scope.leagueId || current.organizationId !== scope.organizationId) {
        throw new TeamOrganizationChangedError();
      }
      if (expectedOrganizationId !== undefined && current.organizationId !== expectedOrganizationId) {
        throw new TeamOrganizationChangedError();
      }

      await deleteUnusedTeamRows(tx, {
        organizationId: current.organizationId,
        leagueId: current.leagueId,
        teamId: current.id,
      });
      await tx.delete(teams).where(eq(teams.id, id));

      // Delete and renumber are deliberately one atomic, league-locked
      // transaction. A failure in either operation rolls the other back.
      await renumberActiveTeamsInTransaction(tx, current.leagueId);
    });
    // Bowler directory entries include team assignments and are cached outside
    // the transaction. Invalidate only after commit so a rollback cannot
    // evict a still-valid cache entry or expose a partial deletion.
    cacheInvalidate('bowlers:');
  } catch (error) {
    // A lock/dependency race after the guarded read set is an actionable retry,
    // while unrelated database errors remain on the generic route path.
    const code = getPgErrorCode(error);
    if (code === "23503" || code === "40P01" || code === "40001" || code === "55P03") {
      throw new TeamDeletionDependencyChangedError();
    }
    throw error;
  }
}

export async function getTeamByNumber(leagueId: number, teamNumber: number): Promise<Team | undefined> {
  const [result] = await db
    .select()
    .from(teams)
    .where(and(
      eq(teams.leagueId, leagueId),
      eq(teams.number, teamNumber)
    ));
  return result;
}

export async function getTeamsByIds(ids: number[]): Promise<Team[]> {
  if (ids.length === 0) return [];
  return db.select().from(teams).where(inArray(teams.id, ids));
}

export async function renumberActiveTeams(leagueId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league) throw new Error('League not found');
    await lockLeagueSchedule(tx, league.organizationId, leagueId);
    await renumberActiveTeamsInTransaction(tx, leagueId);
  });
}

export async function reorderTeams(updates: { id: number; displayOrder: number; number: number }[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < updates.length; i++) {
      await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, updates[i].id));
    }
    for (const { id, displayOrder, number: teamNumber } of updates) {
      await tx.update(teams).set({ displayOrder, number: teamNumber }).where(eq(teams.id, id));
    }
  });
}
