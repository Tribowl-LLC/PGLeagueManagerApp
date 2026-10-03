import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerPaymentLinks,
  bowlers,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  payments,
  teams,
  users,
} from "@shared/schema";
import { readLegacyFundingAuthorizationInTransaction } from "../../server/services/owned-payment-ledger";
import { canonicalizePaymentOperationInput } from "../../server/services/payment-operation-idempotency";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let payerBowlerId: number;
let partnerBowlerId: number;
let occurrenceId: string;
let occurrenceIds: string[];
let teamIds: number[];
let consentId: string;
const consentVersion = 1;

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: "Legacy Standing Proof Fixture",
    slug: `legacy-standing-proof-${suffix}`,
  }).returning({ id: organizations.id });
  organizationId = organization.id;

  const [location] = await db.insert(locations).values({ organizationId, name: "Legacy Proof Location" })
    .returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Legacy Standing Proof League",
    organizationId,
    locationId,
    payingLineupSize: 3,
    weeklyFee: 500,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;

  const [actor] = await db.insert(users).values({
    email: `legacy-standing-proof-${suffix}@example.test`,
    password: "fixture-password-hash",
    name: "Legacy Proof Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [payer] = await db.insert(bowlers).values({ organizationId, name: "Standing Consent Payer" })
    .returning({ id: bowlers.id });
  payerBowlerId = payer.id;
  const [partner] = await db.insert(bowlers).values({ organizationId, name: "Standing Partner Recipient" })
    .returning({ id: bowlers.id });
  partnerBowlerId = partner.id;

  teamIds = [];
  for (const number of [1, 2, 3]) {
    const [team] = await db.insert(teams).values({ name: `Proof Team ${number}`, number, leagueId })
      .returning({ id: teams.id });
    teamIds.push(team.id);
  }
  occurrenceIds = [];
  const dates = ["2038-02-01", "2038-02-08", "2038-02-15"];
  for (const [index, date] of dates.entries()) {
    const commandId = randomUUID();
    const instant = `${date}T19:00:00.000Z`;
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "publish",
      idempotencyKey: `legacy-standing-proof-publish-${suffix}-${index}`,
      requestFingerprint: `legacy-standing-proof-publish-${suffix}-${index}`,
    });
    const [occurrence] = await db.insert(leagueOccurrences).values({
      organizationId,
      leagueId,
      locationId,
      generationKey: `legacy-standing-proof-occurrence-${suffix}-${index}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "published",
      authoritativeLocalDate: date,
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      startAt: instant,
      selectedUtcOffsetMinutes: 0,
      foldResolution: "unambiguous",
      resolverVersion: "legacy-proof-test",
      plannedOrdinal: index + 1,
      competitionNumber: index + 1,
      competitive: true,
      countsInStandings: true,
      publishedAt: instant,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    }).returning({ id: leagueOccurrences.id });
    occurrenceIds.push(occurrence.id);
  }
  const firstOccurrenceId = occurrenceIds[0];
  if (!firstOccurrenceId) throw new Error("legacy proof schedule did not create its first occurrence");
  occurrenceId = firstOccurrenceId;
  const instant = "2038-02-01T19:00:00.000Z";

  const [consent] = await db.insert(autopayConsents).values({
    organizationId,
    leagueId,
    payerBowlerId,
    consentVersion,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${"1".repeat(64)}`,
    providerName: "square",
    providerLocationId: "square-proof-location",
    encryptedSourceId: "encrypted-proof-source",
    encryptedCustomerId: "encrypted-proof-customer",
    createdByUserId: actorUserId,
    activatedAt: instant,
    createdAt: instant,
  }).returning({ id: autopayConsents.id });
  consentId = consent.id;

  const respondedAt = "2038-01-15T12:00:00.000Z";
  const [link] = await db.insert(bowlerPaymentLinks).values({
    bowlerAId: Math.min(payerBowlerId, partnerBowlerId),
    bowlerBId: Math.max(payerBowlerId, partnerBowlerId),
    organizationId,
    status: "accepted",
    createdByUserId: actorUserId,
    invitedAt: "2038-01-14T12:00:00.000Z",
    respondedAt,
  }).returning();
  const linkFingerprint = `lvpartnerlink:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  })).digest("hex")}`;
  await db.insert(autopayConsentPartners).values({
    organizationId,
    leagueId,
    consentId,
    consentVersion,
    partnerBowlerId,
    paymentLinkId: link.id,
    linkFingerprint,
  });
});

