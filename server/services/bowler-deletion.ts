import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { getPgErrorCode } from "../utils/db-errors.js";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerPaymentLinks,
  bowlerLeagues,
  bowlers,
  occurrencePaymentResponsibilities,
  leagues,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  payments,
  scores,
  standingAutopayPreparationAttempts,
  teamPaymentSlots,
  users,
} from "@shared/schema";

export type BowlerDeletionBlockerCode =
  | "ACTIVE_ROSTER_MEMBERSHIP" | "ROSTER_PAYMENT_SLOT" | "ACTIVE_RESPONSIBILITY"
  | "SHARED_RESPONSIBILITY_HISTORY" | "OPEN_PAYMENT_OBLIGATION" | "PAYMENT_EVIDENCE"
  | "PAYMENT_ALLOCATION_EVIDENCE" | "PAYMENT_OPERATION_EVIDENCE"
  | "AUTOPAY_NOT_CANCELLED" | "AUTOPAY_PROVIDER_ACTIVITY" | "AUTOPAY_PARTNER_EVIDENCE"
  | "AUTOPAY_PROVIDER_EVIDENCE" | "PAYMENT_PARTNER_LINK" | "LINKED_LOGIN"
  | "CROSS_ORGANIZATION_MEMBERSHIP" | "SCORE_HISTORY" | "CROSS_ORGANIZATION_PAYMENT_LINK"
  | "DEPENDENCY_CHANGED";

export interface BowlerDeletionBlocker {
  code: BowlerDeletionBlockerCode;
  message: string;
}

export class BowlerDeletionConflictError extends Error {
  readonly status = 409;
  constructor(readonly blockers: [BowlerDeletionBlocker]) {
    super("Bowler cannot be permanently deleted until the listed blocker is resolved");
    this.name = "BowlerDeletionConflictError";
  }
}

export class BowlerDeletionNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("Bowler not found");
    this.name = "BowlerDeletionNotFoundError";
  }
}

type DeletionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const blockerMessages: Record<BowlerDeletionBlockerCode, string> = {
  ACTIVE_ROSTER_MEMBERSHIP: "Remove the bowler from every active league roster before deleting the profile.",
  ROSTER_PAYMENT_SLOT: "Remove the bowler from every team payment slot before deleting the profile.",
  ACTIVE_RESPONSIBILITY: "The bowler still has active roster payment responsibility and must be removed from the roster first.",
  SHARED_RESPONSIBILITY_HISTORY: "The bowler is part of shared roster payment history used by another bowler and cannot be deleted.",
  OPEN_PAYMENT_OBLIGATION: "The bowler still has an open, unsettled, or retained payment obligation.",
  PAYMENT_EVIDENCE: "The bowler has recorded payment evidence and cannot be permanently deleted.",
  PAYMENT_ALLOCATION_EVIDENCE: "The bowler has payment allocation evidence and cannot be permanently deleted.",
  PAYMENT_OPERATION_EVIDENCE: "The bowler has payment-operation evidence, including retained or failed provider activity.",
  AUTOPAY_NOT_CANCELLED: "Cancel the bowler's active autopay consent before deleting the profile.",
  AUTOPAY_PROVIDER_ACTIVITY: "Resolve the bowler's autopay provider activity before deleting the profile.",
  AUTOPAY_PARTNER_EVIDENCE: "The bowler's autopay partner evidence is used by another bowler and must be preserved.",
  AUTOPAY_PROVIDER_EVIDENCE: "The bowler's autopay authorization and revocation history must be retained.",
  PAYMENT_PARTNER_LINK: "Unlink or retire the bowler's payment-partner link before deleting the profile.",
  LINKED_LOGIN: "Unlink or reassign the login account before deleting the bowler profile.",
  CROSS_ORGANIZATION_MEMBERSHIP: "The bowler has a roster membership in another organization and cannot be deleted until it is removed.",
  SCORE_HISTORY: "The bowler has recorded score history and cannot be permanently deleted.",
  CROSS_ORGANIZATION_PAYMENT_LINK: "The bowler has a payment-partner link in another organization and cannot be deleted.",
  DEPENDENCY_CHANGED: "The bowler's records changed while deletion was in progress. Resolve the new dependency and retry.",
};

function conflict(code: BowlerDeletionBlockerCode): BowlerDeletionConflictError {
  return new BowlerDeletionConflictError([{ code, message: blockerMessages[code] }]);
}

function bowlerIdsFromResponsibility(row: {
  mainBowlerId: number | null; substituteBowlerId: number | null; payerBowlerId: number | null;
  lineagePayerBowlerId: number | null; prizePayerBowlerId: number | null;
}): number[] {
  return [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId,
    row.lineagePayerBowlerId, row.prizePayerBowlerId]
    .filter((id): id is number => id !== null);
}

