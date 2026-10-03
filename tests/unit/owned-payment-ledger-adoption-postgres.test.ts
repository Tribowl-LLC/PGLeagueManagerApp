import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerPaymentLinks,
  bowlers,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocationCorrections,
  paymentAllocations,
  paymentObligations,
  paymentObligationOwnerRevisions,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  payments,
  rotatingCreditFundings,
  rotatingOccurrenceAssignments,
  teamPaymentSlots,
  teams,
  users,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentLedgerAdoptionAllocationProofs,
  weeklyPaymentLedgerAdoptionAllocationProofSteps,
  weeklyPaymentFundingAuthorizationItems,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
  paymentAllocationFundingApplications,
} from "@shared/schema";
import {
  applyOwnedPaymentLedgerAdoption,
  deriveOwnedPaymentAdoptionCutoff,
  preflightOwnedPaymentLedgerAdoption,
} from "../../server/services/owned-payment-ledger-adoption";
import { localDateForInstant } from "../../server/services/manage-payments-worksheet-projection";
import { readManagePaymentsWorksheetSnapshot } from "../../server/services/manage-payments-worksheet-read";
import {
  correctHistoricalSquarePaymentAllocation,
  historicalSquareAllocationFingerprint,
  historicalSquareAllocationCorrectionFingerprint,
} from "../../server/services/historical-square-payment-correction";
import {
  readConfirmedOwnedObligationsInTransaction,
  readOwnedAccountBalancesInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  readOwnedPaymentLedgerReadSnapshotInTransaction,
} from "../../server/services/owned-payment-ledger";
import { readCanonicalDuePastDueV3InTransaction } from "../../server/services/roster-payment-core";
import { canonicalizePaymentOperationInput } from "../../server/services/payment-operation-idempotency";
import {
  appendManualReceiptRevisionInTransaction,
  createManualReceiptHeadInTransaction,
  createManualReceiptPaymentInTransaction,
} from "../../server/services/manual-payment-receipts";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let bowlerId: number;
let teamId: number;
let generationRunId: string;
let occurrenceIds: string[] = [];

interface AdoptionScheduleFixtureScope {
  organizationId: number;
  leagueId: number;
  locationId: number;
  generationRunId: string;
  actorUserId: number;
  keySuffix: string;
}

interface AdoptionObligationFixtureScope extends AdoptionScheduleFixtureScope {
  bowlerId: number;
  teamId: number;
}

async function createPublishedOccurrence(
  ordinal: number,
  localDate: string,
  scope: AdoptionScheduleFixtureScope = { organizationId, leagueId, locationId, generationRunId, actorUserId, keySuffix: suffix },
  defaultAmountMinor = 1_000,
) {
  const commandId = randomUUID();
  const startAt = `${localDate}T19:00:00.000Z`;
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    actorUserId: scope.actorUserId,
    commandType: "publish",
    idempotencyKey: `owned-adoption-publish-${scope.keySuffix}-${ordinal}`,
    requestFingerprint: `owned-adoption-publish-fingerprint-${ordinal}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    locationId: scope.locationId,
    generationRunId: scope.generationRunId,
    generationKey: `owned-adoption-occurrence-${scope.keySuffix}-${ordinal}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "owned-adoption-test",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: scope.actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    occurrenceId: occurrence.id,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor,
    currency: "USD",
    billingOrdinal: ordinal,
    version: 1,
    state: "published",
    publishedAt: startAt,
    publishedByUserId: scope.actorUserId,
    publicationCommandId: commandId,
  });
  return occurrence.id;
}

async function createPayerObligation(
  occurrenceId: string,
  localDate: string,
  scope: AdoptionObligationFixtureScope = { organizationId, leagueId, locationId, generationRunId, actorUserId, keySuffix: suffix, bowlerId, teamId },
  amountMinor = 1_000,
) {
  const at = `${localDate}T19:00:00.000Z`;
  const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    occurrenceId,
    teamId: scope.teamId,
    responsibilityKind: "worksheet",
    worksheetFeeComponent: "full",
    payerBowlerId: scope.bowlerId,
    amountMinor,
    currency: "USD",
    dueAt: at,
    pastDueAt: at,
    recordedByUserId: scope.actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  const [obligation] = await db.insert(paymentObligations).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    occurrenceId,
    responsibilityId: responsibility.id,
    component: "full",
    payerBowlerId: scope.bowlerId,
    amountMinor,
    currency: "USD",
    dueAt: at,
    pastDueAt: at,
    state: "open",
    createdByUserId: scope.actorUserId,
  }).returning({ id: paymentObligations.id });
  return obligation.id;
}

interface SupplementalAdoptionFixture {
  leagueId: number;
  generationRunId: string;
  keySuffix: string;
  teamId: number;
  bowlerId: number;
  firstOccurrenceId: string;
  secondOccurrenceId: string;
  extraOccurrenceIds: string[];
  secondObligationId: string;
  legacyManualPaymentId: number;
  rotatingManualPaymentId: number;
  legacyAllocationIds: string[];
}

interface SupplementalAdoptionFixtureOptions {
  weeklyFeeMinor?: number;
  legacyPaymentAmountMinor?: number;
  teamAllocationAmountMinor?: number;
  futureAllocationAmountMinor?: number;
}

