import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerPaymentLinks,
  paymentOperationRosterSnapshotItems,
  paymentOperationStandingAutopayBindings,
  paymentOperations,
  leagues,
  type BowlerPaymentLink,
  type InsertBowlerPaymentLink,
  type LinkStatus,
} from "@shared/schema";
import { lockLeagueSchedule } from "./league-schedule-lock.js";

/**
 * Pairs are stored canonically with `bowlerAId < bowlerBId` so the
 * unique-pair index is direction-agnostic. Helpers normalize callers'
 * inputs through `pair()` before reading or writing.
 */
function pair(a: number, b: number): { a: number; b: number } {
  if (a === b) {
    throw new Error("bowler cannot link to itself");
  }
  return a < b ? { a, b } : { a: b, b: a };
}

export async function createLinkInvite(input: {
  inviterBowlerId: number;
  inviteeBowlerId: number;
  organizationId: number;
  createdByUserId: number | null;
}): Promise<BowlerPaymentLink> {
  const { a, b } = pair(input.inviterBowlerId, input.inviteeBowlerId);
  const insert: InsertBowlerPaymentLink = {
    bowlerAId: a,
    bowlerBId: b,
    organizationId: input.organizationId,
    status: "pending",
    createdByUserId: input.createdByUserId,
  };
  const [row] = await db.insert(bowlerPaymentLinks).values(insert).returning();
  return row;
}

export async function createAcceptedLink(input: {
  bowlerAId: number;
  bowlerBId: number;
  organizationId: number;
  createdByUserId: number | null;
}): Promise<BowlerPaymentLink> {
  const { a, b } = pair(input.bowlerAId, input.bowlerBId);
  const [row] = await db
    .insert(bowlerPaymentLinks)
    .values({
      bowlerAId: a,
      bowlerBId: b,
      organizationId: input.organizationId,
      status: "accepted",
      createdByUserId: input.createdByUserId,
    })
    .returning();
  if (row && row.status === "accepted" && !row.respondedAt) {
    const [updated] = await db
      .update(bowlerPaymentLinks)
      .set({ respondedAt: new Date().toISOString() })
      .where(eq(bowlerPaymentLinks.id, row.id))
      .returning();
    return updated;
  }
  return row;
}

export async function getLinkBetween(
  bowlerAId: number,
  bowlerBId: number,
): Promise<BowlerPaymentLink | undefined> {
  const { a, b } = pair(bowlerAId, bowlerBId);
  const [row] = await db
    .select()
    .from(bowlerPaymentLinks)
    .where(
      and(
        eq(bowlerPaymentLinks.bowlerAId, a),
        eq(bowlerPaymentLinks.bowlerBId, b),
        inArray(bowlerPaymentLinks.status, ["pending", "accepted"] as const),
      ),
    )
    .limit(1);
  return row;
}

export async function getLinkById(id: number): Promise<BowlerPaymentLink | undefined> {
  const [row] = await db
    .select()
    .from(bowlerPaymentLinks)
    .where(eq(bowlerPaymentLinks.id, id))
    .limit(1);
  return row;
}

export async function listLinksForBowler(
  bowlerId: number,
  opts?: { status?: LinkStatus },
): Promise<BowlerPaymentLink[]> {
  const conditions = [
    or(eq(bowlerPaymentLinks.bowlerAId, bowlerId), eq(bowlerPaymentLinks.bowlerBId, bowlerId)),
  ];
  if (opts?.status) {
    conditions.push(eq(bowlerPaymentLinks.status, opts.status));
  }
  return db
    .select()
    .from(bowlerPaymentLinks)
    .where(and(...conditions));
}

export async function listLinksForOrg(
  organizationId: number,
  opts?: { status?: LinkStatus },
): Promise<BowlerPaymentLink[]> {
  const conditions = [eq(bowlerPaymentLinks.organizationId, organizationId)];
  if (opts?.status) {
    conditions.push(eq(bowlerPaymentLinks.status, opts.status));
  }
  return db
    .select()
    .from(bowlerPaymentLinks)
    .where(and(...conditions));
}