/** The existing delete-link lock protocol serializes all league-scoped rows. */
async function findTenantLeagueIds(tx: DeletionTransaction, organizationId: number): Promise<number[]> {
  const rows = await tx.select({ leagueId: leagues.id }).from(leagues)
    .where(eq(leagues.organizationId, organizationId)).orderBy(asc(leagues.id));
  return rows.map((row) => row.leagueId);
}

async function lockBowler(tx: DeletionTransaction, bowlerId: number) {
  const [row] = await tx.select().from(bowlers).where(eq(bowlers.id, bowlerId))
    .for("update", { noWait: true }).limit(1);
  if (!row) throw new BowlerDeletionNotFoundError();
  return row;
}

async function tryLockLeagueSchedule(tx: DeletionTransaction, organizationId: number, leagueId: number): Promise<void> {
  const result = await tx.execute(sql`
    SELECT pg_try_advisory_xact_lock(${organizationId}::integer, ${leagueId}::integer) AS acquired
  `);
  if (result.rows[0]?.acquired !== true) throw conflict("DEPENDENCY_CHANGED");
}

/**
 * Delete a profile only when it has no live roster, identity, or financial
 * dependency. No provider calls are made. Shared/append-only history stays
 * in place; only unused voided obligations and exclusively-owned
 * responsibility/setup rows are cleaned inside this transaction.
 */