async function createStandingTender(input: {
  suffix: string;
  recipients: Array<{ bowlerId: number; role: "payer" | "partner"; paymentLinkId: number | null; linkFingerprint: string | null }>;
}) {
  const operationId = randomUUID();
  const now = "2038-02-01T20:00:00.000Z";
  const cutoffAt = "2038-02-01T19:00:00.000Z";
  const providerPaymentId = `legacy-standing-proof-${operationId}`;
  const snapshotFingerprint = `lvstandingcutoff:v1:${createHash("sha256").update(input.suffix).digest("hex")}`;
  const rows = [] as Array<{ allocationIndex: number; obligationId: string; payerBowlerId: number; amountMinor: number }>;
  return db.transaction(async (tx) => {
    for (const [allocationIndex, recipient] of input.recipients.entries()) {
      const occurrenceIdForRecipient = occurrenceIds[allocationIndex];
      const teamIdForRecipient = teamIds[allocationIndex];
      if (!occurrenceIdForRecipient || teamIdForRecipient === undefined) {
        throw new Error("standing-proof recipient does not have a matching schedule occurrence and team");
      }
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
        organizationId,
        leagueId,
        occurrenceId: occurrenceIdForRecipient,
        teamId: teamIdForRecipient,
        responsibilityKind: "worksheet",
        worksheetFeeComponent: "full",
        payerBowlerId: recipient.bowlerId,
        amountMinor: 500,
        currency: "USD",
        dueAt: `${["2038-02-01", "2038-02-08", "2038-02-15"][allocationIndex]}T19:00:00.000Z`,
        pastDueAt: `${["2038-02-08", "2038-02-15", "2038-02-22"][allocationIndex]}T19:00:00.000Z`,
        recordedByUserId: actorUserId,
      }).returning({ id: occurrencePaymentResponsibilities.id });
      const dueAt = `${["2038-02-01", "2038-02-08", "2038-02-15"][allocationIndex]}T19:00:00.000Z`;
      const pastDueAt = `${["2038-02-08", "2038-02-15", "2038-02-22"][allocationIndex]}T19:00:00.000Z`;
      const [obligation] = await tx.insert(paymentObligations).values({
      organizationId,
      leagueId,
      occurrenceId: occurrenceIdForRecipient,
      responsibilityId: responsibility.id,
      component: "full",
      payerBowlerId: recipient.bowlerId,
      amountMinor: 500,
      currency: "USD",
      dueAt,
      pastDueAt,
      state: "open",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
      rows.push({ allocationIndex, obligationId: obligation.id, payerBowlerId: recipient.bowlerId, amountMinor: 500 });
    }
    const amountMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);

  await tx.insert(paymentOperations).values({
    id: operationId,
    organizationId,
    leagueId,
    authorizingUserId: actorUserId,
    operationType: "standing_autopay_charge",
    targetKey: `legacy-standing-proof-${operationId}`,
    triggerOccurrenceId: occurrenceId,
    amountMinor,
    currency: "USD",
    requestFingerprint: `lvpayreq:v1:${"2".repeat(64)}`,
    providerIdempotencyKey: `legacy-standing-${operationId}`.slice(0, 45),
    providerName: "square",
    providerObjectId: providerPaymentId,
    status: "succeeded",
    attemptCount: 1,
    nextAttemptAt: null,
    dispatchClaimedAt: now,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(paymentOperationRosterSnapshots).values({
    operationId,
    organizationId,
    leagueId,
    snapshotVersion: 2,
    snapshotKind: "standing_autopay",
    collectionMode: "weekly",
    cutoffAt,
    amountMinor,
    currency: "USD",
    obligations: rows,
    locationId: null,
    providerLocationId: null,
    payerBowlerId: null,
    requestKind: null,
    encryptedSourceId: null,
    encryptedCustomerId: null,
    encryptedBuyerEmail: null,
    storeCard: false,
    sourceKind: null,
    quoteFingerprint: null,
    lineItems: [],
    partnerEvidence: null,
    snapshotFingerprint,
    createdAt: now,
  });
  await tx.insert(paymentOperationStandingAutopayBindings).values({
    operationId,
    organizationId,
    leagueId,
    consentId,
    consentVersion,
    providerName: "square",
    providerLocationId: "square-proof-location",
    triggerOccurrenceId: occurrenceId,
    pairedOccurrenceId: null,
    collectionGroupId: null,
    collectionGroupRevision: null,
    collectionGroupFingerprint: null,
    triggerMemberId: null,
    pairedMemberId: null,
    cutoffAt,
    collectionMode: "weekly",
    evidenceFingerprint: snapshotFingerprint,
    createdAt: now,
  });
  await tx.insert(paymentOperationRosterSnapshotItems).values(rows.map((row) => ({
    operationId,
    organizationId,
    leagueId,
    obligationId: row.obligationId,
    allocationIndex: row.allocationIndex,
    amountMinor: row.amountMinor,
    state: "finalized" as const,
    createdAt: now,
  })));
    const participants = input.recipients.map((recipient, allocationIndex) => {
      const row = rows[allocationIndex];
      if (!row) throw new Error("standing-proof recipient has no matching immutable snapshot row");
      return {
        operationId,
        organizationId,
        leagueId,
        allocationIndex,
        obligationId: row.obligationId,
        bowlerId: recipient.bowlerId,
        role: recipient.role,
        paymentLinkId: recipient.paymentLinkId,
        linkFingerprint: recipient.linkFingerprint,
        consentVersion,
        createdAt: now,
      };
    });
    await tx.insert(paymentOperationStandingAutopayParticipants).values(participants);
  const [payment] = await tx.insert(payments).values({
    organizationId,
    leagueId,
    bowlerId: payerBowlerId,
    amount: amountMinor,
    currency: "USD",
    status: "paid",
    type: "square",
    providerPaymentId,
    paymentOperationId: operationId,
    paidByUserId: actorUserId,
    createdAt: now,
  }).returning({ id: payments.id });
  await tx.insert(paymentAllocations).values(rows.map((row) => ({
    organizationId,
    leagueId,
    paymentId: payment.id,
    obligationId: row.obligationId,
    amountMinor: row.amountMinor,
    currency: "USD",
    recordedByUserId: actorUserId,
    createdAt: now,
  })));
    return { operationId, paymentId: payment.id, rows };
  });
}

describe("legacy standing source authorization", () => {
  it("retains repeated payer recipient rows from a standing split or double-pay snapshot", async () => {
    const tender = await createStandingTender({
      suffix: "multiple-payer-items",
      recipients: [
        { bowlerId: payerBowlerId, role: "payer", paymentLinkId: null, linkFingerprint: null },
        { bowlerId: payerBowlerId, role: "payer", paymentLinkId: null, linkFingerprint: null },
      ],
    });
    const result = await db.transaction((tx) => readLegacyFundingAuthorizationInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: tender.paymentId,
    }), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(result.portions).toMatchObject([{
      creditedBowlerId: payerBowlerId,
      amountMinor: 1_000,
      authorizationKind: "legacy_provider_snapshot",
      authorizationOperationId: tender.operationId,
      authorizationItemCount: 2,
    }]);
  });

  it("proves a standing partner-only capture from the persisted consent partner, with zero payer rows", async () => {
    const [partnerEvidence] = await db.select({
      paymentLinkId: autopayConsentPartners.paymentLinkId,
      linkFingerprint: autopayConsentPartners.linkFingerprint,
    }).from(autopayConsentPartners).where(and(
      eq(autopayConsentPartners.organizationId, organizationId),
      eq(autopayConsentPartners.leagueId, leagueId),
      eq(autopayConsentPartners.consentId, consentId),
      eq(autopayConsentPartners.partnerBowlerId, partnerBowlerId),
    )).limit(1);
    if (!partnerEvidence) throw new Error("fixture consent partner evidence missing");
    const tender = await createStandingTender({
      suffix: "partner-only-capture",
      recipients: [{
        bowlerId: partnerBowlerId,
        role: "partner",
        paymentLinkId: partnerEvidence.paymentLinkId,
        linkFingerprint: partnerEvidence.linkFingerprint,
      }],
    });
    const result = await db.transaction((tx) => readLegacyFundingAuthorizationInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: tender.paymentId,
    }), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(result.portions).toMatchObject([{
      creditedBowlerId: partnerBowlerId,
      amountMinor: 500,
      authorizationKind: "legacy_provider_snapshot",
      authorizationOperationId: tender.operationId,
      authorizationItemCount: 1,
    }]);
  });
});