export async function acceptLink(id: number): Promise<BowlerPaymentLink | undefined> {
  const [row] = await db
    .update(bowlerPaymentLinks)
    .set({ status: "accepted", respondedAt: new Date().toISOString() })
    .where(and(eq(bowlerPaymentLinks.id, id), eq(bowlerPaymentLinks.status, "pending")))
    .returning();
  return row;
}

export async function deleteLink(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Discover without a row lock first. Every writer that can activate or
    // prepare standing autopay acquires the league advisory lock before it
    // locks link/consent evidence; taking the link lock first here would
    // invert that order and permit an unlink/cutoff deadlock.
    const [discoveredLink] = await tx.select().from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.id, id), inArray(bowlerPaymentLinks.status, ["pending", "accepted"] as const))).limit(1);
    if (!discoveredLink) return;
    // A payment link is organization-scoped while consent evidence is
    // league-scoped. Lock every league in the tenant, not only leagues that
    // happened to have a consent at discovery time; activation may be racing
    // this unlink and can add a consent in an otherwise empty league.
    const tenantLeagues = await tx.select({ id: leagues.id }).from(leagues).where(eq(leagues.organizationId, discoveredLink.organizationId));
    const leagueIds = tenantLeagues.map((row) => row.id).sort((a, b) => a - b);
    for (const leagueId of leagueIds) {
      await lockLeagueSchedule(tx, discoveredLink.organizationId, leagueId);
    }

    // Re-read all evidence after the canonical locks. A concurrent activation
    // or cutoff either observes the retired link or waits behind this tx;
    // neither can resurrect a consent after the final status update.
    const [link] = await tx.select().from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.id, id), inArray(bowlerPaymentLinks.status, ["pending", "accepted"] as const))).limit(1).for("update");
    if (!link) return;
    const consents = await tx.select({ consent: autopayConsents }).from(autopayConsents).innerJoin(autopayConsentPartners, and(
      eq(autopayConsentPartners.consentId, autopayConsents.id), eq(autopayConsentPartners.consentVersion, autopayConsents.consentVersion), eq(autopayConsentPartners.paymentLinkId, link.id), eq(autopayConsentPartners.organizationId, link.organizationId), eq(autopayConsentPartners.leagueId, autopayConsents.leagueId),
    )).where(and(eq(autopayConsents.organizationId, link.organizationId), eq(autopayConsents.state, "active")));
    for (const leagueId of leagueIds) {
      const affected = consents.filter((row) => row.consent.leagueId === leagueId);
      for (const { consent } of affected) {
        const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, and(
          eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id), eq(paymentOperationStandingAutopayBindings.consentId, consent.id), eq(paymentOperationStandingAutopayBindings.consentVersion, consent.consentVersion), eq(paymentOperationStandingAutopayBindings.organizationId, link.organizationId), eq(paymentOperationStandingAutopayBindings.leagueId, leagueId),
        )).where(and(eq(paymentOperations.organizationId, link.organizationId), eq(paymentOperations.leagueId, leagueId), eq(paymentOperations.operationType, "standing_autopay_charge"))).for("update");
        for (const { operation } of operations) {
          if (["pending", "leased", "retry_scheduled"].includes(operation.status) && operation.dispatchClaimedAt === null && operation.providerObjectId === null) {
            await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, link.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, leagueId), eq(paymentOperationRosterSnapshotItems.operationId, operation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
            const canceledAt = new Date().toISOString();
            await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, errorClassification: null, errorCode: null, completedAt: canceledAt, updatedAt: canceledAt }).where(and(eq(paymentOperations.organizationId, link.organizationId), eq(paymentOperations.id, operation.id)));
          } else if (["pending", "leased", "provider_unknown", "retry_scheduled"].includes(operation.status) && (operation.dispatchClaimedAt !== null || operation.providerObjectId !== null || operation.status === "provider_unknown")) {
            const reconciledAt = new Date().toISOString();
            await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, errorClassification: "provider_unknown", errorCode: "PARTNER_LINK_RETIRED_AFTER_DISPATCH", completedAt: reconciledAt, updatedAt: reconciledAt }).where(and(eq(paymentOperations.organizationId, link.organizationId), eq(paymentOperations.id, operation.id)));
          }
        }
        await tx.update(autopayConsents).set({ state: "revoked", revokedAt: new Date().toISOString() }).where(and(eq(autopayConsents.id, consent.id), eq(autopayConsents.state, "active")));
      }
    }
    await tx.update(bowlerPaymentLinks).set({ status: "retired", respondedAt: new Date().toISOString() }).where(and(eq(bowlerPaymentLinks.id, id), inArray(bowlerPaymentLinks.status, ["pending", "accepted"] as const)));
  });
}