async function createSupplementalAdoptionFixture(
  key: string,
  additionalDates: readonly string[] = [],
  options: SupplementalAdoptionFixtureOptions = {},
): Promise<SupplementalAdoptionFixture> {
  const fixtureSuffix = key.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const weeklyFeeMinor = options.weeklyFeeMinor ?? 1_000;
  const legacyPaymentAmountMinor = options.legacyPaymentAmountMinor ?? 1_500;
  const teamAllocationAmountMinor = options.teamAllocationAmountMinor ?? 1_000;
  const futureAllocationAmountMinor = options.futureAllocationAmountMinor ?? 500;
  const [league] = await db.insert(leagues).values({
    name: `Owned Adoption ${fixtureSuffix}`,
    organizationId,
    locationId,
    payingLineupSize: 3,
    weeklyFee: weeklyFeeMinor / 100,
    seasonStart: "2038-02-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
    paymentMode: "weekly",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("supplemental adoption league was not created");
  const supplementalLeagueId = league.id;
  const [team] = await db.insert(teams).values({
    name: `Owned Adoption Team ${fixtureSuffix}`,
    number: 1,
    leagueId: supplementalLeagueId,
  }).returning({ id: teams.id });
  if (!team) throw new Error("supplemental adoption team was not created");
  const [bowler] = await db.insert(bowlers).values({
    organizationId,
    name: `Owned Adoption Bowler ${fixtureSuffix}`,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("supplemental adoption bowler was not created");
  const generationCommandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: generationCommandId,
    organizationId,
    leagueId: supplementalLeagueId,
    actorUserId,
    commandType: "generate",
    idempotencyKey: `owned-adoption-generation-${fixtureSuffix}`,
    requestFingerprint: `owned-adoption-generation-fingerprint-${fixtureSuffix}`,
  });
  const supplementalGenerationRunId = randomUUID();
  await db.insert(leagueOccurrenceGenerationRuns).values({
    id: supplementalGenerationRunId,
    organizationId,
    leagueId: supplementalLeagueId,
    originatingCommandId: generationCommandId,
    generatorVersion: "owned-adoption-supplemental-v1",
    inputFingerprint: `owned-adoption-supplemental-input-${fixtureSuffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { fixtureKind: "legacy_published_schedule" },
    rangeStartDate: "2038-02-01",
    rangeEndDate: additionalDates.at(-1) ?? "2038-02-08",
    candidateOccurrenceCount: 2 + additionalDates.length,
    generatedOccurrenceCount: 2 + additionalDates.length,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: "2038-01-01T00:00:00.000Z",
    approvedByUserId: actorUserId,
    approvalCommandId: generationCommandId,
  });
  const scope: AdoptionScheduleFixtureScope = {
    organizationId,
    leagueId: supplementalLeagueId,
    locationId,
    generationRunId: supplementalGenerationRunId,
    actorUserId,
    keySuffix: fixtureSuffix,
  };
  const firstOccurrenceId = await createPublishedOccurrence(1, "2038-02-01", scope, weeklyFeeMinor);
  const secondOccurrenceId = await createPublishedOccurrence(2, "2038-02-08", scope, weeklyFeeMinor);
  const extraOccurrenceIds = await Promise.all(additionalDates.map((date, index) =>
    createPublishedOccurrence(index + 3, date, scope, weeklyFeeMinor)));
  const mainScope: AdoptionObligationFixtureScope = { ...scope, bowlerId: bowler.id, teamId: team.id };
  const secondObligationId = await createPayerObligation(secondOccurrenceId, "2038-02-08", mainScope, weeklyFeeMinor);
  const dueAt = "2038-02-01T19:00:00.000Z";
  const [slot] = await db.insert(teamPaymentSlots).values({
    organizationId,
    leagueId: supplementalLeagueId,
    teamId: team.id,
    slotIndex: 0,
    lineupSize: 3,
    occupant: "rotating",
    mainBowlerId: null,
    recordedByUserId: actorUserId,
  }).returning({ id: teamPaymentSlots.id });
  if (!slot) throw new Error("team payment slot is missing");
  const [teamResponsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId: supplementalLeagueId,
    occurrenceId: firstOccurrenceId,
    teamId: team.id,
    slotId: slot.id,
    slotIndex: 0,
    positionIndex: 0,
    responsibilityKind: "rotating",
    policy: "main_pays_full",
    amountMinor: weeklyFeeMinor,
    currency: "USD",
    dueAt,
    pastDueAt: dueAt,
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  if (!teamResponsibility) throw new Error("team assignment responsibility is missing");
  const teamObligationId = await db.transaction(async (tx) => {
    const [teamObligation] = await tx.insert(paymentObligations).values({
      organizationId,
      leagueId: supplementalLeagueId,
      occurrenceId: firstOccurrenceId,
      responsibilityId: teamResponsibility.id,
      component: "full",
      payerBowlerId: null,
      amountMinor: weeklyFeeMinor,
      currency: "USD",
      dueAt,
      pastDueAt: dueAt,
      state: "open",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
    if (!teamObligation) throw new Error("team assignment obligation is missing");
    await tx.insert(rotatingOccurrenceAssignments).values({
      organizationId,
      leagueId: supplementalLeagueId,
      occurrenceId: firstOccurrenceId,
      teamId: team.id,
      slotId: slot.id,
      slotIndex: 0,
      responsibilityId: teamResponsibility.id,
      version: 1,
      actualBowlerId: bowler.id,
      recordedByUserId: actorUserId,
    });
    await tx.insert(paymentObligationOwnerRevisions).values({
      organizationId,
      leagueId: supplementalLeagueId,
      obligationId: teamObligation.id,
      revisionNumber: 1,
      ownerKind: "team",
      ownerBowlerId: null,
      ownerTeamId: team.id,
      reason: "rotating_conversion",
      recordedByUserId: actorUserId,
    });
    return teamObligation.id;
  });
  await db.insert(weeklyPaymentWeekConfirmations).values({
    organizationId,
    leagueId: supplementalLeagueId,
    occurrenceId: firstOccurrenceId,
    revision: 1,
    stateFingerprint: `lvmanagepayments:v1:${"4".repeat(64)}`,
    requestFingerprint: `lvmanagepaymentsrequest:v1:${"5".repeat(64)}`,
    responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${"6".repeat(64)}`,
    idempotencyKey: `owned-adoption-confirm-${fixtureSuffix}`,
    requestSnapshot: { fixture: true },
    recordedByUserId: actorUserId,
  });

  const paymentCreatedAt = "2038-02-04T16:30:00.000Z";
  const [legacyPaymentId, rotatingPaymentId, legacyAllocationIds] = await db.transaction(async (tx) => {
    const [legacyPayment] = await tx.insert(payments).values({
      organizationId,
      leagueId: supplementalLeagueId,
      bowlerId: bowler.id,
      amount: legacyPaymentAmountMinor,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt: paymentCreatedAt,
    }).returning({ id: payments.id });
    if (!legacyPayment) throw new Error("legacy manual payment is missing");
    const legacyAllocationInputs = [
      ...(teamAllocationAmountMinor > 0 ? [{ obligationId: teamObligationId, amountMinor: teamAllocationAmountMinor }] : []),
      ...(futureAllocationAmountMinor > 0 ? [{ obligationId: secondObligationId, amountMinor: futureAllocationAmountMinor }] : []),
    ];
    if (legacyAllocationInputs.reduce((sum, row) => sum + row.amountMinor, 0) !== legacyPaymentAmountMinor) {
      throw new Error("supplemental adoption payment does not match its allocations");
    }
    const legacyAllocations = await tx.insert(paymentAllocations).values(legacyAllocationInputs.map((row) => ({
      organizationId,
      leagueId: supplementalLeagueId,
      paymentId: legacyPayment.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      currency: "USD" as const,
      state: "active" as const,
      allocationKind: "ordinary" as const,
      recordedByUserId: actorUserId,
    }))).returning({ id: paymentAllocations.id });
    const [rotatingPayment] = await tx.insert(payments).values({
      organizationId,
      leagueId: supplementalLeagueId,
      bowlerId: bowler.id,
      amount: 700,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt: paymentCreatedAt,
    }).returning({ id: payments.id });
    if (!rotatingPayment) throw new Error("rotating manual payment is missing");
    await tx.insert(rotatingCreditFundings).values({
      organizationId,
      leagueId: supplementalLeagueId,
      bowlerId: bowler.id,
      paymentId: rotatingPayment.id,
      amountMinor: 700,
      currency: "USD",
      fundingKind: "cash",
      idempotencyKey: `owned-adopt-rotating-${fixtureSuffix}`,
      requestFingerprint: `lvrotcrreq:v1:${"7".repeat(64)}`,
      quoteFingerprint: `lvrotcrquote:v1:${"8".repeat(64)}`,
      actorUserId,
      createdAt: paymentCreatedAt,
    });
    return [legacyPayment.id, rotatingPayment.id, legacyAllocations.map((row) => row.id)] as const;
  });
  return {
    leagueId: supplementalLeagueId,
    generationRunId: supplementalGenerationRunId,
    keySuffix: fixtureSuffix,
    teamId: team.id,
    bowlerId: bowler.id,
    firstOccurrenceId,
    secondOccurrenceId,
    extraOccurrenceIds,
    secondObligationId,
    legacyManualPaymentId: legacyPaymentId,
    rotatingManualPaymentId: rotatingPaymentId,
    legacyAllocationIds,
  };
}

async function createStandingCorrectedProviderFixture(key: string): Promise<{
  leagueId: number;
  paymentId: number;
  payerBowlerId: number;
  partnerBowlerId: number;
}> {
  const fixture = await createSupplementalAdoptionFixture(`standing-${key}`, [
    "2038-02-15",
    "2038-02-22",
    "2038-03-01",
  ]);
  const fixtureScope: AdoptionScheduleFixtureScope = {
    organizationId,
    leagueId: fixture.leagueId,
    locationId,
    generationRunId: fixture.generationRunId,
    actorUserId,
    keySuffix: fixture.keySuffix,
  };
  const [firstAdditionalOccurrenceId, secondAdditionalOccurrenceId, thirdAdditionalOccurrenceId] = fixture.extraOccurrenceIds;
  if (!secondAdditionalOccurrenceId || !thirdAdditionalOccurrenceId) {
    throw new Error("standing adoption fixture schedule is incomplete");
  }
  if (!firstAdditionalOccurrenceId) throw new Error("standing adoption first extra occurrence is missing");
  const [payer] = await db.insert(bowlers).values({
    organizationId,
    name: `Standing Adoption Payer ${fixture.keySuffix}`,
  }).returning({ id: bowlers.id });
  if (!payer) throw new Error("standing adoption payer is missing");
  const payerSourceObligationId = await createPayerObligation(fixture.firstOccurrenceId, "2038-02-01", {
    ...fixtureScope,
    bowlerId: payer.id,
    teamId: fixture.teamId,
  });
  const partnerSourceObligationId = await createPayerObligation(firstAdditionalOccurrenceId, "2038-02-15", {
    ...fixtureScope,
    bowlerId: fixture.bowlerId,
    teamId: fixture.teamId,
  });
  const payerReplacementObligationIds = [
    await createPayerObligation(secondAdditionalOccurrenceId, "2038-02-22", {
      ...fixtureScope,
      bowlerId: payer.id,
      teamId: fixture.teamId,
    }),
    await createPayerObligation(thirdAdditionalOccurrenceId, "2038-03-01", {
      ...fixtureScope,
      bowlerId: payer.id,
      teamId: fixture.teamId,
    }),
  ];
  for (const [index, occurrenceId] of [secondAdditionalOccurrenceId, thirdAdditionalOccurrenceId].entries()) {
    await db.insert(weeklyPaymentWeekConfirmations).values({
      organizationId,
      leagueId: fixture.leagueId,
      occurrenceId,
      revision: 1,
      stateFingerprint: `lvmanagepayments:v1:${(index + 7).toString(16).repeat(64)}`,
      requestFingerprint: `lvmanagepaymentsrequest:v1:${(index + 8).toString(16).repeat(64)}`,
      responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${(index + 9).toString(16).repeat(64)}`,
      idempotencyKey: `owned-adoption-standing-confirm-${fixture.keySuffix}-${index}`,
      requestSnapshot: { fixture: true },
      recordedByUserId: actorUserId,
    });
  }

  const operationId = randomUUID();
  const providerPaymentId = `owned-adoption-standing-${operationId}`;
  const snapshotFingerprint = `lvstandingcutoff:v1:${createHash("sha256").update(key).digest("hex")}`;
  const now = "2038-03-02T20:00:00.000Z";
  const cutoffAt = "2038-02-01T19:00:00.000Z";
  const rowObligations = [
    { allocationIndex: 0, obligationId: payerSourceObligationId, payerBowlerId: payer.id, amountMinor: 500 },
    { allocationIndex: 1, obligationId: fixture.secondObligationId, payerBowlerId: fixture.bowlerId, amountMinor: 500 },
    { allocationIndex: 2, obligationId: partnerSourceObligationId, payerBowlerId: fixture.bowlerId, amountMinor: 500 },
  ];
  const [consent] = await db.insert(autopayConsents).values({
    organizationId,
    leagueId: fixture.leagueId,
    payerBowlerId: payer.id,
    consentVersion: 1,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${"a".repeat(64)}`,
    providerName: "square",
    providerLocationId: "square-proof-location",
    encryptedSourceId: "fixture-encrypted-source",
    encryptedCustomerId: "fixture-encrypted-customer",
    createdByUserId: actorUserId,
    activatedAt: "2038-01-15T12:00:00.000Z",
    createdAt: "2038-01-15T12:00:00.000Z",
  }).returning({ id: autopayConsents.id });
  if (!consent) throw new Error("standing adoption consent is missing");
  const [link] = await db.insert(bowlerPaymentLinks).values({
    bowlerAId: Math.min(payer.id, fixture.bowlerId),
    bowlerBId: Math.max(payer.id, fixture.bowlerId),
    organizationId,
    status: "accepted",
    createdByUserId: actorUserId,
    invitedAt: "2038-01-14T12:00:00.000Z",
    respondedAt: "2038-01-15T12:00:00.000Z",
  }).returning();
  if (!link) throw new Error("standing adoption partner link is missing");
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
    leagueId: fixture.leagueId,
    consentId: consent.id,
    consentVersion: 1,
    partnerBowlerId: fixture.bowlerId,
    paymentLinkId: link.id,
    linkFingerprint,
  });

  const [payment] = await db.transaction(async (tx) => {
    await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      leagueId: fixture.leagueId,
      authorizingUserId: actorUserId,
      operationType: "standing_autopay_charge",
      targetKey: `owned-adoption-standing-${operationId}`,
      triggerOccurrenceId: fixture.firstOccurrenceId,
      amountMinor: 1_500,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"b".repeat(64)}`,
      providerIdempotencyKey: `owned-adoption-${operationId}`.slice(0, 45),
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
      leagueId: fixture.leagueId,
      snapshotVersion: 2,
      snapshotKind: "standing_autopay",
      collectionMode: "weekly",
      cutoffAt,
      amountMinor: 1_500,
      currency: "USD",
      obligations: rowObligations,
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
      leagueId: fixture.leagueId,
      consentId: consent.id,
      consentVersion: 1,
      providerName: "square",
      providerLocationId: "square-proof-location",
      triggerOccurrenceId: fixture.firstOccurrenceId,
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
    await tx.insert(paymentOperationStandingAutopayParticipants).values(rowObligations.map((row) => ({
      operationId,
      organizationId,
      leagueId: fixture.leagueId,
      allocationIndex: row.allocationIndex,
      obligationId: row.obligationId,
      bowlerId: row.payerBowlerId,
      role: row.allocationIndex === 0 ? "payer" as const : "partner" as const,
      paymentLinkId: row.allocationIndex === 0 ? null : link.id,
      linkFingerprint: row.allocationIndex === 0 ? null : linkFingerprint,
      consentVersion: 1,
      createdAt: now,
    })));
    await tx.insert(paymentOperationRosterSnapshotItems).values(rowObligations.map((row) => ({
      operationId,
      organizationId,
      leagueId: fixture.leagueId,
      obligationId: row.obligationId,
      allocationIndex: row.allocationIndex,
      amountMinor: row.amountMinor,
      state: "finalized" as const,
      createdAt: now,
    })));
    const [createdPayment] = await tx.insert(payments).values({
      organizationId,
      leagueId: fixture.leagueId,
      bowlerId: payer.id,
      amount: 1_500,
      currency: "USD",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operationId,
      paidByUserId: actorUserId,
      createdAt: now,
    }).returning({ id: payments.id });
    if (!createdPayment) throw new Error("standing adoption provider payment is missing");
    await tx.insert(paymentAllocations).values(rowObligations.map((row) => ({
      organizationId,
      leagueId: fixture.leagueId,
      paymentId: createdPayment.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      currency: "USD" as const,
      state: "active" as const,
      allocationKind: "ordinary" as const,
      recordedByUserId: actorUserId,
    })));
    return [createdPayment] as const;
  });
  if (!payment) throw new Error("standing adoption payment was not returned");
  const sourceAllocations = await db.select().from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, organizationId),
    eq(paymentAllocations.leagueId, fixture.leagueId),
    eq(paymentAllocations.paymentId, payment.id),
  )).orderBy(paymentAllocations.id);
  const targetAllocations = [
    { obligationId: payerSourceObligationId, amountMinor: 500 },
    { obligationId: payerReplacementObligationIds[0] ?? "", amountMinor: 500 },
    { obligationId: payerReplacementObligationIds[1] ?? "", amountMinor: 500 },
  ];
  if (sourceAllocations.length !== 3 || targetAllocations.some((row) => !row.obligationId)) {
    throw new Error("standing adoption correction evidence is incomplete");
  }
  const requestWithoutFingerprint = {
    paymentId: payment.id,
    expectedOldAllocationFingerprint: historicalSquareAllocationFingerprint(sourceAllocations.map((row) => ({
      allocationId: row.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: row.state,
      allocationKind: row.allocationKind,
    }))),
    expectedTargetAllocationFingerprint: historicalSquareAllocationFingerprint(targetAllocations.map((row) => ({
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: "active" as const,
      allocationKind: "ordinary" as const,
    }))),
    targetAllocations,
    reason: "owned adoption corrected authorization fixture",
    idempotencyKey: `owned-adoption-correction-${fixture.keySuffix}`,
  };
  await correctHistoricalSquarePaymentAllocation({
    organizationId,
    leagueId: fixture.leagueId,
    actorUserId,
    allowlist: { organizationId, leagueId: fixture.leagueId, paymentAmountsMinor: { [payment.id]: 1_500 } },
    request: {
      ...requestWithoutFingerprint,
      requestFingerprint: historicalSquareAllocationCorrectionFingerprint({
        organizationId,
        leagueId: fixture.leagueId,
        request: requestWithoutFingerprint,
      }),
    },
  });
  return {
    leagueId: fixture.leagueId,
    paymentId: payment.id,
    payerBowlerId: payer.id,
    partnerBowlerId: fixture.bowlerId,
  };
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: "Owned Payment Adoption Fixture",
    slug: `owned-payment-adoption-${suffix}`,
  }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Adoption Fixture Location" })
    .returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Owned Payment Adoption Fixture",
    organizationId,
    locationId,
    payingLineupSize: 3,
    weeklyFee: 10,
    seasonStart: "2038-02-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [actor] = await db.insert(users).values({
    email: `owned-adoption-${suffix}@example.test`,
    password: "fixture-password-hash",
    name: "Adoption Fixture Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const generationCommandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: generationCommandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "generate",
    idempotencyKey: `owned-adoption-generation-${suffix}`,
    requestFingerprint: `owned-adoption-generation-fingerprint-${suffix}`,
  });
  generationRunId = randomUUID();
  await db.insert(leagueOccurrenceGenerationRuns).values({
    id: generationRunId,
    organizationId,
    leagueId,
    originatingCommandId: generationCommandId,
    generatorVersion: "owned-adoption-legacy-test-v1",
    inputFingerprint: `owned-adoption-legacy-input-${suffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { fixtureKind: "legacy_published_schedule" },
    rangeStartDate: "2038-02-01",
    rangeEndDate: "2038-02-08",
    candidateOccurrenceCount: 2,
    generatedOccurrenceCount: 2,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: "2038-01-01T00:00:00.000Z",
    approvedByUserId: actorUserId,
    approvalCommandId: generationCommandId,
  });
  const [bowler] = await db.insert(bowlers).values({ organizationId, name: "Adoption Fixture Bowler" })
    .returning({ id: bowlers.id });
  bowlerId = bowler.id;
  const [team] = await db.insert(teams).values({ name: "Adoption Fixture Team", number: 1, leagueId })
    .returning({ id: teams.id });
  teamId = team.id;
  occurrenceIds = [await createPublishedOccurrence(1, "2038-02-01"), await createPublishedOccurrence(2, "2038-02-08")];

  const firstOccurrenceId = occurrenceIds[0];
  const secondOccurrenceId = occurrenceIds[1];
  if (!firstOccurrenceId || !secondOccurrenceId) throw new Error("adoption fixture schedule is incomplete");
  const obligationIds = [
    await createPayerObligation(firstOccurrenceId, "2038-02-01"),
    await createPayerObligation(secondOccurrenceId, "2038-02-08"),
  ];
  await db.transaction(async (tx) => {
    const [payment] = await tx.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId,
      amount: 1_200,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt: "2038-02-04T16:30:00.000Z",
    }).returning({ id: payments.id });
    if (!payment) throw new Error("adoption fixture payment was not created");
    await tx.insert(paymentAllocations).values(obligationIds.map((obligationId, index) => ({
      organizationId,
      leagueId,
      paymentId: payment.id,
      obligationId,
      amountMinor: index === 0 ? 900 : 300,
      currency: "USD" as const,
      state: "active" as const,
      allocationKind: "ordinary" as const,
      recordedByUserId: actorUserId,
    })));
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("owned payment ledger adoption preflight", () => {
  it("uses the previous day before the latest actual local week and the pre-season boundary", () => {
    expect(deriveOwnedPaymentAdoptionCutoff(["2026-10-02", "2026-10-03", "2026-10-10"], "2026-10-03"))
      .toBe("2026-10-02");
    expect(deriveOwnedPaymentAdoptionCutoff(["2026-10-04", "2026-10-11"], "2026-10-03"))
      .toBe("2026-10-03");
    expect(localDateForInstant("2026-10-04T06:30:00.000Z", "America/Los_Angeles"))
      .toBe("2026-10-03");
  });

  it("plans exact manual sources, honors explicit confirmation, and releases future allocations without writing", async () => {
    const firstOccurrenceId = occurrenceIds[0];
    if (!firstOccurrenceId) throw new Error("adoption fixture schedule did not create its first occurrence");
    await db.insert(weeklyPaymentWeekConfirmations).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      revision: 1,
      stateFingerprint: `lvmanagepayments:v1:${"1".repeat(64)}`,
      requestFingerprint: `lvmanagepaymentsrequest:v1:${"2".repeat(64)}`,
      responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${"3".repeat(64)}`,
      idempotencyKey: `owned-adoption-confirm-${suffix}`,
      requestSnapshot: { fixture: true },
      recordedByUserId: actorUserId,
    });
    const before = await Promise.all([
      db.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundingAuthorizationItems.id }).from(weeklyPaymentFundingAuthorizationItems).where(eq(weeklyPaymentFundingAuthorizationItems.leagueId, leagueId)),
      db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id }).from(weeklyPaymentLedgerAdoptionAllocationProofs).where(eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofSteps.id }).from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, leagueId)),
      db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(weeklyPaymentAllocationReleases.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceipts.id }).from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceiptRevisions.id }).from(weeklyPaymentWorksheetReceiptRevisions).where(eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWeekConfirmations.id }).from(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.leagueId, leagueId)),
    ]);

    const first = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    const replay = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    expect(first.ready).toBe(true);
    expect(first.adoptedThroughLocalDate).toBe("2038-01-31");
    expect(first.counts).toEqual({
      paidPayments: 1,
      genericFundingPortions: 1,
      retainedAllocations: 1,
      genericAllocationReleases: 1,
      rotatingAllocationReleases: 0,
      grandfatheredAllocations: 0,
      manualReceipts: 1,
      preservedVoidedPayments: 0,
    });
    expect(first.resultFingerprint).toMatch(/^lvweeklyadopt:v1:[0-9a-f]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^lvweeklyadoptpre:v1:[0-9a-f]{64}$/);
    expect(first.blockers).toEqual([]);
    expect(replay.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(replay.resultFingerprint).toBe(first.resultFingerprint);
    const after = await Promise.all([
      db.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, leagueId)),
      db.select({ id: weeklyPaymentFundingAuthorizationItems.id }).from(weeklyPaymentFundingAuthorizationItems).where(eq(weeklyPaymentFundingAuthorizationItems.leagueId, leagueId)),
      db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id }).from(weeklyPaymentLedgerAdoptionAllocationProofs).where(eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, leagueId)),
      db.select({ id: weeklyPaymentLedgerAdoptionAllocationProofSteps.id }).from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, leagueId)),
      db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(weeklyPaymentAllocationReleases.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceipts.id }).from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWorksheetReceiptRevisions.id }).from(weeklyPaymentWorksheetReceiptRevisions).where(eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, leagueId)),
      db.select({ id: weeklyPaymentWeekConfirmations.id }).from(weeklyPaymentWeekConfirmations).where(eq(weeklyPaymentWeekConfirmations.leagueId, leagueId)),
    ]);
    expect(after).toEqual(before);
  });

  it("counts retained manual cross-owner allocations as blockers without guessing authorization", async () => {
    const firstOccurrenceId = occurrenceIds[0];
    if (!firstOccurrenceId) throw new Error("adoption fixture schedule did not create its first occurrence");
    const [otherOwner] = await db.insert(bowlers).values({ organizationId, name: "Adoption Fixture Other Owner" })
      .returning({ id: bowlers.id });
    if (!otherOwner) throw new Error("manual cross-owner fixture owner was not created");
    const dueAt = "2038-02-01T19:00:00.000Z";
    const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      teamId,
      responsibilityKind: "worksheet",
      worksheetFeeComponent: "full",
      payerBowlerId: otherOwner.id,
      amountMinor: 500,
      currency: "USD",
      dueAt,
      pastDueAt: dueAt,
      recordedByUserId: actorUserId,
    }).returning({ id: occurrencePaymentResponsibilities.id });
    const [obligation] = await db.insert(paymentObligations).values({
      organizationId,
      leagueId,
      occurrenceId: firstOccurrenceId,
      responsibilityId: responsibility.id,
      component: "full",
      payerBowlerId: otherOwner.id,
      amountMinor: 500,
      currency: "USD",
      dueAt,
      pastDueAt: dueAt,
      state: "open",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
    const [allocation] = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        leagueId,
        bowlerId,
        amount: 500,
        currency: "USD",
        status: "paid",
        type: "cash",
        createdAt: dueAt,
      }).returning({ id: payments.id });
      return tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: obligation.id,
        amountMinor: 500,
        currency: "USD",
        state: "active",
        allocationKind: "ordinary",
        recordedByUserId: actorUserId,
      }).returning({ id: paymentAllocations.id });
    });
    if (!allocation) throw new Error("manual cross-owner fixture allocation is missing");

    const preflight = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId }, db);
    const blocker = preflight.blockers.find((row) => row.code === "CROSS_OWNER_ALLOCATION_AUTHORIZATION_UNPROVEN");
    expect(preflight.ready).toBe(false);
    expect(blocker).toEqual({
      code: "CROSS_OWNER_ALLOCATION_AUTHORIZATION_UNPROVEN",
      count: 1,
      entityIds: [allocation.id],
    });
  });

  it("applies only the reviewed plan, keeps same-bowler team assignments, and preserves rotating cash receipts", async () => {
    const fixture = await createSupplementalAdoptionFixture(`apply-${randomUUID().slice(0, 8)}`);
    const plan = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId: fixture.leagueId }, db);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toEqual({
      paidPayments: 2,
      genericFundingPortions: 1,
      retainedAllocations: 1,
      genericAllocationReleases: 1,
      rotatingAllocationReleases: 0,
      grandfatheredAllocations: 0,
      manualReceipts: 2,
      preservedVoidedPayments: 0,
    });

    const applied = await applyOwnedPaymentLedgerAdoption({
      organizationId,
      leagueId: fixture.leagueId,
      actorUserId,
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedResultFingerprint: plan.resultFingerprint,
    }, db);
    expect(applied.replayed).toBe(false);
    expect(applied.sourceFingerprint).toBe(plan.sourceFingerprint);
    expect(applied.resultFingerprint).toBe(plan.resultFingerprint);
    expect(applied.grandfatheredAllocationCount).toBe(0);

    const storedApplications = await db.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, fixture.leagueId),
    ));
    expect(storedApplications).toHaveLength(2);
    const teamApplication = storedApplications.find((row) => row.allocationId === fixture.legacyAllocationIds[0]);
    expect(teamApplication?.targetKind).toBe("legacy_team_assignment");
    expect(teamApplication?.creditedBowlerId).toBe(fixture.bowlerId);
    expect(teamApplication?.assignmentId).not.toBeNull();
    expect(await db.select().from(weeklyPaymentLedgerAdoptionAllocationProofs).where(and(
      eq(weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, organizationId),
      eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, fixture.leagueId),
    ))).toHaveLength(0);
    const [futureAllocation] = await db.select().from(paymentAllocations).where(eq(paymentAllocations.id, fixture.legacyAllocationIds[1] ?? ""));
    expect(futureAllocation?.state).toBe("voided");
    const [release] = await db.select().from(weeklyPaymentAllocationReleases).where(eq(
      weeklyPaymentAllocationReleases.sourceAllocationId,
      fixture.legacyAllocationIds[1] ?? "",
    ));
    expect(release?.reason).toBe("ledger_adoption");

    const [adoptedGenericFunding] = await db.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, fixture.leagueId),
      eq(weeklyPaymentFundings.paymentId, fixture.legacyManualPaymentId),
    ));
    expect(adoptedGenericFunding?.adoptionId).toBe(applied.adoptionId);
    expect(await db.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, fixture.leagueId),
      eq(weeklyPaymentFundings.paymentId, fixture.rotatingManualPaymentId),
    ))).toHaveLength(0);
    const receiptRevisions = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, fixture.leagueId),
    ));
    expect(receiptRevisions.map((row) => row.paymentId).sort()).toEqual([
      fixture.legacyManualPaymentId,
      fixture.rotatingManualPaymentId,
    ].sort());
    expect(receiptRevisions.every((row) => row.businessCollectionLocalDate === "2038-02-04")).toBe(true);

    const snapshot = await readManagePaymentsWorksheetSnapshot({
      organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: fixture.firstOccurrenceId,
    });
    const worksheetRow = snapshot.teams.flatMap((team) => team.rows).find((row) => row.bowlerId === fixture.bowlerId);
    expect(worksheetRow?.manualReceipts.map((receipt) => receipt.paymentId).sort()).toEqual([
      fixture.legacyManualPaymentId,
      fixture.rotatingManualPaymentId,
    ].sort());
    expect(worksheetRow?.manualReceipts.map((receipt) => receipt.amountMinor).sort((a, b) => a - b)).toEqual([700, 1_500]);
    expect(snapshot.revision).toBe(1);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = { organizationId, leagueId: fixture.leagueId };
      const adoption = await readOwnedLedgerAdoptionInTransaction(tx, scope);
      if (!adoption) throw new Error("adopted account snapshot is missing");
      const preloaded = await readOwnedPaymentLedgerReadSnapshotInTransaction(tx, scope, adoption);
      const preloadedBalances = await readOwnedAccountBalancesInTransaction(tx, scope, preloaded);
      const standaloneBalances = await readOwnedAccountBalancesInTransaction(tx, scope);
      const preloadedDebt = await readConfirmedOwnedObligationsInTransaction(tx, scope, preloaded);
      const standaloneDebt = await readConfirmedOwnedObligationsInTransaction(tx, scope);
      expect([...preloadedBalances]).toEqual([...standaloneBalances]);
      expect(preloadedBalances.get(fixture.bowlerId)).toEqual({
        bowlerId: fixture.bowlerId,
        availableCreditMinor: 1_200,
        confirmedOwedMinor: 0,
        netBalanceMinor: 1_200,
      });
      expect(preloadedDebt).toEqual(standaloneDebt);
      const standaloneCanonical = await readCanonicalDuePastDueV3InTransaction(tx, scope);
      const preloadedCanonical = await readCanonicalDuePastDueV3InTransaction(tx, {
        ...scope,
        ledgerReadSnapshot: preloaded,
      });
      expect(preloadedCanonical).toEqual(standaloneCanonical);
    });

    await db.transaction(async (tx) => {
      const receiptId = await createManualReceiptHeadInTransaction(tx, {
        organizationId,
        leagueId: fixture.leagueId,
        occurrenceId: fixture.firstOccurrenceId,
        bowlerId: fixture.bowlerId,
        now: "2038-02-05T12:00:00.000Z",
      });
      const paymentId = await createManualReceiptPaymentInTransaction(tx, {
        organizationId,
        leagueId: fixture.leagueId,
        actorUserId,
        occurrenceId: fixture.firstOccurrenceId,
        idempotencyKey: `owned-adoption-post-${randomUUID().slice(0, 8)}`,
      }, {
        receiptId,
        bowlerId: fixture.bowlerId,
        amountMinor: 100,
        businessDate: "2038-02-05",
      }, "2038-02-05T12:00:00.000Z");
      await appendManualReceiptRevisionInTransaction(tx, {
        organizationId,
        leagueId: fixture.leagueId,
        actorUserId,
        receiptId,
        revision: 1,
        paymentId,
        amountMinor: 100,
        businessCollectionLocalDate: "2038-02-05",
        revisionKind: "manual_record",
        now: "2038-02-05T12:00:00.000Z",
      });
    });
    const replay = await applyOwnedPaymentLedgerAdoption({
      organizationId,
      leagueId: fixture.leagueId,
      actorUserId,
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedResultFingerprint: plan.resultFingerprint,
    }, db);
    expect(replay).toEqual({ ...applied, replayed: true });
    expect(await db.select().from(weeklyPaymentLedgerAdoptions).where(and(
      eq(weeklyPaymentLedgerAdoptions.organizationId, organizationId),
      eq(weeklyPaymentLedgerAdoptions.leagueId, fixture.leagueId),
    ))).toHaveLength(1);
    expect(await db.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, fixture.leagueId),
      eq(weeklyPaymentFundings.adoptionId, applied.adoptionId),
    ))).toHaveLength(1);
  });

  it("reopens a $25 future obligation after adopting its $10 receipt as owner credit", async () => {
    const fixture = await createSupplementalAdoptionFixture(`partial-release-${randomUUID().slice(0, 8)}`, [], {
      weeklyFeeMinor: 2_500,
      legacyPaymentAmountMinor: 1_000,
      teamAllocationAmountMinor: 0,
      futureAllocationAmountMinor: 1_000,
    });
    await db.update(paymentObligations).set({ state: "partially_settled" }).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, fixture.leagueId),
      eq(paymentObligations.id, fixture.secondObligationId),
    ));
    const [preAdoptionObligation] = await db.select({
      state: paymentObligations.state,
      amountMinor: paymentObligations.amountMinor,
    }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, fixture.leagueId),
      eq(paymentObligations.id, fixture.secondObligationId),
    ));
    const [preAdoptionAllocation] = await db.select({
      amountMinor: paymentAllocations.amountMinor,
      state: paymentAllocations.state,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, fixture.leagueId),
      eq(paymentAllocations.paymentId, fixture.legacyManualPaymentId),
      eq(paymentAllocations.obligationId, fixture.secondObligationId),
    ));
    expect(preAdoptionObligation).toEqual({ state: "partially_settled", amountMinor: 2_500 });
    expect(preAdoptionAllocation).toEqual({ amountMinor: 1_000, state: "active" });

    const plan = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId: fixture.leagueId }, db);
    expect(plan.ready).toBe(true);
    expect(plan.adoptedThroughLocalDate).toBe("2038-01-31");
    expect(plan.counts).toEqual({
      paidPayments: 2,
      genericFundingPortions: 1,
      retainedAllocations: 0,
      genericAllocationReleases: 1,
      rotatingAllocationReleases: 0,
      grandfatheredAllocations: 0,
      manualReceipts: 2,
      preservedVoidedPayments: 0,
    });

    const applied = await applyOwnedPaymentLedgerAdoption({
      organizationId,
      leagueId: fixture.leagueId,
      actorUserId,
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedResultFingerprint: plan.resultFingerprint,
    }, db);
    expect(applied.replayed).toBe(false);

    const [obligation] = await db.select({
      state: paymentObligations.state,
      amountMinor: paymentObligations.amountMinor,
    }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, fixture.leagueId),
      eq(paymentObligations.id, fixture.secondObligationId),
    ));
    expect(obligation).toEqual({ state: "open", amountMinor: 2_500 });

    const [parentPayment] = await db.select({
      amount: payments.amount,
      type: payments.type,
      status: payments.status,
    }).from(payments).where(eq(payments.id, fixture.legacyManualPaymentId));
    expect(parentPayment).toEqual({ amount: 1_000, type: "cash", status: "paid" });

    const [allocation] = await db.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, fixture.leagueId),
      eq(paymentAllocations.paymentId, fixture.legacyManualPaymentId),
      eq(paymentAllocations.obligationId, fixture.secondObligationId),
    ));
    expect(allocation).toMatchObject({ amountMinor: 1_000, state: "voided" });
    const [application] = await db.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, fixture.leagueId),
      eq(paymentAllocationFundingApplications.allocationId, allocation?.id ?? ""),
    ));
    expect(application).toMatchObject({
      paymentId: fixture.legacyManualPaymentId,
      creditedBowlerId: fixture.bowlerId,
      amountMinor: 1_000,
      obligationId: fixture.secondObligationId,
    });
    const [release] = await db.select().from(weeklyPaymentAllocationReleases).where(and(
      eq(weeklyPaymentAllocationReleases.organizationId, organizationId),
      eq(weeklyPaymentAllocationReleases.leagueId, fixture.leagueId),
      eq(weeklyPaymentAllocationReleases.sourceAllocationId, allocation?.id ?? ""),
    ));
    expect(release).toMatchObject({
      paymentId: fixture.legacyManualPaymentId,
      creditedBowlerId: fixture.bowlerId,
      fundingApplicationId: application?.id,
      sourceObligationId: fixture.secondObligationId,
      sourceApplicationAmountMinor: 1_000,
      releasedAmountMinor: 1_000,
      retainedAmountMinor: 0,
      replacementAllocationId: null,
      reason: "ledger_adoption",
    });
    expect(release?.transactionId).toMatch(/^[0-9]+$/);

    const [funding] = await db.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, fixture.leagueId),
      eq(weeklyPaymentFundings.paymentId, fixture.legacyManualPaymentId),
    ));
    expect(funding).toMatchObject({
      paymentId: fixture.legacyManualPaymentId,
      creditedBowlerId: fixture.bowlerId,
      amountMinor: 1_000,
    });
    const receiptRevision = await db.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, fixture.leagueId),
      eq(weeklyPaymentWorksheetReceiptRevisions.paymentId, fixture.legacyManualPaymentId),
    ));
    expect(receiptRevision).toHaveLength(1);
    expect(receiptRevision[0]).toMatchObject({ amountMinor: 1_000, revisionKind: "manual_record" });
  });

  it("applies multi-owner standing capture portions and corrected proofs independent of generated UUID order", async () => {
    const fixture = await createStandingCorrectedProviderFixture(randomUUID().slice(0, 8));
    const plan = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId: fixture.leagueId }, db);
    expect(plan.ready).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({
      paidPayments: 3,
      genericFundingPortions: 3,
      retainedAllocations: 4,
      genericAllocationReleases: 1,
      grandfatheredAllocations: 2,
    });
    expect(await db.select().from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, organizationId),
      eq(paymentAllocationCorrections.leagueId, fixture.leagueId),
      eq(paymentAllocationCorrections.paymentId, fixture.paymentId),
    ))).toHaveLength(2);

    const token = randomUUID().replaceAll("-", "");
    const fundingFunction = `owned_adopt_funding_order_${token}`;
    const proofFunction = `owned_adopt_proof_order_${token}`;
    const fundingTrigger = `owned_adopt_funding_order_${token}`;
    const proofTrigger = `owned_adopt_proof_order_${token}`;
    const fundingHighId = `f0000000-0000-4000-8000-${token.slice(0, 12)}`;
    const fundingLowId = `10000000-0000-4000-8000-${token.slice(12, 24)}`;
    const proofHighId = `e0000000-0000-4000-8000-${token.slice(0, 12)}`;
    const proofLowId = `20000000-0000-4000-8000-${token.slice(12, 24)}`;
    await db.execute(sql.raw(`CREATE FUNCTION public.${fundingFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.league_id = ${fixture.leagueId} AND NEW.payment_id = ${fixture.paymentId} THEN
          IF NEW.portion_index = 0 THEN NEW.id := '${fundingHighId}'::uuid;
          ELSIF NEW.portion_index = 1 THEN NEW.id := '${fundingLowId}'::uuid;
          END IF;
        END IF;
        RETURN NEW;
      END;
    $$`));
    await db.execute(sql.raw(`CREATE FUNCTION public.${proofFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE existing_count integer;
      BEGIN
        IF NEW.league_id = ${fixture.leagueId} THEN
          SELECT count(*) INTO existing_count FROM public.weekly_payment_ledger_adoption_allocation_proofs
            WHERE adoption_id = NEW.adoption_id;
          IF existing_count = 0 THEN NEW.id := '${proofHighId}'::uuid;
          ELSE NEW.id := '${proofLowId}'::uuid;
          END IF;
        END IF;
        RETURN NEW;
      END;
    $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${fundingTrigger} BEFORE INSERT ON public.weekly_payment_fundings
        FOR EACH ROW EXECUTE FUNCTION public.${fundingFunction}()`));
      await db.execute(sql.raw(`CREATE TRIGGER ${proofTrigger} BEFORE INSERT ON public.weekly_payment_ledger_adoption_allocation_proofs
        FOR EACH ROW EXECUTE FUNCTION public.${proofFunction}()`));
      const applied = await applyOwnedPaymentLedgerAdoption({
        organizationId,
        leagueId: fixture.leagueId,
        actorUserId,
        expectedSourceFingerprint: plan.sourceFingerprint,
        expectedResultFingerprint: plan.resultFingerprint,
      }, db);
      expect(applied.replayed).toBe(false);

      const providerFundings = await db.select().from(weeklyPaymentFundings).where(and(
        eq(weeklyPaymentFundings.organizationId, organizationId),
        eq(weeklyPaymentFundings.leagueId, fixture.leagueId),
        eq(weeklyPaymentFundings.paymentId, fixture.paymentId),
      )).orderBy(weeklyPaymentFundings.id);
      expect(providerFundings.map((row) => ({ portionIndex: row.portionIndex, creditedBowlerId: row.creditedBowlerId })))
        .toEqual([
          { portionIndex: 1, creditedBowlerId: fixture.partnerBowlerId },
          { portionIndex: 0, creditedBowlerId: fixture.payerBowlerId },
        ]);
      const providerAuthorizationItems = await db.select().from(weeklyPaymentFundingAuthorizationItems).where(and(
        eq(weeklyPaymentFundingAuthorizationItems.organizationId, organizationId),
        eq(weeklyPaymentFundingAuthorizationItems.leagueId, fixture.leagueId),
        eq(weeklyPaymentFundingAuthorizationItems.paymentId, fixture.paymentId),
      )).orderBy(weeklyPaymentFundingAuthorizationItems.fundingId, weeklyPaymentFundingAuthorizationItems.sourceAllocationIndex);
      expect(providerAuthorizationItems.map((row) => [row.creditedBowlerId, row.sourceAllocationIndex])).toEqual([
        [fixture.partnerBowlerId, 1],
        [fixture.partnerBowlerId, 2],
        [fixture.payerBowlerId, 0],
      ]);
      const proofs = await db.select().from(weeklyPaymentLedgerAdoptionAllocationProofs).where(and(
        eq(weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, organizationId),
        eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, fixture.leagueId),
        eq(weeklyPaymentLedgerAdoptionAllocationProofs.adoptionId, applied.adoptionId),
      )).orderBy(weeklyPaymentLedgerAdoptionAllocationProofs.id);
      expect(proofs).toHaveLength(2);
      expect(proofs.map((row) => row.id)).toEqual([proofLowId, proofHighId]);
      const proofSteps = await db.select().from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(and(
        eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.organizationId, organizationId),
        eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, fixture.leagueId),
        inArray(weeklyPaymentLedgerAdoptionAllocationProofSteps.proofId, proofs.map((row) => row.id)),
      ));
      expect(proofSteps).toHaveLength(2);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fundingTrigger} ON public.weekly_payment_fundings`));
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${proofTrigger} ON public.weekly_payment_ledger_adoption_allocation_proofs`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${fundingFunction}()`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${proofFunction}()`));
    }
  });

  it("refuses a stale reviewed source fingerprint before writing any adoption rows", async () => {
    const fixture = await createSupplementalAdoptionFixture(`stale-${randomUUID().slice(0, 8)}`);
    const plan = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId: fixture.leagueId }, db);
    expect(plan.ready).toBe(true);
    await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        leagueId: fixture.leagueId,
        bowlerId: fixture.bowlerId,
        amount: 25,
        currency: "USD",
        status: "paid",
        type: "cash",
        createdAt: "2038-02-06T12:00:00.000Z",
      }).returning({ id: payments.id });
      if (!payment) throw new Error("stale plan payment was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId: fixture.leagueId,
        paymentId: payment.id,
        obligationId: fixture.secondObligationId,
        amountMinor: 25,
        currency: "USD",
        state: "active",
        allocationKind: "ordinary",
        recordedByUserId: actorUserId,
      });
    });
    await expect(applyOwnedPaymentLedgerAdoption({
      organizationId,
      leagueId: fixture.leagueId,
      actorUserId,
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedResultFingerprint: plan.resultFingerprint,
    }, db)).rejects.toMatchObject({ code: "ADOPTION_PREFLIGHT_STALE" });
    expect(await db.select().from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, fixture.leagueId))).toHaveLength(0);
    expect(await db.select().from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, fixture.leagueId))).toHaveLength(0);
    expect(await db.select().from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, fixture.leagueId))).toHaveLength(0);
  });

  it("rolls back the marker and earlier writes when an adoption funding insert fails", async () => {
    const fixture = await createSupplementalAdoptionFixture(`rollback-${randomUUID().slice(0, 8)}`);
    const plan = await preflightOwnedPaymentLedgerAdoption({ organizationId, leagueId: fixture.leagueId }, db);
    expect(plan.ready).toBe(true);
    const token = randomUUID().replaceAll("-", "");
    const functionName = `owned_adoption_fail_${token}`;
    const triggerName = `owned_adoption_fail_${token}`;
    await db.execute(sql.raw(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned adoption test fault'; END; $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.weekly_payment_fundings FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`));
      await expect(applyOwnedPaymentLedgerAdoption({
        organizationId,
        leagueId: fixture.leagueId,
        actorUserId,
        expectedSourceFingerprint: plan.sourceFingerprint,
        expectedResultFingerprint: plan.resultFingerprint,
      }, db)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON public.weekly_payment_fundings`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${functionName}()`));
    }
    expect(await db.select().from(weeklyPaymentLedgerAdoptions).where(eq(weeklyPaymentLedgerAdoptions.leagueId, fixture.leagueId))).toHaveLength(0);
    expect(await db.select().from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.leagueId, fixture.leagueId))).toHaveLength(0);
    expect(await db.select().from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.leagueId, fixture.leagueId))).toHaveLength(0);
    expect(await db.select().from(weeklyPaymentWorksheetReceipts).where(eq(weeklyPaymentWorksheetReceipts.leagueId, fixture.leagueId))).toHaveLength(0);
    const originalAllocations = await db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, fixture.legacyManualPaymentId));
    expect(originalAllocations.map((row) => row.state)).toEqual(["active", "active"]);
  });
});
