/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/consistent-type-assertions */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerLeagues,
  bowlerPaymentLinks,
  bowlers,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  financialCommands,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocations,
  paymentObligations,
  payments,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  teamPaymentSlots,
  teams,
  users,
  webhookEvents,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { archiveLeague } from "../../server/storage/leagues";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { deleteLink } from "../../server/storage/bowler-payment-links";
import { encrypt } from "../../server/utils/crypto";
import { PaymentProviderError } from "../../server/services/payment-errors";
import { buildCanonicalScheduleCommandFingerprint, cancelOccurrence, restoreCancelledOccurrence } from "../../server/services/canonical-occurrence-transactions";
import { readCanonicalPaymentReport } from "../../server/services/roster-payment-archive-report";
import { updateBowlerLeague } from "../../server/storage/bowlers";
import { finalizePaymentOperationSuccess, getNextStandingAutopayWake, recordPaymentOperationActionRequired, recordPaymentOperationProviderUnknown } from "../../server/storage/payment-operations";
import { canonicalizePaymentOperationInput } from "../../server/services/payment-operation-idempotency";

// This suite deliberately enables only the standing runtime in the isolated
// test process. It never supplies provider credentials and never calls a
// provider; preparation stops after the committed ledger/snapshot boundary.
process.env.SCHEDULED_PAYMENT_EXECUTION_MODE = "ledger_execute";
process.env.ROSTER_STANDING_AUTOPAY_ENABLED = "true";

vi.mock("../../server/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/config")>();
  return { ...actual, scheduledPaymentExecutionMode: "ledger_execute", rosterStandingAutopayEnabled: true };
});