/**
 * Scrub each bowler's id from the OTHER bowler's combined-autopay
 * `additionalBowlerIds` arrays when a link is removed. The UPDATE is
 * org-scoped at write time by joining against leagues belonging to the
 * link's organization.
 */
export async function pruneSchedulesForRemovedLink(
  link: Pick<BowlerPaymentLink, "bowlerAId" | "bowlerBId" | "organizationId">,
): Promise<{ id: number; bowlerId: number; removedPartnerId: number }[]> {
  const { paymentSchedules, leagues } = await import("@shared/schema");
  const affected: { id: number; bowlerId: number; removedPartnerId: number }[] = [];

  const orgLeagues = await db
    .select({ id: leagues.id, organizationId: leagues.organizationId })
    .from(leagues)
    .where(and(
      eq(leagues.organizationId, link.organizationId),
      eq(leagues.active, true),
      eq(leagues.scheduleAuthority, "canonical"),
    ));
  if (orgLeagues.length === 0) return affected;

  const directions: Array<[number, number]> = [
    [link.bowlerAId, link.bowlerBId],
    [link.bowlerBId, link.bowlerAId],
  ];
  for (const league of orgLeagues) {
    await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, league.organizationId, league.id);
      const [current] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority })
        .from(leagues).where(and(eq(leagues.id, league.id), eq(leagues.organizationId, link.organizationId))).limit(1).for("share");
      if (!current?.active || current.scheduleAuthority !== "canonical") return;
      for (const [ownerBowlerId, partnerBowlerId] of directions) {
        const updated = await tx
          .update(paymentSchedules)
          .set({
            additionalBowlerIds: sql`array_remove(${paymentSchedules.additionalBowlerIds}, ${partnerBowlerId})`,
          })
          .where(
            and(
              eq(paymentSchedules.bowlerId, ownerBowlerId),
              eq(paymentSchedules.leagueId, league.id),
              sql`${partnerBowlerId} = ANY(${paymentSchedules.additionalBowlerIds})`,
            ),
          )
          .returning({ id: paymentSchedules.id });
        for (const row of updated) {
          affected.push({ id: row.id, bowlerId: ownerBowlerId, removedPartnerId: partnerBowlerId });
        }
      }
    });
  }
  return affected;
}

export async function arePartners(
  bowlerAId: number,
  bowlerBId: number,
  organizationId: number,
): Promise<boolean> {
  if (bowlerAId === bowlerBId) return true;
  const link = await getLinkBetween(bowlerAId, bowlerBId);
  return !!link && link.status === "accepted" && link.organizationId === organizationId;
}

export async function getAcceptedPartnerBowlerIds(
  bowlerId: number,
  organizationId: number,
): Promise<number[]> {
  const rows = await db
    .select({ a: bowlerPaymentLinks.bowlerAId, b: bowlerPaymentLinks.bowlerBId })
    .from(bowlerPaymentLinks)
    .where(
      and(
        eq(bowlerPaymentLinks.organizationId, organizationId),
        eq(bowlerPaymentLinks.status, "accepted"),
        or(eq(bowlerPaymentLinks.bowlerAId, bowlerId), eq(bowlerPaymentLinks.bowlerBId, bowlerId)),
      ),
    );
  return rows.map((r) => (r.a === bowlerId ? r.b : r.a));
}