export async function deleteUnusedBowler(bowlerId: number): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Deletion locks leagues before the bowler, matching roster materializer
      // and link deletion. The timeout bounds the known updateBowler inverse.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      const [initial] = await tx.select({ id: bowlers.id, organizationId: bowlers.organizationId })
        .from(bowlers).where(eq(bowlers.id, bowlerId)).limit(1);
      if (!initial) throw new BowlerDeletionNotFoundError();
      for (const leagueId of await findTenantLeagueIds(tx, initial.organizationId)) {
        await tryLockLeagueSchedule(tx, initial.organizationId, leagueId);
      }
      const bowler = await lockBowler(tx, bowlerId);

      const linkedUsers = await tx.select({ id: users.id }).from(users)
        .where(eq(users.bowlerId, bowlerId));
      if (linkedUsers.length) throw conflict("LINKED_LOGIN");

      const memberships = await tx.select({
        active: bowlerLeagues.active,
        organizationId: leagues.organizationId,
      }).from(bowlerLeagues).innerJoin(leagues, eq(leagues.id, bowlerLeagues.leagueId))
        .where(eq(bowlerLeagues.bowlerId, bowlerId));
      if (memberships.some((row) => row.organizationId !== bowler.organizationId)) {
        throw conflict("CROSS_ORGANIZATION_MEMBERSHIP");
      }
      if (memberships.some((row) => row.active)) throw conflict("ACTIVE_ROSTER_MEMBERSHIP");

      const scoreHistory = await tx.select({ id: scores.id }).from(scores)
        .where(eq(scores.bowlerId, bowlerId));
      if (scoreHistory.length) throw conflict("SCORE_HISTORY");

      const slots = await tx.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots)
        .where(and(eq(teamPaymentSlots.organizationId, bowler.organizationId),
          eq(teamPaymentSlots.mainBowlerId, bowlerId)));
      if (slots.length) throw conflict("ROSTER_PAYMENT_SLOT");

      const responsibilities = await tx.select().from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, bowler.organizationId),
        or(eq(occurrencePaymentResponsibilities.mainBowlerId, bowlerId),
          eq(occurrencePaymentResponsibilities.substituteBowlerId, bowlerId),
          eq(occurrencePaymentResponsibilities.payerBowlerId, bowlerId),
          eq(occurrencePaymentResponsibilities.lineagePayerBowlerId, bowlerId),
          eq(occurrencePaymentResponsibilities.prizePayerBowlerId, bowlerId)),
      ));
      if (responsibilities.some((row) => row.state === "active")) throw conflict("ACTIVE_RESPONSIBILITY");
      const exclusiveVoidedResponsibilityIds: string[] = [];
      for (const responsibility of responsibilities) {
        if (bowlerIdsFromResponsibility(responsibility).some((id) => id !== bowlerId)) {
          throw conflict("SHARED_RESPONSIBILITY_HISTORY");
        }
        if (responsibility.state === "voided") exclusiveVoidedResponsibilityIds.push(responsibility.id);
      }

      // Check every obligation under a responsibility, not just obligations
      // payer-owned by this bowler, before considering responsibility cleanup.
      const responsibilityIds = responsibilities.map((row) => row.id);
      const responsibilityObligations = responsibilityIds.length === 0 ? [] : await tx.select({
        id: paymentObligations.id, responsibilityId: paymentObligations.responsibilityId,
        payerBowlerId: paymentObligations.payerBowlerId,
      }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, bowler.organizationId),
        inArray(paymentObligations.responsibilityId, responsibilityIds),
      ));
      const responsibilityObligationIds = new Map<string, string[]>();
      for (const obligation of responsibilityObligations) {
        const ids = responsibilityObligationIds.get(obligation.responsibilityId) ?? [];
        ids.push(obligation.id);
        responsibilityObligationIds.set(obligation.responsibilityId, ids);
        if (obligation.payerBowlerId !== bowlerId) throw conflict("SHARED_RESPONSIBILITY_HISTORY");
      }

      const ownedPayments = await tx.select({ id: payments.id }).from(payments).where(and(
        eq(payments.organizationId, bowler.organizationId), eq(payments.bowlerId, bowlerId),
      ));
      if (ownedPayments.length) throw conflict("PAYMENT_EVIDENCE");

      const ownedObligations = await tx.select().from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, bowler.organizationId),
        eq(paymentObligations.payerBowlerId, bowlerId),
      ));
      const ownedObligationIds = ownedObligations.map((row) => row.id);
      const allocations = ownedObligationIds.length === 0 ? [] : await tx.select({
        id: paymentAllocations.id, obligationId: paymentAllocations.obligationId,
      }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, bowler.organizationId),
        inArray(paymentAllocations.obligationId, ownedObligationIds),
      ));
      if (allocations.length) throw conflict("PAYMENT_ALLOCATION_EVIDENCE");

      const rosterSnapshots = await tx.select({ id: paymentOperationRosterSnapshots.operationId })
        .from(paymentOperationRosterSnapshots).where(and(
          eq(paymentOperationRosterSnapshots.organizationId, bowler.organizationId),
          eq(paymentOperationRosterSnapshots.payerBowlerId, bowlerId),
        ));
      const snapshotItems = ownedObligationIds.length === 0 ? [] : await tx.select({
        id: paymentOperationRosterSnapshotItems.id, obligationId: paymentOperationRosterSnapshotItems.obligationId,
      }).from(paymentOperationRosterSnapshotItems).where(and(
        eq(paymentOperationRosterSnapshotItems.organizationId, bowler.organizationId),
        inArray(paymentOperationRosterSnapshotItems.obligationId, ownedObligationIds),
      ));
      if (rosterSnapshots.length || snapshotItems.length) throw conflict("PAYMENT_OPERATION_EVIDENCE");

      const standingParticipants = await tx.select({ id: paymentOperationStandingAutopayParticipants.id })
        .from(paymentOperationStandingAutopayParticipants).where(and(
          eq(paymentOperationStandingAutopayParticipants.organizationId, bowler.organizationId),
          or(eq(paymentOperationStandingAutopayParticipants.bowlerId, bowlerId),
            ownedObligationIds.length ? inArray(paymentOperationStandingAutopayParticipants.obligationId, ownedObligationIds) : sql`false`),
        ));
      if (standingParticipants.length) throw conflict("PAYMENT_OPERATION_EVIDENCE");

      const consents = await tx.select().from(autopayConsents).where(and(
        eq(autopayConsents.organizationId, bowler.organizationId),
        eq(autopayConsents.payerBowlerId, bowlerId),
      ));
      const consentIds = consents.map((row) => row.id);
      const consentBindings = consentIds.length === 0 ? [] : await tx.select({ id: paymentOperationStandingAutopayBindings.operationId })
        .from(paymentOperationStandingAutopayBindings).where(and(
          eq(paymentOperationStandingAutopayBindings.organizationId, bowler.organizationId),
          inArray(paymentOperationStandingAutopayBindings.consentId, consentIds),
        ));
      const preparationAttempts = consentIds.length === 0 ? [] : await tx.select({ id: standingAutopayPreparationAttempts.id })
        .from(standingAutopayPreparationAttempts).where(and(
          eq(standingAutopayPreparationAttempts.organizationId, bowler.organizationId),
          inArray(standingAutopayPreparationAttempts.consentId, consentIds),
        ));
      if (consentBindings.length) throw conflict("PAYMENT_OPERATION_EVIDENCE");
      if (preparationAttempts.length) throw conflict("AUTOPAY_PROVIDER_ACTIVITY");

      const providerEvidence = consents.some((row) =>
        row.state === "revoked" || row.state === "expired"
        || (row.state === "pending" && (
          row.providerName !== null || row.providerLocationId !== null
          || row.encryptedSourceId !== null || row.encryptedCustomerId !== null
          || row.revokedAt !== null
        )));
      if (providerEvidence) throw conflict("AUTOPAY_PROVIDER_EVIDENCE");

      // The bowler foreign keys are intentionally plain cascading references,
      // so inspect every link before narrowing to this tenant. A corrupt or
      // legacy cross-organization link must block deletion rather than be
      // silently left to cascade with the bowler row.
      const links = await tx.select().from(bowlerPaymentLinks).where(
        or(eq(bowlerPaymentLinks.bowlerAId, bowlerId), eq(bowlerPaymentLinks.bowlerBId, bowlerId)),
      );
      if (links.some((row) => row.organizationId !== bowler.organizationId)) {
        throw conflict("CROSS_ORGANIZATION_PAYMENT_LINK");
      }
      if (links.some((row) => row.status !== "retired")) throw conflict("PAYMENT_PARTNER_LINK");
      const retiredLinkIds = links.filter((row) => row.status === "retired").map((row) => row.id);
      const partnerEvidence = await tx.select({ id: autopayConsentPartners.id }).from(autopayConsentPartners).where(and(
        eq(autopayConsentPartners.organizationId, bowler.organizationId),
        or(eq(autopayConsentPartners.partnerBowlerId, bowlerId),
          consentIds.length ? inArray(autopayConsentPartners.consentId, consentIds) : sql`false`,
          retiredLinkIds.length ? inArray(autopayConsentPartners.paymentLinkId, retiredLinkIds) : sql`false`),
      ));
      if (partnerEvidence.length) throw conflict("AUTOPAY_PARTNER_EVIDENCE");
      const retiredLinkParticipants = retiredLinkIds.length === 0 ? [] : await tx.select({ id: paymentOperationStandingAutopayParticipants.id })
        .from(paymentOperationStandingAutopayParticipants).where(and(
          eq(paymentOperationStandingAutopayParticipants.organizationId, bowler.organizationId),
          inArray(paymentOperationStandingAutopayParticipants.paymentLinkId, retiredLinkIds),
        ));
      if (retiredLinkParticipants.length) throw conflict("PAYMENT_OPERATION_EVIDENCE");
      if (consents.some((row) => row.state === "active")) throw conflict("AUTOPAY_NOT_CANCELLED");

      const operationItemObligationIds = new Set(snapshotItems.map((row) => row.obligationId));
      const allocationObligationIds = new Set(allocations.map((row) => row.obligationId));
      const cleanableObligationIds: string[] = [];
      for (const obligation of ownedObligations) {
        if (obligation.state !== "voided") throw conflict("OPEN_PAYMENT_OBLIGATION");
        if (!operationItemObligationIds.has(obligation.id) && !allocationObligationIds.has(obligation.id)) {
          cleanableObligationIds.push(obligation.id);
        }
      }
      const cleanableObligationSet = new Set(cleanableObligationIds);
      const cleanableResponsibilityIds = exclusiveVoidedResponsibilityIds.filter((id) =>
        (responsibilityObligationIds.get(id) ?? []).every((obligationId) => cleanableObligationSet.has(obligationId)));

      // This is the existing transaction-local append-only teardown marker,
      // scoped to the proven-unused rows above; it is never caller-controlled.
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      if (cleanableObligationIds.length) await tx.delete(paymentObligations).where(and(
        eq(paymentObligations.organizationId, bowler.organizationId),
        inArray(paymentObligations.id, cleanableObligationIds),
      ));
      if (cleanableResponsibilityIds.length) await tx.delete(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, bowler.organizationId),
        inArray(occurrencePaymentResponsibilities.id, cleanableResponsibilityIds),
      ));
      const cleanableConsentIds = consents.filter((row) => row.state === "pending").map((row) => row.id);
      if (cleanableConsentIds.length) await tx.delete(autopayConsents).where(and(
        eq(autopayConsents.organizationId, bowler.organizationId), inArray(autopayConsents.id, cleanableConsentIds),
      ));
      if (retiredLinkIds.length) await tx.delete(bowlerPaymentLinks).where(and(
        eq(bowlerPaymentLinks.organizationId, bowler.organizationId), inArray(bowlerPaymentLinks.id, retiredLinkIds),
      ));
      const [deleted] = await tx.delete(bowlers).where(and(
        eq(bowlers.id, bowlerId), eq(bowlers.organizationId, bowler.organizationId),
      )).returning({ id: bowlers.id });
      if (!deleted) throw new BowlerDeletionNotFoundError();
    });
  } catch (error) {
    // Only expected dependency/lock races become retryable conflicts. Keep
    // all unrelated database errors on the generic route error path.
    const code = getPgErrorCode(error);
    if (code === "23503" || code === "40P01" || code === "55P03") throw conflict("DEPENDENCY_CHANGED");
    throw error;
  }
}