const db = getTestDb();
const standingProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../../server/services/payment-provider-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/services/payment-provider-factory.js")>();
  return { ...actual, getPaymentProvider: standingProviderMock };
});
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `standing-autopay-postgres-${suffix}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let teamId: number;
let actorUserId: number;
let payerBowlerId: number;
let partnerBowlerId: number;
let occurrenceOrdinal = 0;

const fp = (prefix: string, fill: string) => `${prefix}${/^[0-9a-f]$/i.test(fill.slice(0, 1)) ? fill.slice(0, 1) : "a".repeat(1)}${"a".repeat(63)}`;
const uniqueFp = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
const partnerLinkFp = (link: { id: number; bowlerAId: number; bowlerBId: number; organizationId: number; status: string; respondedAt: string | null }) => `lvpartnerlink:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
  id: link.id,
  bowlerAId: link.bowlerAId,
  bowlerBId: link.bowlerBId,
  organizationId: link.organizationId,
  status: link.status,
  respondedAt: link.respondedAt,
})).digest("hex")}`;

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  for (const row of leftovers) await deleteOrganization(row.id);

  const [organization] = await db.insert(organizations).values({ name: "Standing Autopay PG Fixture", slug }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Standing Autopay Location" }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Standing Autopay League",
    organizationId,
    locationId,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    seasonStart: "2039-01-01T00:00:00.000Z",
    seasonEnd: "2039-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [user] = await db.insert(users).values({
    email: `standing-autopay-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Standing Autopay Payer",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = user.id;
  const [team] = await db.insert(teams).values({ name: "Standing Autopay Team", number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [payer] = await db.insert(bowlers).values({ name: "Standing Payer", organizationId, paymentCustomerId: "customer-fixture" }).returning({ id: bowlers.id });
  payerBowlerId = payer.id;
  const [payerUser] = await db.insert(users).values({
    email: `standing-autopay-payer-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Standing Autopay Payer Account",
    role: "user",
    organizationId,
  }).returning({ id: users.id });
  await db.update(users).set({ bowlerId: payerBowlerId }).where(eq(users.id, payerUser.id));
  const [partner] = await db.insert(bowlers).values({ name: "Standing Partner", organizationId, paymentCustomerId: "partner-customer" }).returning({ id: bowlers.id });
  partnerBowlerId = partner.id;
  await db.insert(bowlerLeagues).values([
    { bowlerId: payerBowlerId, leagueId, teamId, active: true },
    { bowlerId: partnerBowlerId, leagueId, teamId, active: true },
  ]);
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: payerBowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

async function publishOccurrence(startAt: string) {
  occurrenceOrdinal += 1;
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `standing-publish-${suffix}-${randomUUID()}`,
    requestFingerprint: `standing-publish-fingerprint-${randomUUID()}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    id: randomUUID(),
    organizationId,
    leagueId,
    locationId,
    generationKey: `standing-occurrence-${suffix}-${occurrenceOrdinal}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: startAt.slice(0, 10),
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "standing-autopay-test",
    plannedOrdinal: occurrenceOrdinal,
    competitionNumber: occurrenceOrdinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning();
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId: occurrence.id, actorUserId });
  });
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.state, "active"),
    eq(occurrencePaymentResponsibilities.payerBowlerId, payerBowlerId),
  ));
  if (!responsibility) throw new Error("standing fixture responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(eq(paymentObligations.responsibilityId, responsibility.id));
  if (!obligation) throw new Error("standing fixture obligation was not materialized");
  return { occurrence, responsibility, obligation, commandId };
}

async function insertConsent(input: { version: number; activatedAt: string; state?: "active" | "revoked" }) {
  if (input.state !== "revoked") {
    await db.update(autopayConsents).set({ state: "revoked", revokedAt: "2039-01-01T00:00:00.000Z" }).where(and(
      eq(autopayConsents.organizationId, organizationId),
      eq(autopayConsents.leagueId, leagueId),
      eq(autopayConsents.payerBowlerId, payerBowlerId),
      eq(autopayConsents.state, "active"),
    ));
  }
  const [consent] = await db.insert(autopayConsents).values({
    id: randomUUID(),
    organizationId,
    leagueId,
    payerBowlerId,
    consentVersion: input.version,
    state: input.state ?? "active",
    paymentMode: "weekly",
    consentFingerprint: uniqueFp("lvstandingconsent:v1:"),
    providerName: "square",
    providerLocationId: "square-location-fixture",
    encryptedSourceId: encrypt("source-fixture"),
    encryptedCustomerId: encrypt("customer-fixture"),
    createdByUserId: actorUserId,
    activatedAt: input.activatedAt,
    revokedAt: input.state === "revoked" ? "2039-01-30T00:00:00.000Z" : null,
  }).returning();
  return consent;
}

async function createDoublePayGroup(trigger: Awaited<ReturnType<typeof publishOccurrence>>, paired: Awaited<ReturnType<typeof publishOccurrence>>) {
  const generationCommandId = randomUUID();
  const generationRunId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: generationCommandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `standing-group-publish-${suffix}-${randomUUID()}`,
    requestFingerprint: `standing-group-fingerprint-${suffix}-${randomUUID()}`,
  });
  await db.insert(leagueOccurrenceGenerationRuns).values({
    id: generationRunId,
    organizationId,
    leagueId,
    originatingCommandId: generationCommandId,
    generatorVersion: "standing-autopay-test",
    inputFingerprint: `standing-group-input-${suffix}-${randomUUID()}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { source: "standing-autopay-test" },
    rangeStartDate: trigger.occurrence.authoritativeLocalDate,
    rangeEndDate: paired.occurrence.authoritativeLocalDate,
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 2,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "generated",
  });
  await db.update(leagueOccurrences).set({ generationRunId }).where(inArray(leagueOccurrences.id, [trigger.occurrence.id, paired.occurrence.id]));
  const triggerTermId = randomUUID();
  const pairedTermId = randomUUID();
  const termOrdinal = occurrenceOrdinal * 2;
  await db.insert(leagueOccurrenceBillingTerms).values([
    { id: triggerTermId, organizationId, leagueId, occurrenceId: trigger.occurrence.id, purpose: "league_weekly_fee", obligationPolicy: "eligible_bowlers", defaultAmountMinor: 2_000, currency: "USD", billingOrdinal: termOrdinal, version: 1, state: "published", publishedAt: trigger.occurrence.startAt, publishedByUserId: actorUserId, publicationCommandId: generationCommandId },
    { id: pairedTermId, organizationId, leagueId, occurrenceId: paired.occurrence.id, purpose: "league_weekly_fee", obligationPolicy: "eligible_bowlers", defaultAmountMinor: 2_000, currency: "USD", billingOrdinal: termOrdinal + 1, version: 1, state: "published", publishedAt: paired.occurrence.startAt, publishedByUserId: actorUserId, publicationCommandId: generationCommandId },
  ]);
  const groupId = randomUUID();
  const groupFingerprint = uniqueFp("lvcollectiongroup:v1:");
  await db.insert(canonicalCollectionGroups).values({
    id: groupId,
    organizationId,
    leagueId,
    generationRunId,
    sourceScheduleRevision: 1,
    kind: "double_pay",
    state: "published",
    groupOrdinal: occurrenceOrdinal,
    triggerLocalDate: trigger.occurrence.authoritativeLocalDate,
    pairedLocalDate: paired.occurrence.authoritativeLocalDate,
    contractVersion: "standing-autopay-test",
    fingerprintVersion: "v1",
    fingerprint: groupFingerprint,
    currentRevision: 1,
    publishedAt: trigger.occurrence.startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: generationCommandId,
  });
  await db.insert(canonicalCollectionGroupMembers).values([
    { id: randomUUID(), organizationId, leagueId, groupId, generationRunId, occurrenceId: trigger.occurrence.id, billingTermId: triggerTermId, role: "trigger", memberOrdinal: 1, localDate: trigger.occurrence.authoritativeLocalDate, billingOrdinal: 1, amountMinor: 2_000, currency: "USD", active: true, currentRevision: 1 },
    { id: randomUUID(), organizationId, leagueId, groupId, generationRunId, occurrenceId: paired.occurrence.id, billingTermId: pairedTermId, role: "paired", memberOrdinal: 2, localDate: paired.occurrence.authoritativeLocalDate, billingOrdinal: 2, amountMinor: 2_000, currency: "USD", active: true, currentRevision: 1 },
  ]);
  return groupId;
}

describe("standing automatic payments on migrated PostgreSQL", () => {
  it("does not catch up pre-consent debt, advances a cutoff once, and preserves provider location evidence", async () => {
    const beforeConsent = await publishOccurrence("2039-01-01T19:00:00.000Z");
    const afterConsent = await publishOccurrence("2039-01-08T19:00:00.000Z");
    const consent = await insertConsent({ version: 1, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff, quoteStandingAutopay } = await import("../../server/services/roster-standing-autopay");

    const preConsentResult = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: beforeConsent.occurrence.startAt });
    expect(preConsentResult).toBeUndefined();
    const noOpCommands = await db.select().from(financialCommands).where(and(
      eq(financialCommands.organizationId, organizationId),
      eq(financialCommands.leagueId, leagueId),
      eq(financialCommands.commandType, "standing_autopay_cutoff"),
    ));
    expect(noOpCommands).toMatchObject([{ state: "applied", result: { kind: "no_op" } }]);
    const quote = await quoteStandingAutopay({ organizationId, leagueId, payerBowlerId });
    expect(quote.cutoffAt).toBe(afterConsent.occurrence.startAt);
    expect(quote.amountMinor).toBe(afterConsent.obligation.amountMinor);
    expect(quote.obligations.map((row) => row.occurrenceId)).toEqual([afterConsent.occurrence.id]);

    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: afterConsent.occurrence.startAt });
    expect(operation).toMatchObject({ operationType: "standing_autopay_charge", amountMinor: afterConsent.obligation.amountMinor, providerName: "square" });
    const replay = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: afterConsent.occurrence.startAt });
    expect(replay?.id).toBe(operation?.id);
    const [binding] = await db.select().from(paymentOperationStandingAutopayBindings).where(eq(paymentOperationStandingAutopayBindings.operationId, operation!.id));
    expect(binding).toMatchObject({ providerName: "square", providerLocationId: "square-location-fixture", triggerOccurrenceId: afterConsent.occurrence.id, collectionMode: "weekly", consentId: consent.id, consentVersion: 1 });
    const [snapshot] = await db.select().from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, operation!.id));
    expect(snapshot).toMatchObject({ snapshotKind: "standing_autopay", amountMinor: operation!.amountMinor, cutoffAt: afterConsent.occurrence.startAt });
    const items = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("reserved");
    const participants = await db.select().from(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.operationId, operation!.id));
    expect(participants).toMatchObject([{ obligationId: afterConsent.obligation.id, bowlerId: payerBowlerId, role: "payer", consentVersion: 1 }]);
  });

  it("allows an exact future paired occurrence, but blocks an incomplete pair atomically", async () => {
    const trigger = await publishOccurrence("2039-01-15T19:00:00.000Z");
    const paired = await publishOccurrence("2039-01-22T19:00:00.000Z");
    await createDoublePayGroup(trigger, paired);
    const consent = await insertConsent({ version: 2, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: trigger.occurrence.startAt });
    expect(operation).toMatchObject({ operationType: "standing_autopay_charge", amountMinor: 4_000 });
    const [binding] = await db.select().from(paymentOperationStandingAutopayBindings).where(eq(paymentOperationStandingAutopayBindings.operationId, operation!.id));
    expect(binding).toMatchObject({ collectionMode: "double_pay", triggerOccurrenceId: trigger.occurrence.id, pairedOccurrenceId: paired.occurrence.id });
    const futureItem = await db.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId }).from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id), eq(paymentOperationRosterSnapshotItems.obligationId, paired.obligation.id)));
    expect(futureItem).toHaveLength(1);

    const incompleteTrigger = await publishOccurrence("2039-02-05T19:00:00.000Z");
    const incompletePaired = await publishOccurrence("2039-02-12T19:00:00.000Z");
    await createDoublePayGroup(incompleteTrigger, incompletePaired);
    // Leave the paired obligation open while making the trigger incomplete;
    // after the durable block the pair must not fall back to an independent
    // weekly cutoff when its own date arrives.
    await db.update(paymentObligations).set({ state: "voided", voidedAt: "2039-01-31T00:00:00.000Z" }).where(eq(paymentObligations.id, incompleteTrigger.obligation.id));
    const blocked = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: incompleteTrigger.occurrence.startAt });
    expect(blocked).toBeUndefined();
    const operations = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.operationType, "standing_autopay_charge"), eq(paymentOperations.triggerOccurrenceId, incompleteTrigger.occurrence.id)));
    expect(operations).toHaveLength(0);
    const pairedFallback = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: incompletePaired.occurrence.startAt });
    expect(pairedFallback).toBeUndefined();
    const cutoffCommands = await db.select({ key: financialCommands.idempotencyKey, result: financialCommands.result }).from(financialCommands).where(and(eq(financialCommands.organizationId, organizationId), eq(financialCommands.leagueId, leagueId), eq(financialCommands.commandType, "standing_autopay_cutoff")));
    const pairedDecision = cutoffCommands.find((command) => JSON.stringify(command.result).includes("paired_occurrence_requires_trigger"));
    expect(pairedDecision?.result).toMatchObject({ kind: "blocked", reason: "paired_occurrence_requires_trigger" });
  });

  it("releases a pre-dispatch reservation on consent revoke and keeps immutable consent history", async () => {
    const consent = await insertConsent({ version: 3, activatedAt: "2039-01-02T00:00:00.000Z" });
    const target = await publishOccurrence("2039-02-19T19:00:00.000Z");
    const { prepareStandingAutopayCutoff, revokeStandingAutopayConsent } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(operation).toBeDefined();
    await revokeStandingAutopayConsent({ organizationId, leagueId, payerBowlerId, actorUserId, request: { commandKey: `standing-revoke-${randomUUID()}` } });
    const [updatedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation!.id));
    const releasedItems = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(updatedOperation.status).toBe("canceled");
    expect(releasedItems).toMatchObject([{ state: "released" }]);
    const [updatedConsent] = await db.select().from(autopayConsents).where(eq(autopayConsents.id, consent.id));
    expect(updatedConsent).toMatchObject({ state: "revoked", consentVersion: 3, providerLocationId: "square-location-fixture" });
  });

  it("moves provider-unknown consent work to reconciliation while preserving dispatch evidence", async () => {
    const consent = await insertConsent({ version: 31, activatedAt: "2039-01-02T00:00:00.000Z" });
    const target = await publishOccurrence("2039-02-26T19:00:00.000Z");
    const { prepareStandingAutopayCutoff, revokeStandingAutopayConsent } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    if (!operation) throw new Error("provider-unknown revoke fixture was not prepared");
    const dispatchClaimedAt = new Date().toISOString();
    await db.update(paymentOperations).set({
      status: "provider_unknown",
      attemptCount: 1,
      startedAt: dispatchClaimedAt,
      nextAttemptAt: "2039-02-26T20:00:00.000Z",
      dispatchClaimedAt,
      providerObjectId: "square-payment-unknown",
      errorClassification: "provider_unknown",
      errorCode: "NETWORK_UNKNOWN",
    }).where(eq(paymentOperations.id, operation.id));

    await revokeStandingAutopayConsent({
      organizationId,
      leagueId,
      payerBowlerId,
      actorUserId,
      request: { commandKey: `standing-revoke-provider-unknown-${randomUUID()}` },
    });
    const [updatedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    const [snapshotItem] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(updatedOperation).toMatchObject({
      status: "reconciliation_required",
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      dispatchClaimedAt: expect.any(String),
      providerObjectId: "square-payment-unknown",
      completedAt: expect.any(String),
    });
    expect(new Date(updatedOperation.dispatchClaimedAt ?? "").toISOString()).toBe(dispatchClaimedAt);
    expect(snapshotItem.state).toBe("reserved");
  });

  it("rejects participant evidence tampering at the deferred database boundary", async () => {
    const standingOperation = await db.select({ id: paymentOperations.id, consentVersion: paymentOperationStandingAutopayBindings.consentVersion, obligationId: paymentOperationStandingAutopayParticipants.obligationId }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id)).innerJoin(paymentOperationStandingAutopayParticipants, eq(paymentOperationStandingAutopayParticipants.operationId, paymentOperations.id)).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).orderBy(sql`${paymentOperations.createdAt} DESC`).limit(1);
    expect(standingOperation).toHaveLength(1);
    const invalidParticipant = { operationId: standingOperation[0].id, organizationId, leagueId, allocationIndex: 8, obligationId: standingOperation[0].obligationId, bowlerId: partnerBowlerId, role: "payer" as const, paymentLinkId: null, linkFingerprint: null, consentVersion: standingOperation[0].consentVersion };
    await expect(db.transaction(async (tx) => {
      await tx.insert(paymentOperationStandingAutopayParticipants).values(invalidParticipant);
    })).rejects.toThrow();
  });

  it("rejects a consent partner whose bowler is not the link's opposite endpoint", async () => {
    const consent = await insertConsent({ version: 80, activatedAt: "2039-01-02T00:00:00.000Z" });
    const [link] = await db.insert(bowlerPaymentLinks).values({
      bowlerAId: Math.min(payerBowlerId, partnerBowlerId),
      bowlerBId: Math.max(payerBowlerId, partnerBowlerId),
      organizationId,
      status: "accepted",
      createdByUserId: actorUserId,
      respondedAt: "2039-01-01T00:00:00.000Z",
    }).returning();
    await expect(db.transaction(async (tx) => {
      await tx.insert(autopayConsentPartners).values({
        organizationId,
        leagueId,
        consentId: consent.id,
        consentVersion: consent.consentVersion,
        // The payer itself is never the partner endpoint.
        partnerBowlerId: payerBowlerId,
        paymentLinkId: link.id,
        linkFingerprint: fp("lvpartnerlink:v1:", "tamper"),
      });
    })).rejects.toThrow();
    // The failed evidence transaction does not consume the fixture link; retire
    // it explicitly so later unlink/race cases can create their own accepted
    // link for the same two bowlers.
    await db.update(bowlerPaymentLinks).set({ status: "retired" }).where(eq(bowlerPaymentLinks.id, link.id));
  });

  it("retires an accepted partner link after locking the affected league and revokes consent", async () => {
    const consent = await insertConsent({ version: 4, activatedAt: "2039-01-02T00:00:00.000Z" });
    const [link] = await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(payerBowlerId, partnerBowlerId), bowlerBId: Math.max(payerBowlerId, partnerBowlerId), organizationId, status: "accepted", createdByUserId: actorUserId, respondedAt: "2039-01-01T00:00:00.000Z" }).returning();
    await db.insert(autopayConsentPartners).values({ organizationId, leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId, paymentLinkId: link.id, linkFingerprint: fp("lvpartnerlink:v1:", "link") });
    await deleteLink(link.id);
    const [retiredLink] = await db.select().from(bowlerPaymentLinks).where(eq(bowlerPaymentLinks.id, link.id));
    const [revokedConsent] = await db.select().from(autopayConsents).where(eq(autopayConsents.id, consent.id));
    expect(retiredLink.status).toBe("retired");
    expect(revokedConsent.state).toBe("revoked");
    expect(revokedConsent.revokedAt).not.toBeNull();
  });

  it("binds consent replacement to a new version even at the same cutoff", async () => {
    // This cutoff is earlier than every other standing fixture occurrence so
    // the scheduler assertion below proves the replacement version is
    // discoverable, rather than merely observing an unrelated later wake.
    const target = await publishOccurrence("2039-01-01T18:00:00.000Z");
    const firstConsent = await insertConsent({ version: 5, activatedAt: "2038-12-01T00:00:00.000Z" });
    const { activateStandingAutopayConsent, prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const firstOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: firstConsent.id, cutoffAt: target.occurrence.startAt });
    expect(firstOperation).toBeDefined();
    standingProviderMock.mockResolvedValue({
      providerName: "square",
      getProviderLocationId: vi.fn().mockResolvedValue("square-location-fixture"),
      validateCardId: vi.fn().mockReturnValue(true),
      hasCardOnFile: vi.fn().mockResolvedValue(true),
    });
    const replacementWire = await activateStandingAutopayConsent({ organizationId, leagueId, payerBowlerId, actorUserId, request: { commandKey: `standing-consent-replace-${randomUUID()}`, sourceId: "replacement-source", partnerBowlerIds: [] } });
    standingProviderMock.mockReset();
    const [replacement] = await db.select().from(autopayConsents).where(and(eq(autopayConsents.organizationId, organizationId), eq(autopayConsents.leagueId, leagueId), eq(autopayConsents.payerBowlerId, payerBowlerId), eq(autopayConsents.state, "active")));
    expect(replacementWire).toMatchObject({ state: "active", consentVersion: 81 });
    const [canceledFirst] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, firstOperation!.id));
    const [releasedFirst] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, firstOperation!.id));
    expect(canceledFirst.status).toBe("canceled");
    expect(releasedFirst.state).toBe("released");
    // Keep unrelated retry work out of this scheduler assertion; the query
    // must choose the replacement consent's restored cutoff itself.
    await db.update(paymentOperations).set({ nextAttemptAt: "2099-01-01T00:00:00.000Z" }).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "standing_autopay_charge"),
      inArray(paymentOperations.status, ["pending", "retry_scheduled", "provider_unknown"] as const),
    ));
    const replacementWake = await getNextStandingAutopayWake();
    expect(replacementWake).toMatchObject({ kind: "standing_cutoff", organizationId, leagueId, consentId: replacement.id, dueAt: "2039-01-01 18:00:00" });
    const replacementOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: replacement.id, cutoffAt: target.occurrence.startAt });
    expect(replacementOperation).toBeDefined();
    expect(replacementOperation!.id).not.toBe(firstOperation!.id);
    expect(replacementOperation!.targetKey).not.toBe(firstOperation!.targetKey);
    const bindings = await db.select({ consentId: paymentOperationStandingAutopayBindings.consentId, consentVersion: paymentOperationStandingAutopayBindings.consentVersion }).from(paymentOperationStandingAutopayBindings).where(inArray(paymentOperationStandingAutopayBindings.operationId, [firstOperation!.id, replacementOperation!.id]));
    expect(bindings).toEqual(expect.arrayContaining([{ consentId: firstConsent.id, consentVersion: 5 }, { consentId: replacement.id, consentVersion: replacement.consentVersion }]));
  });

  it("serializes concurrent cutoff requests into one reservation and one operation", async () => {
    const target = await publishOccurrence("2039-03-12T19:00:00.000Z");
    const consent = await insertConsent({ version: 7, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const [left, right] = await Promise.all([
      prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt }),
      prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt }),
    ]);
    expect(left?.id).toBe(right?.id);
    const operations = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.triggerOccurrenceId, target.occurrence.id), eq(paymentOperations.operationType, "standing_autopay_charge")));
    const reservations = await db.select().from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, organizationId), eq(paymentOperationRosterSnapshotItems.obligationId, target.obligation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
    expect(operations).toHaveLength(1);
    expect(reservations).toHaveLength(1);
  });

  it("serializes a cutoff against an exact manual reservation without double collection", async () => {
    const target = await publishOccurrence("2039-03-15T19:00:00.000Z");
    const consent = await insertConsent({ version: 71, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const { quoteInteractiveObligations, recordCanonicalManualPayment, RosterPaymentError } = await import("../../server/services/roster-payment-core");
    const quote = await quoteInteractiveObligations({ organizationId, leagueId, obligationIds: [target.obligation.id], payerBowlerId });
    const manualRequest = {
      obligationIds: [target.obligation.id],
      allocations: [{ obligationId: target.obligation.id, amountMinor: quote.amountMinor }],
      type: "cash" as const,
      idempotencyKey: `standing-manual-race-${randomUUID()}`,
      requestFingerprint: quote.fingerprint,
      notes: "race fixture",
    };
    const [cutoffOutcome, manualOutcome] = await Promise.allSettled([
      prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt }),
      recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request: manualRequest }),
    ]);
    const cutoffWon = cutoffOutcome.status === "fulfilled" && cutoffOutcome.value !== undefined;
    const manualWon = manualOutcome.status === "fulfilled";
    expect(cutoffWon).not.toBe(manualWon);
    if (cutoffOutcome.status === "fulfilled" && cutoffOutcome.value !== undefined) {
      expect(manualOutcome.status).toBe("rejected");
      if (manualOutcome.status === "rejected") {
        expect(manualOutcome.reason).toBeInstanceOf(RosterPaymentError);
        expect((manualOutcome.reason as { code?: string }).code).toBe("OBLIGATION_RESERVED");
      }
    } else {
      expect(cutoffOutcome.status).toBe("fulfilled");
      if (cutoffOutcome.status === "fulfilled") expect(cutoffOutcome.value).toBeUndefined();
    }
    const [allocationTotals] = await db.select({ total: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.leagueId, leagueId), eq(paymentAllocations.obligationId, target.obligation.id), eq(paymentAllocations.state, "active")));
    const reserved = await db.select().from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, leagueId), eq(paymentOperationRosterSnapshotItems.obligationId, target.obligation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
    expect(Number(allocationTotals?.total ?? 0) + reserved.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(target.obligation.amountMinor);
  });

  it("fences roster saves and manual corrections while standing evidence is reserved", async () => {
    const target = await publishOccurrence("2039-03-16T19:00:00.000Z");
    const consent = await insertConsent({ version: 72, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const { canonicalRosterFingerprint, correctCanonicalAllocation, quoteInteractiveObligations, recordCanonicalManualPayment, RosterPaymentError, saveTeamRoster } = await import("../../server/services/roster-payment-core");

    // A roster mutation that would supersede the reserved responsibility is
    // rejected under the same league lock as cutoff preparation.
    const standingOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(standingOperation).toBeDefined();
    const roster = await (await import("../../server/services/roster-payment-core")).readRosterPaymentResponsibility({ organizationId, leagueId });
    const rosterTeam = roster.teams.find((team) => team.id === teamId);
    expect(rosterTeam).toBeDefined();
    const rosterRequest = {
      commandKey: `reserved-roster-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      policy: rosterTeam!.policy,
      slots: rosterTeam!.slots.map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.slotIndex === 0 ? partnerBowlerId : slot.mainBowlerId })),
    };
    rosterRequest.requestFingerprint = canonicalRosterFingerprint(rosterRequest);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request: rosterRequest })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED" });

    // A partial manual entry leaves an open remainder. Once the standing
    // cutoff reserves that remainder, correcting the original cash evidence
    // must fail closed rather than reopen the obligation underneath it.
    const manualTarget = await publishOccurrence("2039-03-17T19:00:00.000Z");
    const manualQuote = await quoteInteractiveObligations({ organizationId, leagueId, obligationIds: [manualTarget.obligation.id], payerBowlerId, allocations: [{ obligationId: manualTarget.obligation.id, amountMinor: 1_000 }] });
    const manual = await recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request: {
      obligationIds: [manualTarget.obligation.id],
      allocations: [{ obligationId: manualTarget.obligation.id, amountMinor: 1_000 }],
      type: "cash",
      idempotencyKey: `reserved-correction-manual-${randomUUID()}`,
      requestFingerprint: manualQuote.fingerprint,
      notes: "partial cash fixture",
    } });
    const manualOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: manualTarget.occurrence.startAt });
    expect(manualOperation).toBeDefined();
    const correctionRequest = {
      allocationId: manual.records[0].allocation.id,
      correctionMode: "void_only" as const,
      reason: "reserved correction fixture",
      idempotencyKey: `reserved-correction-${randomUUID()}`,
      requestFingerprint: "",
    };
    const { canonicalCorrectionFingerprint } = await import("../../server/services/roster-payment-core");
    correctionRequest.requestFingerprint = canonicalCorrectionFingerprint(correctionRequest);
    await expect(correctCanonicalAllocation({ organizationId, leagueId, actorUserId, request: correctionRequest })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED" });
  });

  it("handles unlink racing cutoff without leaving an active consent or live reservation", async () => {
    const target = await publishOccurrence("2039-03-19T19:00:00.000Z");
    const consent = await insertConsent({ version: 8, activatedAt: "2039-01-02T00:00:00.000Z" });
    const [link] = await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(payerBowlerId, partnerBowlerId), bowlerBId: Math.max(payerBowlerId, partnerBowlerId), organizationId, status: "accepted", createdByUserId: actorUserId, respondedAt: "2039-01-01T00:00:00.000Z" }).returning();
    await db.insert(autopayConsentPartners).values({ organizationId, leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId, paymentLinkId: link.id, linkFingerprint: uniqueFp("lvpartnerlink:v1:") });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const race = await Promise.allSettled([
      prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt }),
      deleteLink(link.id),
    ]);
    const cutoffOutcome = race[0];
    if (cutoffOutcome.status === "rejected") expect((cutoffOutcome.reason as { code?: string }).code).toBe("PARTNER_AUTHORIZATION_CHANGED");
    const [postLink] = await db.select().from(bowlerPaymentLinks).where(eq(bowlerPaymentLinks.id, link.id));
    const [postConsent] = await db.select().from(autopayConsents).where(eq(autopayConsents.id, consent.id));
    const liveReservations = await db.select().from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, organizationId), eq(paymentOperationRosterSnapshotItems.obligationId, target.obligation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
    expect(postLink.status).toBe("retired");
    expect(postConsent.state).toBe("revoked");
    expect(liveReservations).toHaveLength(0);
  });

  it("releases exact reservations on a deterministic pre-dispatch executor failure", async () => {
    const target = await publishOccurrence("2039-03-26T19:00:00.000Z");
    const consent = await insertConsent({ version: 9, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    const { rosterStandingAutopayOperationExecutor } = await import("../../server/services/roster-standing-autopay-executor");
    const result = await rosterStandingAutopayOperationExecutor.execute({ organizationId, operationId: operation!.id });
    const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(result?.status).toBe("failed_terminal");
    expect(item.state).toBe("released");
  });

  it("releases a post-dispatch hard decline reservation without treating it as provider uncertainty", async () => {
    const target = await publishOccurrence("2039-03-30T19:00:00.000Z");
    const consent = await insertConsent({ version: 91, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    const processPayment = vi.fn().mockRejectedValue(new PaymentProviderError("declined", "CARD_DECLINED", undefined, { disposition: "action_required", providerCode: "CARD_DECLINED" }));
    const provider = {
      providerName: "square",
      locationId,
      getProviderLocationId: vi.fn().mockResolvedValue("square-location-fixture"),
      validateCardId: vi.fn().mockReturnValue(true),
      hasCardOnFile: vi.fn().mockResolvedValue(true),
      processPayment,
    } as never;
    const { RosterStandingAutopayOperationExecutor } = await import("../../server/services/roster-standing-autopay-executor");
    const result = await new RosterStandingAutopayOperationExecutor({ getProvider: vi.fn().mockResolvedValue(provider) }).execute({ organizationId, operationId: operation!.id });
    const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(result?.status).toBe("action_required");
    expect(item.state).toBe("released");
  });

  it("restores a canceled occurrence and makes its new cutoff eligible again", async () => {
    // Keep this restored cutoff earlier than later fixture obligations so the
    // public scheduler query must return it before preparation is replayed.
    const target = await publishOccurrence("2039-01-09T19:00:00.000Z");
    const consent = await insertConsent({ version: 12, activatedAt: "2039-01-02T00:00:00.000Z" });
    // The schedule publication service normally creates this canonical term;
    // the compact fixture publishes the occurrence directly, so provide the
    // same term evidence for the production cancel/restore transaction.
    await db.insert(leagueOccurrenceBillingTerms).values({
      id: randomUUID(),
      organizationId,
      leagueId,
      occurrenceId: target.occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2_000,
      currency: "USD",
      billingOrdinal: occurrenceOrdinal,
      version: 1,
      state: "published",
      publishedAt: target.occurrence.startAt,
      publishedByUserId: actorUserId,
      publicationCommandId: target.commandId,
    });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const originalOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(originalOperation).toBeDefined();
    const now = "2038-01-01T00:00:00.000Z";
    const cancellationRequest = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "cancel",
      occurrenceId: target.occurrence.id,
      idempotencyKey: `standing-cancel-${randomUUID()}`,
      requestFingerprint: "",
      reason: "fixture cancellation",
      now,
    } as const;
    await cancelOccurrence({ ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) });
    const [canceledOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, originalOperation!.id));
    expect(canceledOperation.status).toBe("canceled");
    await restoreCancelledOccurrence({
      organizationId,
      leagueId,
      actorUserId,
      occurrenceId: target.occurrence.id,
      idempotencyKey: `standing-restore-${randomUUID()}`,
      reason: "fixture restoration",
      now,
    });
    const restoredObligations = await db.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.occurrenceId, target.occurrence.id),
      eq(paymentObligations.state, "open"),
    ));
    expect(restoredObligations.length).toBeGreaterThan(0);
    // Earlier cases intentionally leave committed standing operations in the
    // fixture. Move only their retry wake times beyond this assertion so the
    // public scheduler result proves restored cutoff discovery rather than an
    // unrelated operation retry.
    await db.update(paymentOperations).set({ nextAttemptAt: "2099-01-01T00:00:00.000Z" }).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "standing_autopay_charge"),
      inArray(paymentOperations.status, ["pending", "retry_scheduled", "provider_unknown"] as const),
    ));
    const restoredWake = await getNextStandingAutopayWake();
    const restoredDueAt = new Date(target.occurrence.startAt).toISOString().replace("T", " ").replace(".000Z", "");
    expect(restoredWake).toMatchObject({ kind: "standing_cutoff", organizationId, leagueId, consentId: consent.id, dueAt: restoredDueAt });
    const restoredOperation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(restoredOperation).toBeDefined();
    expect(restoredOperation!.id).not.toBe(originalOperation!.id);
  });

  it("freezes provider location in the executor charge request and retains uncertainty after dispatch", async () => {
    const target = await publishOccurrence("2039-04-02T19:00:00.000Z");
    const consent = await insertConsent({ version: 10, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    const processPayment = vi.fn().mockRejectedValue(new PaymentProviderError("network uncertain", "NETWORK_UNKNOWN", undefined, { disposition: "provider_unknown", providerCode: "NETWORK_UNKNOWN" }));
    const provider = {
      providerName: "square",
      locationId,
      getProviderLocationId: vi.fn().mockResolvedValue("square-location-fixture"),
      validateCardId: vi.fn().mockReturnValue(true),
      hasCardOnFile: vi.fn().mockResolvedValue(true),
      processPayment,
    } as never;
    const { RosterStandingAutopayOperationExecutor } = await import("../../server/services/roster-standing-autopay-executor");
    const getProvider = vi.fn().mockResolvedValue(provider);
    const executor = new RosterStandingAutopayOperationExecutor({ getProvider });
    const result = await executor.execute({ organizationId, operationId: operation!.id });
    expect(result?.status).toBe("provider_unknown");
    expect(processPayment).toHaveBeenCalledWith("source-fixture", operation!.amountMinor, false, "customer-fixture", undefined, expect.objectContaining({ providerLocationId: "square-location-fixture", referenceId: operation!.id }));
    const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(item.state).toBe("reserved");
  });

  it("matches a standing webhook by durable operation reference and provider location", async () => {
    const target = await publishOccurrence("2039-04-09T19:00:00.000Z");
    const consent = await insertConsent({ version: 11, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    const webhookNow = new Date().toISOString();
    await db.update(paymentOperations).set({
      status: "provider_unknown",
      attemptCount: 1,
      startedAt: webhookNow,
      nextAttemptAt: "2039-04-09T20:00:00.000Z",
      errorClassification: "provider_unknown",
      errorCode: "NETWORK_UNKNOWN",
      updatedAt: webhookNow,
    }).where(eq(paymentOperations.id, operation!.id));
    const providerPaymentId = `standing-webhook-payment-${randomUUID()}`;
    const webhookId = randomUUID();
    const event = {
      providerEventId: `standing-webhook-event-${randomUUID()}`,
      eventType: "payment.updated",
      providerCreatedAt: "2039-04-09T19:00:01.000Z",
      providerMerchantId: "merchant-fixture",
      providerLocationId: "square-location-fixture",
      providerObjectType: "payment",
      providerObjectId: providerPaymentId,
      providerPaymentId,
      providerObjectVersion: 1,
      providerObjectUpdatedAt: "2039-04-09T19:00:02.000Z",
      ignored: false,
      providerStatus: "COMPLETED",
      amountMinor: operation!.amountMinor,
      currency: "USD",
      providerOrderId: null,
      providerReferenceId: operation!.id,
      receiptUrl: "https://square.example.test/standing-receipt",
      receiptNumber: "standing-receipt-11",
      dispute: null,
    } as const;
    await db.insert(webhookEvents).values({
      id: webhookId,
      provider: "square",
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCreatedAt: event.providerCreatedAt,
      organizationId,
      locationId,
      providerApplicationId: "app-fixture",
      providerMerchantId: event.providerMerchantId,
      providerLocationId: event.providerLocationId,
      providerObjectType: event.providerObjectType,
      providerObjectId: event.providerObjectId,
      providerPaymentId,
      providerObjectVersion: event.providerObjectVersion,
      providerObjectUpdatedAt: event.providerObjectUpdatedAt,
      providerApiVersion: "2026-05-20",
      payloadHash: "a".repeat(64),
      encryptedPayload: encrypt("{}"),
      status: "pending",
    });
    const { processSquareWebhookEvent } = await import("../../server/storage/square-webhook-processing");
    const result = await processSquareWebhookEvent({ organizationId, eventId: webhookId, event });
    expect(result).toMatchObject({ acknowledged: true, terminal: true, status: "processed", businessStateChanged: true });
    const [updatedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation!.id));
    const [finalizedItem] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    const [payment] = await db.select().from(payments).where(eq(payments.paymentOperationId, operation!.id));
    expect(updatedOperation).toMatchObject({ status: "succeeded", providerObjectId: providerPaymentId });
    expect(finalizedItem.state).toBe("finalized");
    expect(payment).toMatchObject({ receiptUrl: "https://square.example.test/standing-receipt", receiptNumber: "standing-receipt-11" });
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: payment.id, page: 1, limit: 10 });
    expect(report.rows[0]?.receipt).toMatchObject({ availability: "available", receiptUrl: "https://square.example.test/standing-receipt", receiptNumber: "standing-receipt-11" });
  });

  it("retains partner participant evidence until tenant teardown", async () => {
    const target = await publishOccurrence("2039-04-16T19:00:00.000Z");
    const consent = await insertConsent({ version: 14, activatedAt: "2039-01-02T00:00:00.000Z" });
    const [link] = await db.insert(bowlerPaymentLinks).values({
      bowlerAId: Math.min(payerBowlerId, partnerBowlerId),
      bowlerBId: Math.max(payerBowlerId, partnerBowlerId),
      organizationId,
      status: "accepted",
      createdByUserId: actorUserId,
      respondedAt: "2039-04-15T00:00:00.000Z",
    }).returning();
    const linkFingerprint = partnerLinkFp(link);
    await db.insert(autopayConsentPartners).values({ organizationId, leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId, paymentLinkId: link.id, linkFingerprint });
    const { canonicalResponsibilityFingerprint, recordOccurrenceResponsibilities } = await import("../../server/services/roster-payment-core");
    const responsibility = {
      occurrenceId: target.occurrence.id,
      teamId,
      slotIndex: 0,
      positionIndex: 0,
      kind: "substitute" as const,
      mainBowlerId: payerBowlerId,
      substituteBowlerId: partnerBowlerId,
      payerBowlerId: partnerBowlerId,
      policy: "sub_pays_full" as const,
      amountMinor: 2_000,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      dueAt: target.occurrence.startAt,
      pastDueAt: "2039-04-16T22:00:00.000Z",
      assignmentNote: "partner teardown fixture",
    };
    await recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: `partner-responsibility-${randomUUID()}`,
      requestFingerprint: canonicalResponsibilityFingerprint([responsibility]),
      responsibilities: [responsibility],
    });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(operation).toBeDefined();
    const [participant] = await db.select().from(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.operationId, operation!.id));
    const [partnerObligation] = await db.select({ id: paymentObligations.id }).from(paymentObligations).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId), eq(paymentObligations.occurrenceId, target.occurrence.id), eq(paymentObligations.payerBowlerId, partnerBowlerId), eq(paymentObligations.state, "open")));
    expect(partnerObligation).toBeDefined();
    expect(participant).toMatchObject({ role: "partner", bowlerId: partnerBowlerId, paymentLinkId: link.id, linkFingerprint, obligationId: partnerObligation.id });
  });

  it("revokes standing work when an active membership is deactivated", async () => {
    const target = await publishOccurrence("2039-04-23T19:00:00.000Z");
    const consent = await insertConsent({ version: 13, activatedAt: "2039-01-02T00:00:00.000Z" });
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
    expect(operation).toBeDefined();
    const [membership] = await db.select().from(bowlerLeagues).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.bowlerId, payerBowlerId), eq(bowlerLeagues.active, true))).limit(1);
    await updateBowlerLeague(membership.id, { active: false }, actorUserId);
    const [updatedConsent] = await db.select().from(autopayConsents).where(eq(autopayConsents.id, consent.id));
    const [updatedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation!.id));
    const [updatedSlot] = await db.select().from(teamPaymentSlots).where(and(eq(teamPaymentSlots.teamId, teamId), eq(teamPaymentSlots.slotIndex, 0)));
    const [snapshotItem] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation!.id));
    expect(updatedConsent.state).toBe("revoked");
    expect(updatedOperation.status).toBe("canceled");
    expect(snapshotItem.state).toBe("released");
    expect(updatedSlot).toMatchObject({ occupant: "vacant", mainBowlerId: null });
  });

  it("deletes standing participant and link child evidence before organization teardown", async () => {
    const doomedOrganizationId = organizationId;
    expect(doomedOrganizationId).toBeGreaterThan(0);

    // Provider responses arrive outside the dispatch transaction. Hold three
    // provider calls at that boundary, let archive win the league lock, and
    // then release success/unknown/action-required outcomes. Every late
    // response must attach only immutable evidence to the archived,
    // token-fenced reconciliation row; reservations remain retained.
    await db.update(bowlerLeagues).set({ active: true }).where(and(
      eq(bowlerLeagues.leagueId, leagueId),
      eq(bowlerLeagues.bowlerId, payerBowlerId),
    ));
    await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: payerBowlerId }).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    const { prepareStandingAutopayCutoff } = await import("../../server/services/roster-standing-autopay");
    const raceInputs = [
      { version: 101, startAt: "2039-05-01T19:00:00.000Z", outcome: "success" as const },
      { version: 102, startAt: "2039-05-08T19:00:00.000Z", outcome: "unknown" as const },
      { version: 103, startAt: "2039-05-15T19:00:00.000Z", outcome: "action_required" as const },
    ];
    const prepared = [];
    for (const input of raceInputs) {
      const target = await publishOccurrence(input.startAt);
      const consent = await insertConsent({ version: input.version, activatedAt: "2039-01-02T00:00:00.000Z" });
      const operation = await prepareStandingAutopayCutoff({ organizationId, leagueId, consentId: consent.id, cutoffAt: target.occurrence.startAt });
      if (!operation) throw new Error(`race operation ${input.outcome} was not prepared`);
      prepared.push({ operation, outcome: input.outcome });
    }

    const leaseTokenById = new Map<string, string>();
    for (const { operation } of prepared) {
      const leaseToken = randomUUID();
      const claimedAt = new Date().toISOString();
      leaseTokenById.set(operation.id, leaseToken);
      await db.update(paymentOperations).set({
        status: "leased",
        attemptCount: 1,
        nextAttemptAt: null,
        leaseOwner: `standing-race-${operation.id}`,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        startedAt: claimedAt,
        dispatchClaimedAt: claimedAt,
        errorClassification: null,
        errorCode: null,
      }).where(eq(paymentOperations.id, operation.id));
    }

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((next) => { resolve = next; });
      return { promise, resolve };
    };
    const started = new Map<string, ReturnType<typeof deferred>>();
    const release = new Map<string, ReturnType<typeof deferred>>();
    for (const { operation } of prepared) {
      started.set(operation.id, deferred());
      release.set(operation.id, deferred());
    }
    const executions = prepared.map(({ operation, outcome }) => (async () => {
      started.get(operation.id)?.resolve();
      await release.get(operation.id)?.promise;
      const leaseToken = leaseTokenById.get(operation.id)!;
      const providerOrderId = `standing-race-order-${operation.id}`;
      if (outcome === "success") return finalizePaymentOperationSuccess({ organizationId, operationId: operation.id, leaseToken, providerObjectId: `standing-race-payment-${operation.id}`, providerOrderId });
      if (outcome === "unknown") return recordPaymentOperationProviderUnknown({ organizationId, operationId: operation.id, leaseToken, providerOrderId, errorCode: "PROVIDER_TIMEOUT", recoveryAt: new Date(Date.now() + 60_000) });
      return recordPaymentOperationActionRequired({ organizationId, operationId: operation.id, leaseToken, providerOrderId, errorCode: "CARD_DECLINED" });
    })());
    await Promise.all([...started.values()].map((signal) => signal.promise));
    await archiveLeague(leagueId, organizationId);
    for (const signal of release.values()) signal.resolve();
    const results = await Promise.all(executions);
    expect(results.map((result) => result?.status)).toEqual([
      "reconciliation_required",
      "reconciliation_required",
      "reconciliation_required",
    ]);
    const archivedOperations = await db.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      inArray(paymentOperations.id, prepared.map(({ operation }) => operation.id)),
    )).orderBy(paymentOperations.createdAt);
    expect(archivedOperations).toHaveLength(3);
    expect(archivedOperations[0]).toMatchObject({ status: "reconciliation_required", providerObjectId: `standing-race-payment-${prepared[0].operation.id}`, providerOrderId: `standing-race-order-${prepared[0].operation.id}`, errorClassification: "provider_unknown" });
    expect(archivedOperations[1]).toMatchObject({ status: "reconciliation_required", providerObjectId: null, providerOrderId: `standing-race-order-${prepared[1].operation.id}`, errorClassification: "provider_unknown" });
    expect(archivedOperations[2]).toMatchObject({ status: "reconciliation_required", providerObjectId: null, providerOrderId: `standing-race-order-${prepared[2].operation.id}`, errorClassification: "provider_unknown" });
    for (const row of archivedOperations) {
      expect(row.leaseToken).not.toBeNull();
      expect(row.dispatchClaimedAt).not.toBeNull();
      expect(row.leaseOwner).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
    }
    const archivedItems = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      inArray(paymentOperationRosterSnapshotItems.operationId, prepared.map(({ operation }) => operation.id)),
    ));
    expect(archivedItems).toHaveLength(3);
    expect(archivedItems.every((row) => row.state === "reserved")).toBe(true);

    const participantBefore = await db.select({ id: paymentOperationStandingAutopayParticipants.id }).from(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.organizationId, doomedOrganizationId));
    expect(participantBefore.length).toBeGreaterThan(0);
    await deleteOrganization(doomedOrganizationId);
    organizationId = 0;
    expect(await db.select().from(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.organizationId, doomedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(paymentOperationStandingAutopayBindings).where(eq(paymentOperationStandingAutopayBindings.organizationId, doomedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(autopayConsentPartners).where(eq(autopayConsentPartners.organizationId, doomedOrganizationId))).toHaveLength(0);
    expect(await db.select().from(bowlerPaymentLinks).where(eq(bowlerPaymentLinks.organizationId, doomedOrganizationId))).toHaveLength(0);
  });
});
