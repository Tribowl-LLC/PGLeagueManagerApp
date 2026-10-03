import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  financialCommands,
  leagueOccurrences,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  accountPaymentOperationSnapshots,
  organizations,
  paymentAllocations,
  paymentAllocationFundingApplications,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  paymentVoids,
  refundPaymentOperationSnapshots,
  paymentOperationRosterSnapshots,
  payments,
  rotatingCreditFundings,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  rotatingCreditRefunds,
  teamPaymentPolicies,
  teamPaymentSlots,
  teamPaymentSlotRevisions,
  teams,
  users,
} from "@shared/schema";
import { getTestDb, getTestPool } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { getPayments, getPaymentsPaginated, getVisiblePaymentByIdForOrganization } from "../../server/storage/payments";
import { updateBowler } from "../../server/storage/bowlers";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import {
  finalizeRosterSnapshotInTransaction,
  RosterSnapshotFinalizationError,
} from "../../server/services/roster-payment-finalizer";
import { recoverRosterPaymentOperation, recoverRosterPaymentOperationByRequestKey } from "../../server/services/roster-payment-recovery";
import { acquireInteractivePaymentOperationDispatchCutoff } from "../../server/storage/payment-operations";
import { canonicalCashPaymentDeleteFingerprint, canonicalCashPaymentEditFingerprint, canonicalCorrectionFingerprint, canonicalHistoricalCashAllocationRepairFingerprint, canonicalResponsibilityFingerprint, canonicalRosterFingerprint, chargeInteractiveObligations, correctCanonicalAllocation, deleteCanonicalCashPayment, editCanonicalCashPayment, historicalCashAllocationFingerprint, quoteInteractiveObligations, recordCanonicalManualPayment, recordOccurrenceResponsibilities, repairHistoricalCashPaymentAllocation, saveTeamRoster, type HistoricalCashAllocationRepairRequest } from "../../server/services/roster-payment-core";
import { interactivePaymentOperationExecutor } from "../../server/services/interactive-payment-operation-executor";
import { paymentOperationRetryExecutor } from "../../server/services/payment-operation-retry-executor";
import { prepareInteractivePaymentOperation } from "../../server/services/interactive-payment-operation-preparation";
import { prepareAccountPaymentOperation } from "../../server/services/account-payment-operation-preparation";
import { chargeAccountPaymentFundingV4, quoteAccountPaymentFundingV4 } from "../../server/services/account-payment-funding";
import { finalizeChargeFromWebhookEvidenceInTransaction } from "../../server/storage/payment-operations";
import { buildCanonicalScheduleCommandFingerprint, cancelOccurrence, rescheduleOccurrence } from "../../server/services/canonical-occurrence-transactions";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { readCanonicalPaymentReport } from "../../server/services/canonical-payment-report";
import * as paymentProviderFactory from "../../server/services/payment-provider-factory";
import * as ownedPaymentLedger from "../../server/services/owned-payment-ledger";
import { decrypt } from "../../server/utils/crypto";
import { expectErrorLog } from "../helpers/expected-error-logs";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slug = `roster-payment-finalizer-${suffix}`;
let organizationId: number;
let leagueId: number;
let accountLeagueId: number;
let accountFailureLeagueId: number;
let adoptedReplayLeagueId: number;
let locationId: number;
let teamId: number;
let accountTeamId: number;
let accountFailureTeamId: number;
let bowlerId: number;
let actorUserId: number;
let occurrenceOrdinal = 0;
let occurrenceFixtureIdentity = 0;
let historyProjectionFixtureState: { canonicalScheduleRevision: number } | null = null;
const activeTestGenerationRunIds: string[] = [];

function requirePayerBowlerId(payerBowlerId: number | null): number {
  if (payerBowlerId === null) throw new Error("Expected a bowler-owned roster obligation");
  return payerBowlerId;
}

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  for (const row of leftovers) await deleteOrganization(row.id);
  const [organization] = await db.insert(organizations).values({ name: "Roster Finalizer Fixture", slug }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "Roster Fixture Location" }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "Roster Finalizer League",
    organizationId,
    locationId: location.id,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;
  const [accountLeague] = await db.insert(leagues).values({
    name: "Roster Account Funding League",
    organizationId,
    locationId: location.id,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  accountLeagueId = accountLeague.id;
  const [accountFailureLeague] = await db.insert(leagues).values({
    name: "Roster Account Funding Failure League",
    organizationId,
    locationId: location.id,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  accountFailureLeagueId = accountFailureLeague.id;
  const [adoptedReplayLeague] = await db.insert(leagues).values({
    name: "Roster Adopted Replay League",
    organizationId,
    locationId: location.id,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  adoptedReplayLeagueId = adoptedReplayLeague.id;
  const [actor] = await db.insert(users).values({
    email: `roster-finalizer-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Roster Finalizer Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [team] = await db.insert(teams).values({ name: "Roster Fixture Team", number: 1, leagueId }).returning({ id: teams.id });
  teamId = team.id;
  const [accountTeam] = await db.insert(teams).values({ name: "Roster Account Funding Team", number: 1, leagueId: accountLeagueId }).returning({ id: teams.id });
  accountTeamId = accountTeam.id;
  const [accountFailureTeam] = await db.insert(teams).values({ name: "Roster Account Failure Team", number: 1, leagueId: accountFailureLeagueId }).returning({ id: teams.id });
  accountFailureTeamId = accountFailureTeam.id;
  const [adoptedReplayTeam] = await db.insert(teams).values({ name: "Roster Adopted Replay Team", number: 1, leagueId: adoptedReplayLeagueId }).returning({ id: teams.id });
  const [bowler] = await db.insert(bowlers).values({ name: "Roster Fixture Main", email: "roster-main@example.test", organizationId }).returning({ id: bowlers.id });
  bowlerId = bowler.id;
  await db.insert(bowlerLeagues).values([
    { bowlerId, leagueId, teamId },
    { bowlerId, leagueId: accountLeagueId, teamId: accountTeamId },
    { bowlerId, leagueId: accountFailureLeagueId, teamId: accountFailureTeam.id },
    { bowlerId, leagueId: adoptedReplayLeagueId, teamId: adoptedReplayTeam.id },
  ]);
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId: adoptedReplayLeagueId, teamId: adoptedReplayTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId: adoptedReplayLeagueId, teamId: adoptedReplayTeam.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId: adoptedReplayLeagueId, teamId: adoptedReplayTeam.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

// Each test owns its occurrence/payment evidence. Release only unfinished
// reservations and void untouched obligations so the next FIFO test starts
// with no historical debt; settled/payment evidence remains immutable.
afterEach(async () => {
  if (!organizationId) return;
  for (const runId of activeTestGenerationRunIds.splice(0)) {
    const [run] = await db.select({ state: leagueOccurrenceGenerationRuns.state }).from(leagueOccurrenceGenerationRuns).where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, leagueId),
      eq(leagueOccurrenceGenerationRuns.id, runId),
    ));
    if (run?.state !== "approved" && run?.state !== "applied") continue;
    const commandId = randomUUID();
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "edit_schedule",
      idempotencyKey: `roster-finalizer-run-cleanup-${runId}`,
      requestFingerprint: `roster-finalizer-run-cleanup-${randomUUID()}`,
    });
    await db.update(leagueOccurrenceGenerationRuns).set({
      state: "superseded",
      supersededAt: new Date().toISOString(),
      supersededByCommandId: commandId,
    }).where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, leagueId),
      eq(leagueOccurrenceGenerationRuns.id, runId),
    ));
  }
  await db.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
  ));
  await db.transaction(async (tx) => {
    const activePayments = await tx.select({ paymentId: paymentAllocations.paymentId, leagueId: paymentAllocations.leagueId }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.state, "active"),
    ));
    const uniquePaymentScopes = new Map(activePayments.map((row) => [`${row.leagueId}:${row.paymentId}`, row]));
    for (const { paymentId, leagueId: paymentLeagueId } of uniquePaymentScopes.values()) {
      await tx.insert(paymentVoids).values({ organizationId, leagueId: paymentLeagueId, paymentId, reason: "test fixture cleanup", recordedByUserId: actorUserId });
      await tx.update(payments).set({ status: "voided" }).where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId), eq(payments.leagueId, paymentLeagueId)));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, paymentLeagueId),
        eq(paymentAllocations.paymentId, paymentId),
        eq(paymentAllocations.state, "active"),
      ));
    }
  });
  await db.update(paymentObligations).set({ state: "voided", voidedAt: "2038-12-31T23:59:59.000Z" }).where(and(
    eq(paymentObligations.organizationId, organizationId),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
  ));
  await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
  if (historyProjectionFixtureState) {
    await db.update(leagues).set({ canonicalScheduleRevision: historyProjectionFixtureState.canonicalScheduleRevision }).where(and(
      eq(leagues.id, leagueId),
      eq(leagues.organizationId, organizationId),
    ));
    historyProjectionFixtureState = null;
  }
});

async function createOccurrence(options: {
  preserveOccurrenceOrdinal?: boolean;
  plannedOrdinal?: number;
  authoritativeLocalDate?: string;
  targetLeagueId?: number;
} = {}) {
  if (!options.preserveOccurrenceOrdinal) occurrenceOrdinal += 1;
  occurrenceFixtureIdentity += 1;
  const targetLeagueId = options.targetLeagueId ?? leagueId;
  const plannedOrdinal = options.plannedOrdinal ?? occurrenceOrdinal;
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId: targetLeagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `roster-finalizer-publish-${suffix}-${occurrenceFixtureIdentity}`,
    requestFingerprint: `roster-finalizer-fingerprint-${occurrenceFixtureIdentity}`,
  });
  const authoritativeLocalDate = options.authoritativeLocalDate
    ?? new Date(Date.UTC(2038, 1, occurrenceOrdinal + 1, 19, 0, 0)).toISOString().slice(0, 10);
  const startAt = new Date(`${authoritativeLocalDate}T19:00:00.000Z`).toISOString();
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId: targetLeagueId,
    locationId,
    generationKey: `roster-finalizer-occurrence-${suffix}-${occurrenceFixtureIdentity}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "roster-finalizer-test",
    plannedOrdinal,
    competitionNumber: plannedOrdinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id, authoritativeLocalDate: leagueOccurrences.authoritativeLocalDate, startAt: leagueOccurrences.startAt });
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId,
    leagueId: targetLeagueId,
    occurrenceId: occurrence.id,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: plannedOrdinal,
    version: 1,
    state: "published",
    publishedAt: startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId: targetLeagueId, occurrenceId: occurrence.id, actorUserId });
  });
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, targetLeagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
    eq(occurrencePaymentResponsibilities.state, "active"),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
  ));
  if (!responsibility) throw new Error("fixture responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(and(
    eq(paymentObligations.responsibilityId, responsibility.id),
    eq(paymentObligations.organizationId, organizationId),
    eq(paymentObligations.leagueId, targetLeagueId),
  ));
  if (!obligation) throw new Error("fixture obligation was not materialized");
  return { occurrence, responsibility, obligation };
}

async function createAppliedGenerationRun(occurrences: Awaited<ReturnType<typeof createOccurrence>>[], sourceScheduleRevision = 1) {
  const originatingCommandId = randomUUID();
  const approvalCommandId = randomUUID();
  const generationRunId = randomUUID();
  const commandPrefix = `roster-finalizer-generation-${suffix}-${randomUUID()}`;
  await db.insert(leagueScheduleCommands).values([
    {
      id: originatingCommandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "generate",
      idempotencyKey: `${commandPrefix}:generate`,
      requestFingerprint: `${commandPrefix}:generate-fingerprint`,
    },
    {
      id: approvalCommandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "approve_generation",
      idempotencyKey: `${commandPrefix}:approve`,
      requestFingerprint: `${commandPrefix}:approve-fingerprint`,
    },
  ]);
  const dates = occurrences.map(({ occurrence }) => occurrence.authoritativeLocalDate).sort();
  const rangeStartDate = dates[0] ?? "2038-01-01";
  const rangeEndDate = dates.at(-1) ?? rangeStartDate;
  const generatedCount = occurrences.length;
  await db.insert(leagueOccurrenceGenerationRuns).values({
    id: generationRunId,
    organizationId,
    leagueId,
    originatingCommandId,
    generatorVersion: `roster-finalizer-history-paid-weeks-${randomUUID()}`,
    inputFingerprint: `history-paid-weeks-${randomUUID()}`,
    sourceScheduleRevision,
    normalizedInputSnapshot: { fixture: "history-paid-weeks" },
    rangeStartDate,
    rangeEndDate,
    candidateOccurrenceCount: generatedCount,
    generatedOccurrenceCount: generatedCount,
    skippedDateCount: 0,
    discrepancyCount: 0,
    state: "applied",
    approvedAt: new Date().toISOString(),
    approvedByUserId: actorUserId,
    approvalCommandId,
  });
  activeTestGenerationRunIds.push(generationRunId);
  if (occurrences.length > 0) {
    await db.update(leagueOccurrences).set({ generationRunId }).where(and(
      eq(leagueOccurrences.organizationId, organizationId),
      eq(leagueOccurrences.leagueId, leagueId),
      inArray(leagueOccurrences.id, occurrences.map(({ occurrence }) => occurrence.id)),
    ));
  }
  return generationRunId;
}

async function createPublishedDoublePayGroup(input: {
  generationRunId: string;
  trigger: Awaited<ReturnType<typeof createOccurrence>>;
  paired: Awaited<ReturnType<typeof createOccurrence>>;
  groupOrdinal: number;
  sourceScheduleRevision?: number;
}) {
  const groupId = randomUUID();
  const commandId = randomUUID();
  const fingerprint = `lvcollectiongroup:v1:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish_collection_group",
    idempotencyKey: `roster-finalizer-history-pair-${suffix}-${randomUUID()}`,
    requestFingerprint: `roster-finalizer-history-pair-${randomUUID()}`,
  });
  const terms = await db.select().from(leagueOccurrenceBillingTerms).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, leagueId),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, [input.trigger.occurrence.id, input.paired.occurrence.id]),
    eq(leagueOccurrenceBillingTerms.state, "published"),
  ));
  const termByOccurrenceId = new Map(terms.map((term) => [term.occurrenceId, term]));
  const triggerTerm = termByOccurrenceId.get(input.trigger.occurrence.id);
  const pairedTerm = termByOccurrenceId.get(input.paired.occurrence.id);
  if (!triggerTerm || !pairedTerm || triggerTerm.billingOrdinal === null || pairedTerm.billingOrdinal === null) {
    throw new Error("history final-pair fixture is missing current billing terms");
  }
  await db.insert(canonicalCollectionGroups).values({
    id: groupId,
    organizationId,
    leagueId,
    generationRunId: input.generationRunId,
    sourceScheduleRevision: input.sourceScheduleRevision ?? 1,
    kind: "double_pay",
    state: "published",
    groupOrdinal: input.groupOrdinal,
    triggerLocalDate: input.trigger.occurrence.authoritativeLocalDate,
    pairedLocalDate: input.paired.occurrence.authoritativeLocalDate,
    contractVersion: "history-paid-weeks-test",
    fingerprintVersion: "v1",
    fingerprint,
    currentRevision: 1,
    lastCommandId: commandId,
    publishedAt: input.trigger.occurrence.startAt,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.insert(canonicalCollectionGroupMembers).values([
    {
      organizationId,
      leagueId,
      groupId,
      generationRunId: input.generationRunId,
      occurrenceId: input.trigger.occurrence.id,
      billingTermId: triggerTerm.id,
      role: "trigger",
      memberOrdinal: 1,
      localDate: input.trigger.occurrence.authoritativeLocalDate,
      billingOrdinal: triggerTerm.billingOrdinal,
      amountMinor: triggerTerm.defaultAmountMinor,
      currency: triggerTerm.currency,
      active: true,
      currentRevision: 1,
      lastCommandId: commandId,
    },
    {
      organizationId,
      leagueId,
      groupId,
      generationRunId: input.generationRunId,
      occurrenceId: input.paired.occurrence.id,
      billingTermId: pairedTerm.id,
      role: "paired",
      memberOrdinal: 2,
      localDate: input.paired.occurrence.authoritativeLocalDate,
      billingOrdinal: pairedTerm.billingOrdinal,
      amountMinor: pairedTerm.defaultAmountMinor,
      currency: pairedTerm.currency,
      active: true,
      currentRevision: 1,
      lastCommandId: commandId,
    },
  ]);
  return groupId;
}

async function resetBaseRosterToWeeklyMain(options: { preserveOccurrenceOrdinal?: boolean } = {}): Promise<void> {
  // Earlier lifecycle tests intentionally move one fixture to 2038-03-15;
  // keep these additional season-batch fixtures outside that date range.
  if (!options.preserveOccurrenceOrdinal) occurrenceOrdinal = Math.max(occurrenceOrdinal, 100);
  await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(and(
    eq(leagues.organizationId, organizationId),
    eq(leagues.id, leagueId),
  ));
  await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: bowlerId }).where(and(
    eq(teamPaymentSlots.organizationId, organizationId),
    eq(teamPaymentSlots.leagueId, leagueId),
    eq(teamPaymentSlots.teamId, teamId),
    eq(teamPaymentSlots.slotIndex, 0),
  ));
  await db.update(teamPaymentSlots).set({ occupant: "vacant", mainBowlerId: null }).where(and(
    eq(teamPaymentSlots.organizationId, organizationId),
    eq(teamPaymentSlots.leagueId, leagueId),
    eq(teamPaymentSlots.teamId, teamId),
    inArray(teamPaymentSlots.slotIndex, [1, 2]),
  ));
}

async function createUpfrontFallbackFixture() {
  const fixtureKey = randomUUID();
  const [fixtureLeague] = await db.insert(leagues).values({
    name: `Upfront fallback league ${fixtureKey}`,
    organizationId,
    locationId,
    payingLineupSize: 3,
    paymentMode: "upfront",
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    seasonStart: "2039-01-01T00:00:00.000Z",
    seasonEnd: "2039-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  const [fixtureTeam] = await db.insert(teams).values({ name: `Upfront fallback team ${fixtureKey}`, number: 1, leagueId: fixtureLeague.id }).returning({ id: teams.id });
  await db.insert(bowlerLeagues).values({ bowlerId, leagueId: fixtureLeague.id, teamId: fixtureTeam.id });
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId: fixtureLeague.id, teamId: fixtureTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId: fixtureLeague.id, teamId: fixtureTeam.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId: fixtureLeague.id, teamId: fixtureTeam.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);

  let fixtureOccurrenceOrdinal = 0;
  const createFixtureOccurrence = async () => {
    fixtureOccurrenceOrdinal += 1;
    const commandId = randomUUID();
    const startAt = new Date(Date.UTC(2039, 1, fixtureOccurrenceOrdinal + 1, 19, 0, 0)).toISOString();
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId,
      leagueId: fixtureLeague.id,
      actorUserId,
      commandType: "publish",
      idempotencyKey: `upfront-fallback-publish-${fixtureKey}-${fixtureOccurrenceOrdinal}`,
      requestFingerprint: `upfront-fallback-fingerprint-${fixtureKey}-${fixtureOccurrenceOrdinal}`,
    });
    const [occurrence] = await db.insert(leagueOccurrences).values({
      organizationId,
      leagueId: fixtureLeague.id,
      locationId,
      generationKey: `upfront-fallback-occurrence-${fixtureKey}-${fixtureOccurrenceOrdinal}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "published",
      authoritativeLocalDate: startAt.slice(0, 10),
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      startAt,
      selectedUtcOffsetMinutes: 0,
      foldResolution: "unambiguous",
      resolverVersion: "roster-finalizer-test",
      plannedOrdinal: fixtureOccurrenceOrdinal,
      competitionNumber: fixtureOccurrenceOrdinal,
      competitive: true,
      countsInStandings: true,
      publishedAt: startAt,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    }).returning({ id: leagueOccurrences.id });
    await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId,
      leagueId: fixtureLeague.id,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2_000,
      currency: "USD",
      billingOrdinal: fixtureOccurrenceOrdinal,
      version: 1,
      state: "published",
      publishedAt: startAt,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    });
    await db.transaction(async (tx) => {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId: fixtureLeague.id, occurrenceId: occurrence.id, actorUserId });
    });
    const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, fixtureLeague.id),
      eq(occurrencePaymentResponsibilities.occurrenceId, occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, fixtureTeam.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    if (!responsibility) throw new Error("upfront fallback responsibility was not materialized");
    const [obligation] = await db.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, fixtureLeague.id),
      eq(paymentObligations.responsibilityId, responsibility.id),
    ));
    if (!obligation) throw new Error("upfront fallback obligation was not materialized");
    return { occurrence, responsibility, obligation };
  };

  return { leagueId: fixtureLeague.id, teamId: fixtureTeam.id, createOccurrence: createFixtureOccurrence };
}

async function createRosterOperation(
  obligationId: string,
  responsibilityId: string,
  operationAmount = 2_000,
  options: { withCanonicalPayment?: boolean } = {},
) {
  const withCanonicalPayment = options.withCanonicalPayment ?? true;
  const operationId = randomUUID();
  const providerPaymentId = `roster-provider-${operationId}`;
  return db.transaction(async (tx) => {
    const [operation] = await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:roster-finalizer:${operationId}`,
      leagueId,
      amountMinor: operationAmount,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
      providerIdempotencyKey: `roster-${operationId}`.slice(0, 45),
      providerName: "square",
      providerObjectId: providerPaymentId,
      status: "succeeded",
      nextAttemptAt: null,
      completedAt: "2038-02-01T20:00:00.000Z",
    }).returning();
    await tx.insert(paymentOperationRosterSnapshots).values({
      operationId,
      organizationId,
      leagueId,
      snapshotVersion: 2,
      snapshotKind: "interactive",
      locationId,
      providerLocationId: null,
      payerBowlerId: bowlerId,
      requestKind: "direct",
      encryptedSourceId: "fixture-source",
      sourceKind: "new_card",
      quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
      amountMinor: operationAmount,
      currency: "USD",
      obligations: [{ id: obligationId, responsibilityId, responsibilityVersion: 1, payerBowlerId: bowlerId, amountMinor: operationAmount }],
      lineItems: [],
      snapshotFingerprint: `lvrosterexec:v1:${"b".repeat(64)}`,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId, allocationIndex: 0, amountMinor: operationAmount, state: withCanonicalPayment ? "finalized" : "reserved" });
    if (withCanonicalPayment) {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: operationAmount,
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operationId,
        idempotencyKey: `${operationId}:0`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("fixture payment was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId,
        amountMinor: operationAmount,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
      const [obligation] = await tx.select({ amountMinor: paymentObligations.amountMinor }).from(paymentObligations).where(and(
        eq(paymentObligations.id, obligationId),
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
      )).limit(1);
      const [activeTotal] = await tx.select({ amountMinor: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.obligationId, obligationId),
        eq(paymentAllocations.state, "active"),
      ));
      await tx.update(paymentObligations).set({ state: Number(activeTotal?.amountMinor ?? 0) >= Number(obligation?.amountMinor ?? 0) ? "settled" : "partially_settled" }).where(and(
        eq(paymentObligations.id, obligationId),
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
      ));
    }
    if (!operation) throw new Error("fixture operation was not created");
    return { operation };
  });
}

async function ensureOwnedLedgerAdoption(targetLeagueId = leagueId, adoptedThroughLocalDate = "2037-12-31"): Promise<string> {
  const [existing] = await db.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(and(
    eq(weeklyPaymentLedgerAdoptions.organizationId, organizationId),
    eq(weeklyPaymentLedgerAdoptions.leagueId, targetLeagueId),
  )).limit(1);
  if (existing) return existing.id;
  const preflight = randomUUID().replaceAll("-", "").repeat(2);
  const result = randomUUID().replaceAll("-", "").repeat(2);
  const [adoption] = await db.insert(weeklyPaymentLedgerAdoptions).values({
    organizationId,
    leagueId: targetLeagueId,
    adoptedThroughLocalDate,
    preflightFingerprint: `lvweeklyadoptpre:v1:${preflight}`,
    resultFingerprint: `lvweeklyadopt:v1:${result}`,
    grandfatheredAllocationCount: 0,
    recordedByUserId: actorUserId,
  }).returning({ id: weeklyPaymentLedgerAdoptions.id });
  if (!adoption) throw new Error("account funding adoption fixture was not created");
  return adoption.id;
}

async function createAccountFailureForecastObligation() {
  const localDate = "2038-02-01";
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId: accountFailureLeagueId, teamId: accountFailureTeamId, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId: accountFailureLeagueId, teamId: accountFailureTeamId, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId: accountFailureLeagueId, teamId: accountFailureTeamId, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId: accountFailureLeagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `account-failure-forecast-${randomUUID()}`,
    requestFingerprint: `account-failure-forecast-fingerprint-${randomUUID()}`,
  });
  const occurrenceId = randomUUID();
  await db.insert(leagueOccurrences).values({
    id: occurrenceId,
    organizationId,
    leagueId: accountFailureLeagueId,
    locationId,
    generationKey: `account-failure-forecast-${randomUUID()}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: `${localDate}T19:00:00.000Z`,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "account-failure-forecast-test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    publishedAt: `${localDate}T00:00:00.000Z`,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId,
    leagueId: accountFailureLeagueId,
    occurrenceId,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: 1,
    version: 1,
    state: "published",
    publishedAt: `${localDate}T00:00:00.000Z`,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.transaction(async (tx) => materializeRosterPaymentOccurrenceInTransaction(tx, {
    organizationId,
    leagueId: accountFailureLeagueId,
    occurrenceId,
    actorUserId,
  }));
  const [responsibility] = await db.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, accountFailureLeagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrenceId),
    eq(occurrencePaymentResponsibilities.state, "active"),
    eq(occurrencePaymentResponsibilities.slotIndex, 0),
  ));
  if (!responsibility) throw new Error("account failure responsibility was not materialized");
  const [obligation] = await db.select().from(paymentObligations).where(eq(paymentObligations.responsibilityId, responsibility.id));
  if (!obligation) throw new Error("account failure obligation was not materialized");
  return { responsibility, obligation };
}

async function createAccountFundingOperation(input: {
  leagueId?: number;
  requestKey?: string;
  amountMinor?: number;
  quoteFingerprint?: string;
  sourceId?: string;
  now?: Date;
}) {
  const amountMinor = input.amountMinor ?? 2_000;
  const sourceId = input.sourceId ?? `cnon:account-recovery-${randomUUID()}`;
  const operation = await prepareAccountPaymentOperation({
    requestKey: input.requestKey ?? `account-recovery-${randomUUID()}`,
    organizationId,
    leagueId: input.leagueId ?? leagueId,
    payerBowlerId: bowlerId,
    amountMinor,
    fundingPortions: [{ portionIndex: 0, creditedBowlerId: bowlerId, amountMinor }],
    recipientEvidence: [{
      recipientBowlerId: bowlerId,
      role: "self",
      paymentLinkId: null,
      linkFingerprint: null,
      selection: { kind: "explicit_amount", amountMinor },
    }],
    currency: "USD",
    providerName: "square",
    locationId,
    providerLocationId: null,
    authorizingUserId: actorUserId,
    sourceKind: "new_card",
    sourceId,
    customerId: null,
    buyerEmail: "roster-main@example.test",
    storeCard: false,
    quoteFingerprint: input.quoteFingerprint ?? `lvaccountfundquote:v4:${randomUUID().replaceAll("-", "").repeat(2)}`,
    now: input.now,
  });
  return operation;
}

async function createCashEvidence(obligationId: string, amountMinor: number, createdAt = "2038-02-01T12:00:00.000Z") {
  const result = await createCashEvidenceForAllocations([{ obligationId, amountMinor }], createdAt);
  const allocation = result.allocations[0];
  if (!allocation) throw new Error("cash fixture allocation was not created");
  return { payment: result.payment, allocation };
}

async function createCashEvidenceForAllocations(
  rows: Array<{ obligationId: string; amountMinor: number }>,
  createdAt = "2038-02-01T12:00:00.000Z",
) {
  const amountMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
  return db.transaction(async (tx) => {
    // The conservation trigger is deferred, but each parent must still be
    // seeded with its allocation before this transaction commits.
    const [payment] = await tx.insert(payments).values({
      organizationId,
      bowlerId,
      leagueId,
      amount: amountMinor,
      currency: "USD",
      status: "paid",
      type: "cash",
      createdAt,
    }).returning();
    if (!payment) throw new Error("cash fixture payment was not created");
    const allocations = await tx.insert(paymentAllocations).values(rows.map((row) => ({
      organizationId,
      leagueId,
      paymentId: payment.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      currency: "USD" as const,
      recordedByUserId: actorUserId,
    }))).returning();
    if (allocations.length !== rows.length) throw new Error("cash fixture allocations were not created");
    for (const row of rows) {
      await tx.update(paymentObligations).set({ state: row.amountMinor >= 2_000 ? "settled" : "partially_settled" }).where(and(
        eq(paymentObligations.id, row.obligationId),
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
      ));
    }
    return { payment, allocations };
  });
}

function cashEditRequest(paymentId: number, amountMinor: number, paymentDate: string, idempotencyKey = `cash-edit-${randomUUID()}`) {
  const request = {
    paymentId,
    correctionMode: "edit_cash" as const,
    amountMinor,
    paymentDate,
    reason: "cash fixture edit",
    idempotencyKey,
    requestFingerprint: "",
  };
  request.requestFingerprint = canonicalCashPaymentEditFingerprint(request);
  return request;
}

function cashDeleteRequest(paymentId: number, reason = "duplicate cash entry", idempotencyKey = `cash-delete-${randomUUID()}`) {
  const request = { paymentId, reason, idempotencyKey, requestFingerprint: "" };
  request.requestFingerprint = canonicalCashPaymentDeleteFingerprint(request);
  return request;
}

async function expectCashDeletionMarkerOff() {
  const marker = await db.execute(sql`SELECT current_setting('leaguevault.organization_teardown', true) AS marker`);
  expect(marker.rows[0]?.marker).not.toBe("on");
}

function historicalCashRepairRequest(
  paymentId: number,
  sourceAllocations: { id: string; obligationId: string; amountMinor: number } | Array<{ id: string; obligationId: string; amountMinor: number }>,
  targetObligation: string | Array<{ obligationId: string; amountMinor: number }>,
  idempotencyKey = `cash-repair-${randomUUID()}`,
): HistoricalCashAllocationRepairRequest {
  const oldAllocations = Array.isArray(sourceAllocations) ? sourceAllocations : [sourceAllocations];
  const targetAllocations = typeof targetObligation === "string"
    ? [{ obligationId: targetObligation, amountMinor: oldAllocations.reduce((sum, row) => sum + row.amountMinor, 0) }]
    : targetObligation;
  const request: HistoricalCashAllocationRepairRequest = {
    paymentId,
    expectedOldAllocationFingerprint: historicalCashAllocationFingerprint(oldAllocations.map((sourceAllocation) => ({
      allocationId: sourceAllocation.id,
      obligationId: sourceAllocation.obligationId,
      amountMinor: sourceAllocation.amountMinor,
      state: "active",
      allocationKind: "ordinary",
    }))),
    expectedTargetAllocationFingerprint: historicalCashAllocationFingerprint(targetAllocations.map((allocation) => ({
      ...allocation,
      state: "active" as const,
      allocationKind: "ordinary" as const,
    }))),
    targetAllocations,
    reason: "historical cash allocation repair fixture",
    idempotencyKey,
    requestFingerprint: "",
  };
  request.requestFingerprint = canonicalHistoricalCashAllocationRepairFingerprint({ organizationId, leagueId, request });
  return request;
}

function historicalCashRepairAllowlist(paymentId: number, amountMinor: number) {
  return { paymentAmountsMinor: { [String(paymentId)]: amountMinor } };
}

describe("PR1 roster snapshot finalization on PostgreSQL", () => {
  it("projects final-pair flags only from current published group membership", async () => {
    const [leagueBeforeProjection] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(and(
      eq(leagues.id, leagueId),
      eq(leagues.organizationId, organizationId),
    ));
    if (!leagueBeforeProjection) throw new Error("history projection league fixture is missing");
    historyProjectionFixtureState = {
      canonicalScheduleRevision: leagueBeforeProjection.canonicalScheduleRevision,
    };
    await resetBaseRosterToWeeklyMain({ preserveOccurrenceOrdinal: true });
    const triggerA = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_001, authoritativeLocalDate: "2038-05-01" });
    const pairedA = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_002, authoritativeLocalDate: "2038-05-02" });
    const triggerB = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_003, authoritativeLocalDate: "2038-05-03" });
    const pairedB = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_004, authoritativeLocalDate: "2038-05-04" });
    const triggerPartial = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_005, authoritativeLocalDate: "2038-05-05" });
    const pairedPartial = await createOccurrence({ preserveOccurrenceOrdinal: true, plannedOrdinal: 1_000_006, authoritativeLocalDate: "2038-05-06" });
    const generationRunId = await createAppliedGenerationRun([triggerA, pairedA, triggerB, pairedB, triggerPartial, pairedPartial], 1);
    const groupAId = await createPublishedDoublePayGroup({ generationRunId, trigger: triggerA, paired: pairedA, groupOrdinal: 1, sourceScheduleRevision: 2 });
    const groupBId = await createPublishedDoublePayGroup({ generationRunId, trigger: triggerB, paired: pairedB, groupOrdinal: 2, sourceScheduleRevision: 2 });
    await createPublishedDoublePayGroup({ generationRunId, trigger: triggerPartial, paired: pairedPartial, groupOrdinal: 3, sourceScheduleRevision: 2 });
    await db.update(leagues).set({ canonicalScheduleRevision: 2 }).where(and(
      eq(leagues.id, leagueId),
      eq(leagues.organizationId, organizationId),
    ));
    const paymentA = await createCashEvidence(pairedA.obligation.id, 2_000, "2038-02-01T12:00:00.000Z");
    const paymentB = await createCashEvidence(pairedB.obligation.id, 2_000, "2038-02-02T12:00:00.000Z");
    const partialTailPayment = await createCashEvidenceForAllocations([
      { obligationId: triggerPartial.obligation.id, amountMinor: 2_000 },
      { obligationId: pairedPartial.obligation.id, amountMinor: 1_000 },
    ], "2038-02-03T12:00:00.000Z");

    const currentReport = await readCanonicalPaymentReport({ organizationId, leagueId, bowlerId, page: 1, limit: 20 });
    const currentRowA = currentReport.rows.find((row) => row.paymentId === paymentA.payment.id);
    const currentRowB = currentReport.rows.find((row) => row.paymentId === paymentB.payment.id);
    const partialTailRow = currentReport.rows.find((row) => row.paymentId === partialTailPayment.payment.id);
    expect(currentRowA?.allocations[0]?.isFinalPairedWeek).toBe(true);
    expect(currentRowB?.allocations[0]?.isFinalPairedWeek).toBe(true);
    expect(partialTailRow?.allocations.find((allocation) => allocation.occurrenceId === triggerPartial.occurrence.id)?.isFullyCoveredWeek).toBe(true);
    expect(partialTailRow?.allocations.find((allocation) => allocation.occurrenceId === pairedPartial.occurrence.id)).toMatchObject({ isFinalPairedWeek: true });
    expect(partialTailRow?.allocations.find((allocation) => allocation.occurrenceId === pairedPartial.occurrence.id)?.isFullyCoveredWeek).toBeUndefined();

    const revokeCommandId = randomUUID();
    await db.insert(leagueScheduleCommands).values({
      id: revokeCommandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "revoke_collection_group",
      idempotencyKey: `roster-finalizer-revoke-history-pair-${randomUUID()}`,
      requestFingerprint: `roster-finalizer-revoke-history-pair-${randomUUID()}`,
    });
    await db.update(canonicalCollectionGroups).set({
      state: "revoked",
      revokedAt: new Date().toISOString(),
      revokedByUserId: actorUserId,
      revocationCommandId: revokeCommandId,
    }).where(and(
      eq(canonicalCollectionGroups.organizationId, organizationId),
      eq(canonicalCollectionGroups.leagueId, leagueId),
      eq(canonicalCollectionGroups.id, groupBId),
    ));
    const afterRevocation = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: paymentB.payment.id, page: 1, limit: 1 });
    expect(afterRevocation.rows[0]?.allocations[0]?.isFinalPairedWeek).toBeUndefined();

    const supersedeCommandId = randomUUID();
    await db.insert(leagueScheduleCommands).values({
      id: supersedeCommandId,
      organizationId,
      leagueId,
      actorUserId,
      commandType: "edit_schedule",
      idempotencyKey: `roster-finalizer-supersede-history-run-${randomUUID()}`,
      requestFingerprint: `roster-finalizer-supersede-history-run-${randomUUID()}`,
    });
    await db.update(leagueOccurrenceGenerationRuns).set({
      state: "superseded",
      supersededAt: new Date().toISOString(),
      supersededByCommandId: supersedeCommandId,
    }).where(and(
      eq(leagueOccurrenceGenerationRuns.organizationId, organizationId),
      eq(leagueOccurrenceGenerationRuns.leagueId, leagueId),
      eq(leagueOccurrenceGenerationRuns.id, generationRunId),
    ));
    await createAppliedGenerationRun([], 2);
    const afterSupersededGeneration = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: paymentA.payment.id, page: 1, limit: 1 });
    expect(afterSupersededGeneration.rows[0]?.allocations[0]?.isFinalPairedWeek).toBeUndefined();
    const [staleGroup] = await db.select({ state: canonicalCollectionGroups.state }).from(canonicalCollectionGroups).where(eq(canonicalCollectionGroups.id, groupAId));
    expect(staleGroup?.state).toBe("published");
  });

  it("reports valid unused rotating credit without labeling it unresolved evidence", async () => {
    const idempotencyKey = `unused-credit-${randomUUID()}`;
    const paymentId = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 750,
        status: "paid",
        type: "cash",
        idempotencyKey: `${idempotencyKey}:payment`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("unused rotating-credit tender was not created");
      await tx.insert(rotatingCreditFundings).values({
        organizationId,
        leagueId,
        bowlerId,
        paymentId: payment.id,
        amountMinor: 750,
        currency: "USD",
        fundingKind: "cash",
        idempotencyKey,
        requestFingerprint: `lvrotcrreq:v1:${"a".repeat(64)}`,
        quoteFingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
        actorUserId,
      });
      return payment.id;
    });

    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId, page: 1, limit: 1 });
    const row = report.rows[0];
    expect(row).toMatchObject({
      paymentId,
      source: "prepaid_credit",
      unresolved: false,
      reviewRequired: false,
      allocatedMinor: 0,
      unallocatedMinor: 750,
      creditRefunds: { completedAmountMinor: 0, heldAmountMinor: 0, reviewRequired: false },
    });
    expect(row?.receipt.source).toBe("prepaid_credit");

    // This is a tenant-wide report fixture; remove the independent prepaid
    // tender so it cannot affect later totals in the shared organization.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      await tx.delete(rotatingCreditFundings).where(eq(rotatingCreditFundings.paymentId, paymentId));
      await tx.delete(payments).where(eq(payments.id, paymentId));
    });
  });

  it("does not label a fully refunded unused rotating-credit lot as prepaid credit", async () => {
    const idempotencyKey = `full-refund-credit-${randomUUID()}`;
    const paymentId = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 750,
        status: "paid",
        type: "cash",
        idempotencyKey: `${idempotencyKey}:payment`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("fully refunded rotating-credit tender was not created");
      const [funding] = await tx.insert(rotatingCreditFundings).values({
        organizationId,
        leagueId,
        bowlerId,
        paymentId: payment.id,
        amountMinor: 750,
        currency: "USD",
        fundingKind: "cash",
        idempotencyKey,
        requestFingerprint: `lvrotcrreq:v1:${"a".repeat(64)}`,
        quoteFingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
        actorUserId,
      }).returning({ id: rotatingCreditFundings.id });
      if (!funding) throw new Error("fully refunded rotating-credit funding was not created");
      await tx.insert(rotatingCreditRefunds).values({
        organizationId,
        leagueId,
        fundingId: funding.id,
        paymentId: payment.id,
        bowlerId,
        amountMinor: 750,
        currency: "USD",
        refundKind: "cash",
        refundOperationId: null,
        reference: "cash refund receipt 17",
        reason: "Unused share credit refunded in full",
        actorUserId,
        idempotencyKey: `full-refund-${randomUUID()}`,
        requestFingerprint: `lvrotcrrefund:v1:${"c".repeat(64)}`,
        issuedAt: new Date().toISOString(),
      });
      return payment.id;
    });

    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId, page: 1, limit: 1 });
    const row = report.rows[0];
    expect(row).toMatchObject({
      paymentId,
      source: "refunded_credit",
      allocatedMinor: 0,
      unallocatedMinor: 0,
      creditRefunds: { completedAmountMinor: 750, heldAmountMinor: 0, reviewRequired: false },
    });
    expect(row?.receipt.source).toBe("refunded_credit");

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      await tx.delete(rotatingCreditRefunds).where(eq(rotatingCreditRefunds.paymentId, paymentId));
      await tx.delete(rotatingCreditFundings).where(eq(rotatingCreditFundings.paymentId, paymentId));
      await tx.delete(payments).where(eq(payments.id, paymentId));
    });
  });

  it("reports unresolved operation evidence in league-local dates and preserves upfront mode", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "upfront", timezone: "Pacific/Kiritimati" }).where(eq(leagues.id, leagueId));
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-operation-only-${operationId}`,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"d".repeat(64)}`,
      providerIdempotencyKey: `report-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "provider_unknown",
      errorClassification: "provider_unknown",
      errorCode: "REPORT_TEST_PENDING",
      nextAttemptAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId), amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"e".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
    });
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const unresolved = report.rows.find((row) => row.paymentOperationId === operationId);
    expect(report.paymentTiming).toMatchObject({ paymentMode: "upfront", source: "canonical" });
    expect(unresolved).toMatchObject({ source: "unresolved_operation", businessDate: "2038-02-03", authoritativeLocalDate: "2038-02-03", operationStatus: "provider_unknown" });
    expect(unresolved?.allocations[0]).toMatchObject({ occurrenceLocalDate: "2038-02-02", plannedOrdinal: 1, state: null });
  });

  it("does not count a provider-linked payment as confirmed before canonical allocation finalization", async () => {
    const fixture = await createOccurrence();
    const beforeReport = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 100 });
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-missing-allocation-${operationId}`,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
      providerIdempotencyKey: `report-missing-${operationId}`.slice(0, 45),
      providerName: "square",
      // Provider success without local finalization is retained as
      // reconciliation evidence; no orphan parent payment is persisted.
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "LOCAL_FINALIZATION_FAILED",
      nextAttemptAt: null,
      providerObjectId: `provider-${operationId}`,
      completedAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId), amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"2".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
    });
    const paymentsForOperation = await db.select({ id: payments.id }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.paymentOperationId, operationId),
    ));
    expect(paymentsForOperation).toEqual([]);
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const row = report.rows.find((candidate) => candidate.paymentOperationId === operationId);
    expect(row).toMatchObject({
      paymentId: null,
      status: "unresolved",
      reviewRequired: true,
      unresolved: true,
      paymentOperationId: operationId,
      allocatedMinor: 0,
      unallocatedMinor: fixture.obligation.amountMinor,
    });
    expect(report.totals.grossConfirmedPaidMinor).toBe(0);
    expect(report.totals.reviewRequiredMinor - beforeReport.totals.reviewRequiredMinor).toBe(fixture.obligation.amountMinor);
    expect(report.totals.unresolvedOperationMinor - beforeReport.totals.unresolvedOperationMinor).toBe(fixture.obligation.amountMinor);
  });

  it("fails closed for the unallocated item of a succeeded multi-item operation", async () => {
    const first = await createOccurrence();
    const second = await createOccurrence();
    const beforeReport = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
    const operationId = randomUUID();
    const providerPaymentId = `provider-${operationId}`;
    const totalMinor = first.obligation.amountMinor + second.obligation.amountMinor;
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `report-multi-item-${operationId}`,
      leagueId,
      amountMinor: totalMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"1".repeat(64)}`,
      providerIdempotencyKey: `report-multi-${operationId}`.slice(0, 45),
      providerName: "square",
      providerObjectId: providerPaymentId,
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "LOCAL_FINALIZATION_FAILED",
      nextAttemptAt: null,
      completedAt: "2038-02-01T20:00:00.000Z",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: first.obligation.payerBowlerId,
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: totalMinor,
        currency: "USD",
        obligations: [
          { id: first.obligation.id, responsibilityId: first.responsibility.id, responsibilityVersion: first.responsibility.version, payerBowlerId: first.obligation.payerBowlerId, amountMinor: first.obligation.amountMinor },
          { id: second.obligation.id, responsibilityId: second.responsibility.id, responsibilityVersion: second.responsibility.version, payerBowlerId: second.obligation.payerBowlerId, amountMinor: second.obligation.amountMinor },
        ],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"3".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values([
        { operationId, organizationId, leagueId, obligationId: first.obligation.id, allocationIndex: 0, amountMinor: first.obligation.amountMinor, state: "finalized" },
        { operationId, organizationId, leagueId, obligationId: second.obligation.id, allocationIndex: 1, amountMinor: second.obligation.amountMinor, state: "finalized" },
      ]);
    });
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 20 });
    const firstRow = report.rows.find((row) => row.paymentOperationId === operationId);
    expect(firstRow).toMatchObject({ paymentId: null, status: "unresolved", reviewRequired: true, unresolved: true, allocatedMinor: 0, unallocatedMinor: totalMinor });
    expect(report.rows.filter((row) => row.paymentOperationId === operationId)).toHaveLength(1);
    expect(report.totals.grossConfirmedPaidMinor - beforeReport.totals.grossConfirmedPaidMinor).toBe(0);
  });

  it("persists one upfront due instant with no grace window across later occurrences", async () => {
    await db.update(leagues).set({ paymentMode: "upfront", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const first = await createOccurrence();
    const second = await createOccurrence();
    expect(first.obligation.dueAt).toBe(first.obligation.pastDueAt);
    expect(second.obligation.dueAt).toBe(second.obligation.pastDueAt);
    expect(second.obligation.dueAt).toBe(first.obligation.dueAt);
    const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 100 });
    expect(report.paymentTiming).toMatchObject({
      paymentMode: "upfront",
      upfrontDueAt: new Date(first.obligation.dueAt).toISOString(),
      upfrontDueAtLocal: first.obligation.dueAt.slice(0, 10),
      source: "canonical",
    });
  });

  it.each(["sole", "all"] as const)("repairs %s missing upfront default obligation(s) without changing identity", async (missingMode) => {
    const fixture = await createUpfrontFallbackFixture();
    const fixtures = [await fixture.createOccurrence()];
    if (missingMode === "all") {
      fixtures.push(await fixture.createOccurrence(), await fixture.createOccurrence());
    }
    const firstFixture = fixtures[0];
    if (!firstFixture) throw new Error("upfront fallback fixture is missing");
    // Use the persisted responsibility's normalized instant as the established
    // upfront anchor; this avoids coupling the test to transaction timing.
    const anchor = new Date(firstFixture.responsibility.dueAt).toISOString();
    const missingObligationIds = missingMode === "sole"
      ? [firstFixture.obligation.id]
      : fixtures.map((item) => item.obligation.id);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      await tx.delete(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, fixture.leagueId),
        inArray(paymentObligations.id, missingObligationIds),
      ));
    });

    const buildRequest = (mainBowlerId: number, commandKey: string) => {
      const request = {
        commandKey,
        requestFingerprint: "",
        lineupSize: 3 as const,
        slots: [
          { slotIndex: 0, occupant: "main" as const, mainBowlerId },
          { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
          { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
        ],
      };
      request.requestFingerprint = canonicalRosterFingerprint(request);
      return request;
    };
    const readMainEvidence = async () => {
      const rows = [];
      for (const item of fixtures) {
        const [responsibility] = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, state: occurrencePaymentResponsibilities.state, dueAt: occurrencePaymentResponsibilities.dueAt, pastDueAt: occurrencePaymentResponsibilities.pastDueAt }).from(occurrencePaymentResponsibilities).where(and(
          eq(occurrencePaymentResponsibilities.organizationId, organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, fixture.leagueId),
          eq(occurrencePaymentResponsibilities.occurrenceId, item.occurrence.id),
          eq(occurrencePaymentResponsibilities.teamId, fixture.teamId),
          eq(occurrencePaymentResponsibilities.slotIndex, 0),
          eq(occurrencePaymentResponsibilities.state, "active"),
        ));
        if (!responsibility) throw new Error("upfront fallback Main responsibility is missing");
        const obligations = await db.select({ id: paymentObligations.id, payerBowlerId: paymentObligations.payerBowlerId, state: paymentObligations.state, dueAt: paymentObligations.dueAt, pastDueAt: paymentObligations.pastDueAt }).from(paymentObligations).where(and(
          eq(paymentObligations.organizationId, organizationId),
          eq(paymentObligations.leagueId, fixture.leagueId),
          eq(paymentObligations.responsibilityId, responsibility.id),
        ));
        rows.push({ responsibility, obligations });
      }
      return rows;
    };

    const before = await readMainEvidence();
    expect(before.every((item) => item.obligations.length === 0)).toBe(true);
    await saveTeamRoster({ organizationId, leagueId: fixture.leagueId, teamId: fixture.teamId, actorUserId, request: buildRequest(bowlerId, `upfront-repair-${missingMode}-${randomUUID()}`) });
    const afterRepair = await readMainEvidence();
    expect(afterRepair.map((item) => item.responsibility)).toEqual(before.map((item) => item.responsibility));
    expect(afterRepair.every((item) => new Date(item.responsibility.dueAt).toISOString() === anchor && new Date(item.responsibility.pastDueAt).toISOString() === anchor && item.obligations.length === 1 && item.obligations[0]?.payerBowlerId === bowlerId && item.obligations[0]?.state === "open" && new Date(item.obligations[0]?.dueAt ?? "").toISOString() === anchor && new Date(item.obligations[0]?.pastDueAt ?? "").toISOString() === anchor)).toBe(true);
    await saveTeamRoster({ organizationId, leagueId: fixture.leagueId, teamId: fixture.teamId, actorUserId, request: buildRequest(bowlerId, `upfront-repair-repeat-${missingMode}-${randomUUID()}`) });
    const afterRepeat = await readMainEvidence();
    expect(afterRepeat).toEqual(afterRepair);

    const [replacement] = await db.insert(bowlers).values({ name: `Upfront replacement ${missingMode}`, organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: replacement.id, leagueId: fixture.leagueId, teamId: fixture.teamId });
    await saveTeamRoster({ organizationId, leagueId: fixture.leagueId, teamId: fixture.teamId, actorUserId, request: buildRequest(replacement.id, `upfront-change-${missingMode}-${randomUUID()}`) });
    const afterChange = await readMainEvidence();
    for (let index = 0; index < afterChange.length; index += 1) {
      const previous = afterRepair[index];
      const changed = afterChange[index];
      if (!previous || !changed) throw new Error("upfront fallback evidence row is missing");
      expect(changed.responsibility.id).not.toBe(previous.responsibility.id);
      expect(changed.responsibility.version).toBe(previous.responsibility.version + 1);
      expect(changed.responsibility.mainBowlerId).toBe(replacement.id);
      const changedObligation = changed.obligations[0];
      if (!changedObligation) throw new Error("upfront changed obligation is missing");
      expect(changed.obligations).toEqual([{ id: changedObligation.id, payerBowlerId: replacement.id, state: "open", dueAt: changedObligation.dueAt, pastDueAt: changedObligation.pastDueAt }]);
      expect(new Date(changedObligation.dueAt).toISOString()).toBe(anchor);
      expect(new Date(changedObligation.pastDueAt).toISOString()).toBe(anchor);
    }
  });

  it("reschedules a future roster-ready occurrence by versioning open obligations", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const request = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "reschedule" as const,
      occurrenceId: fixture.occurrence.id,
      now: "2038-01-01T00:00:00.000Z",
      authoritativeLocalDate: "2038-03-15",
      authoritativeLocalStartTime: "19:00",
      timezone: "UTC",
      ambiguousFold: "reject" as const,
      idempotencyKey: `roster-reschedule-open-${randomUUID()}`,
      requestFingerprint: "",
      reason: "Move the future session while payment remains open",
    };
    const rescheduled = await rescheduleOccurrence({ ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) });
    expect(rescheduled.id).toBe(fixture.occurrence.id);
    expect(rescheduled.authoritativeLocalDate).toBe("2038-03-15");
    const responsibilities = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state, dueAt: occurrencePaymentResponsibilities.dueAt }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    expect(responsibilities.map((row) => row.state)).toEqual(["voided", "active"]);
    const correctedDueAt = new Date(rescheduled.startAt).toISOString();
    expect(new Date(responsibilities.at(-1)?.dueAt ?? "").toISOString()).toBe(correctedDueAt);
    expect(responsibilities.at(-1)).toMatchObject({ version: 2, state: "active" });
    const obligations = await db.select({ state: paymentObligations.state, dueAt: paymentObligations.dueAt, responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.occurrenceId, fixture.occurrence.id),
      eq(paymentObligations.payerBowlerId, bowlerId),
    )).orderBy(paymentObligations.createdAt);
    expect(obligations.map((row) => row.state)).toEqual(["voided", "open"]);
    expect(new Date(obligations.at(-1)?.dueAt ?? "").toISOString()).toBe(correctedDueAt);
    expect(obligations.at(-1)).toMatchObject({ state: "open", responsibilityId: responsibilities.at(-1)?.id });
  });

  it("blocks reschedule when roster evidence is reserved or paid", async () => {
    const reservedFixture = await createOccurrence();
    const reservedOperation = await createRosterOperation(reservedFixture.obligation.id, reservedFixture.responsibility.id, 2_000, { withCanonicalPayment: false });
    const makeRequest = (occurrenceId: string, key: string) => ({
      organizationId,
      leagueId,
      actorUserId,
      commandType: "reschedule" as const,
      occurrenceId,
      now: "2038-01-01T00:00:00.000Z",
      authoritativeLocalDate: "2038-03-20",
      authoritativeLocalStartTime: "19:00",
      timezone: "UTC",
      ambiguousFold: "reject" as const,
      idempotencyKey: key,
      requestFingerprint: "",
      reason: "Attempt to move an occurrence with payment evidence",
    });
    const reservedRequest = makeRequest(reservedFixture.occurrence.id, `roster-reschedule-reserved-${randomUUID()}`);
    await expect(rescheduleOccurrence({ ...reservedRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(reservedRequest) })).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
    expect(reservedOperation.operation.id).toBeTruthy();

    const paidFixture = await createOccurrence();
    const paidOperation = await createRosterOperation(paidFixture.obligation.id, paidFixture.responsibility.id);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: paidOperation.operation.id, now: "2038-02-01T21:00:00.000Z", actorUserId }));
    const paidRequest = makeRequest(paidFixture.occurrence.id, `roster-reschedule-paid-${randomUUID()}`);
    await expect(rescheduleOccurrence({ ...paidRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(paidRequest) })).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
  });

  it("permits sequential provider partials after the first roster snapshot is finalized", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const first = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 1_000);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId,
      operationId: first.operation.id,
      now: "2038-02-01T21:00:00.000Z",
      actorUserId,
    }));
    const second = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 1_000);
    await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId,
      operationId: second.operation.id,
      now: "2038-02-01T22:00:00.000Z",
      actorUserId,
    }));

    const allocations = await db.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, leagueId),
      eq(paymentAllocations.obligationId, fixture.obligation.id),
      eq(paymentAllocations.state, "active"),
    ));
    const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const items = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, leagueId),
      eq(paymentOperationRosterSnapshotItems.obligationId, fixture.obligation.id),
    ));
    expect(allocations.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([1_000, 1_000]);
    expect(allocations.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(fixture.obligation.amountMinor);
    expect(obligation?.state).toBe("settled");
    expect(items).toHaveLength(2);
    expect(items.every((row) => row.state === "finalized")).toBe(true);
  });

  it("allows only one unresolved reservation while concurrent provider preparations race", async () => {
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const fixture = await createOccurrence();
    const reserve = async (suffixValue: string) => {
      const operationId = randomUUID();
      return db.transaction(async (tx) => {
        await tx.insert(paymentOperations).values({
          id: operationId,
          organizationId,
          authorizingUserId: actorUserId,
          operationType: "interactive_charge",
          targetKey: `reservation-race:${suffixValue}:${operationId}`,
          leagueId,
          amountMinor: 1_000,
          currency: "USD",
          requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
          providerIdempotencyKey: `race-${operationId}`.slice(0, 45),
          providerName: "square",
          status: "pending",
        });
        await tx.insert(paymentOperationRosterSnapshots).values({
          operationId,
          organizationId,
          leagueId,
          snapshotVersion: 2,
          snapshotKind: "interactive",
          locationId,
          providerLocationId: null,
          payerBowlerId: bowlerId,
          requestKind: "direct",
          encryptedSourceId: "fixture-source",
          sourceKind: "new_card",
          quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
          amountMinor: 1_000,
          currency: "USD",
          obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: bowlerId, amountMinor: 1_000 }],
          lineItems: [],
          snapshotFingerprint: `lvrosterexec:v1:${"1".repeat(64)}`,
        });
        await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: 1_000, state: "reserved" });
        return operationId;
      });
    };
    const results = await Promise.allSettled([reserve("a"), reserve("b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reservations = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, leagueId),
      eq(paymentOperationRosterSnapshotItems.obligationId, fixture.obligation.id),
    ));
    expect(reservations).toEqual([{ state: "reserved" }]);
  });

  it("links a real interactive preparation to its league and creates the roster snapshot", async () => {
    const fixture = await createOccurrence();
    expectErrorLog("Payment operation retry scheduler rearm failed after interactive checkout");
    // The first report test deliberately exercises upfront mode and leaves the
    // shared fixture in that mode. This preparation path is the weekly exact-
    // obligation contract, so reset the fixture's authoritative league mode
    // before quoting one obligation.
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const firstQuote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    });
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockImplementation(async ({ operationId }) => {
      const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
      if (!operation) throw new Error("prepared operation was not persisted");
      const [snapshot] = await db.select().from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, operationId));
      const [item] = await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operationId));
      if (!snapshot || !item) throw new Error("roster snapshot was not created before provider dispatch");
      const providerObjectId = `roster-preparation-provider-${operationId}`;
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "succeeded", providerObjectId, completedAt: "2038-03-01T21:00:00.000Z", nextAttemptAt: null }).where(eq(paymentOperations.id, operationId));
        await tx.insert(payments).values({
          organizationId,
          bowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
          leagueId,
          amount: item.amountMinor,
          status: "paid",
          type: "square",
          providerPaymentId: providerObjectId,
          paymentOperationId: operationId,
          idempotencyKey: `${operationId}:0`,
        });
        await finalizeRosterSnapshotInTransaction(tx, {
          organizationId,
          leagueId,
          operationId,
          now: "2038-03-01T21:00:00.000Z",
          actorUserId,
        });
      });
      return (await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)))[0];
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const rearm = vi.spyOn(paymentOperationRetryExecutor, "rearm").mockRejectedValue(new Error("scheduler unavailable"));
    try {
      const result = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: 1_000,
          sourceId: "card-source-preparation-test",
          sourceKind: "new_card",
          storeCard: false,
          idempotencyKey: `preparation-test-${randomUUID()}`,
          requestFingerprint: firstQuote.fingerprint,
        },
      });
      expect(result.status).toBe("succeeded");
      expect(rearm).toHaveBeenCalled();
      const [interactiveSnapshot] = await db.select({ encryptedBuyerEmail: paymentOperationRosterSnapshots.encryptedBuyerEmail }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, result.operationId));
      expect(interactiveSnapshot?.encryptedBuyerEmail ? decrypt(interactiveSnapshot.encryptedBuyerEmail) : null).toBe("roster-main@example.test");
      const firstOperation = await db.select({ id: paymentOperations.id, leagueId: paymentOperations.leagueId }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, organizationId), eq(paymentOperations.leagueId, leagueId), eq(paymentOperations.operationType, "interactive_charge"))).orderBy(paymentOperations.createdAt);
      expect(firstOperation.at(-1)?.leagueId).toBe(leagueId);

      // The first provider snapshot is now finalized, so the public quote must
      // treat it as immutable history and expose the exact remaining balance
      // for the second preparation rather than returning OBLIGATION_RESERVED.
      const secondQuote = await quoteInteractiveObligations({
        organizationId,
        leagueId,
        amountMinor: 1_000,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
      });
      expect(secondQuote.amountMinor).toBe(1_000);
      const secondResult = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: 1_000,
          sourceId: "card-source-preparation-test-second",
          sourceKind: "new_card",
          storeCard: false,
          idempotencyKey: `preparation-test-second-${randomUUID()}`,
          requestFingerprint: secondQuote.fingerprint,
        },
      });
      expect(secondResult.status).toBe("succeeded");
      const snapshots = await db.select({ leagueId: paymentOperationRosterSnapshots.leagueId, amountMinor: paymentOperationRosterSnapshots.amountMinor }).from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, organizationId), eq(paymentOperationRosterSnapshots.leagueId, leagueId))).orderBy(paymentOperationRosterSnapshots.createdAt);
      expect(snapshots.slice(-2)).toEqual([
        { leagueId, amountMinor: 1_000 },
        { leagueId, amountMinor: 1_000 },
      ]);
    } finally {
      execute.mockRestore();
      provider.mockRestore();
      rearm.mockRestore();
    }
  });

  it.each([
    { label: "missing payer email", storedEmail: null, requestedEmail: undefined },
    { label: "malformed stored email", storedEmail: "not-an-email", requestedEmail: undefined },
    { label: "malformed fallback email", storedEmail: null, requestedEmail: "not-an-email" },
  ])("rejects a $label before provider dispatch", async ({ storedEmail, requestedEmail }) => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    await db.update(bowlers).set({ email: storedEmail }).where(eq(bowlers.id, requirePayerBowlerId(fixture.obligation.payerBowlerId)));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute");
    try {
      await expect(chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: 1_000,
          sourceId: `email-validation-${randomUUID()}`,
          sourceKind: "new_card",
          buyerEmail: requestedEmail,
          storeCard: false,
          idempotencyKey: `email-validation-${randomUUID()}`,
          requestFingerprint: quote.fingerprint,
        },
      })).rejects.toMatchObject({ code: "BUYER_EMAIL_REQUIRED", status: 422 });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
      execute.mockRestore();
      await db.update(bowlers).set({ email: "roster-main@example.test" }).where(eq(bowlers.id, requirePayerBowlerId(fixture.obligation.payerBowlerId)));
    }
  });

  it("rejects an administrator attempting to save a card for another bowler before operation creation", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute");
    const requestKey = `admin-card-save-${randomUUID()}`;
    try {
      await expect(chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: 1_000,
          sourceId: "admin-card-save-source",
          sourceKind: "new_card",
          buyerEmail: "roster-main@example.test",
          storeCard: true,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      })).rejects.toMatchObject({ code: "CARD_SAVE_OWNER_REQUIRED", status: 403 });
      expect(execute).not.toHaveBeenCalled();
      const operations = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, organizationId),
        eq(paymentOperations.leagueId, leagueId),
        eq(paymentOperations.targetKey, `interactive-charge:${requestKey}`),
      ));
      expect(operations).toHaveLength(0);
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("allows the payer account to save its own new card", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    await db.update(bowlers).set({ paymentCustomerId: "customer-self-save" }).where(eq(bowlers.id, requirePayerBowlerId(fixture.obligation.payerBowlerId)));
    const [payerUser] = await db.insert(users).values({
      email: `roster-payer-${randomUUID()}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Roster Payer",
      role: "user",
      organizationId,
      bowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    }).returning({ id: users.id });
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: 1_000,
      payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockResolvedValue(undefined);
    try {
      const result = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId: payerUser.id,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: 1_000,
          sourceId: "self-card-save-source",
          sourceKind: "new_card",
          storeCard: true,
          idempotencyKey: `self-card-save-${randomUUID()}`,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(result.status).toBe("pending");
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("replays an existing request key without treating the browser email as a new identity", async () => {
    const fixture = await createOccurrence();
    await db.update(leagues).set({ paymentMode: "weekly", timezone: "UTC" }).where(eq(leagues.id, leagueId));
    const quote = await quoteInteractiveObligations({
      organizationId,
      leagueId,
      amountMinor: fixture.obligation.amountMinor,
      payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
    });
    const requestKey = `email-replay-${randomUUID()}`;
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({ providerName: "square" } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    let executions = 0;
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockImplementation(async ({ operationId }) => {
      const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
      if (!operation) throw new Error("prepared operation was not persisted");
      if (executions++ > 0) return operation;
      const providerObjectId = `email-replay-provider-${operationId}`;
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "succeeded", providerObjectId, completedAt: "2038-04-01T21:00:00.000Z", nextAttemptAt: null }).where(eq(paymentOperations.id, operationId));
        const [item] = await tx.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operationId));
        if (!item) throw new Error("prepared roster item was not persisted");
        const [payment] = await tx.insert(payments).values({
          organizationId,
          bowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
          leagueId,
          amount: item.amountMinor,
          status: "paid",
          type: "square",
          providerPaymentId: providerObjectId,
          paymentOperationId: operationId,
          idempotencyKey: `${operationId}:0`,
        }).returning({ id: payments.id });
        if (!payment) throw new Error("provider payment fixture was not persisted");
        await finalizeRosterSnapshotInTransaction(tx, {
          organizationId,
          leagueId,
          operationId,
          now: "2038-04-01T21:00:00.000Z",
          actorUserId,
        });
      });
      return (await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)))[0];
    });
    try {
      const first = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: fixture.obligation.amountMinor,
          sourceId: "email-replay-source",
          sourceKind: "new_card",
          buyerEmail: "browser-fallback@example.test",
          storeCard: false,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(first.status).toBe("succeeded");
      const [snapshot] = await db.select({ encryptedBuyerEmail: paymentOperationRosterSnapshots.encryptedBuyerEmail }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, first.operationId));
      expect(snapshot?.encryptedBuyerEmail ? decrypt(snapshot.encryptedBuyerEmail) : null).toBe("roster-main@example.test");

      const replay = await chargeInteractiveObligations({
        organizationId,
        leagueId,
        actorUserId,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        request: {
          amountMinor: fixture.obligation.amountMinor,
          sourceId: "email-replay-source",
          sourceKind: "new_card",
          buyerEmail: "another-browser-value@example.test",
          storeCard: false,
          idempotencyKey: requestKey,
          requestFingerprint: quote.fingerprint,
        },
      });
      expect(replay).toMatchObject({ operationId: first.operationId, status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      provider.mockRestore();
      execute.mockRestore();
    }
  });

  it("finalizes a roster snapshot from webhook evidence exactly once", async () => {
    const fixture = await createOccurrence();
    const providerObjectId = `roster-webhook-provider-${randomUUID()}`;
    const operation = await db.transaction(async (tx) => {
      const prepared = await prepareInteractivePaymentOperation({
        organizationId,
        authorizingUserId: actorUserId,
        requestKey: `webhook-preparation-${randomUUID()}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        providerName: "square",
        leagueId,
        locationId,
        providerLocationId: null,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        requestKind: "direct",
        sourceId: "webhook-test-source",
        customerId: null,
        buyerEmail: null,
        storeCard: false,
        sourceKind: "new_card",
        allocations: [{ allocationIndex: 0, bowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId), amountMinor: fixture.obligation.amountMinor, notes: "webhook test", paidByUserId: actorUserId, obligationId: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version }],
        lineItems: [],
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        transaction: tx,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({ operationId: prepared.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: fixture.obligation.amountMinor, state: "reserved" });
      await tx.update(paymentOperations).set({ status: "provider_unknown", errorClassification: "provider_unknown", errorCode: "WEBHOOK_PENDING" }).where(eq(paymentOperations.id, prepared.id));
      return prepared;
    });
    const evidence = {
      organizationId,
      operationId: operation.id,
      locationId,
      providerLocationId: undefined,
      providerObjectId,
      providerPaymentId: providerObjectId,
      providerOrderId: null,
      amountMinor: fixture.obligation.amountMinor,
      currency: "USD",
      receiptUrl: null,
      receiptNumber: null,
      now: new Date("2038-04-01T21:00:00.000Z"),
    };
    const first = await db.transaction(async (tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    const replay = await db.transaction(async (tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    expect(first.status).toBe("succeeded");
    expect(replay.id).toBe(operation.id);
    const allocations = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.leagueId, leagueId), eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    expect(allocations).toHaveLength(1);
  });

  it("serializes cancellation against provider success and preserves the winning evidence", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const cancellationRequest = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "cancel",
      occurrenceId: fixture.occurrence.id,
      now: "2038-01-01T00:00:00.000Z",
      idempotencyKey: `roster-cancel-race-${randomUUID()}`,
      requestFingerprint: "",
      reason: "provider race test",
    } as const;
    const cancellation = cancelOccurrence({ ...cancellationRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancellationRequest) });
    const providerFinalization = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, leagueId);
      return finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-01-01T00:00:00.000Z", actorUserId });
    });
    const [cancelResult, providerResult] = await Promise.allSettled([cancellation, providerFinalization]);
    expect(cancelResult.status).toBe("fulfilled");
    const [storedOperation] = await db.select({ status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    const [storedObligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const activeAllocations = await db.select({ id: paymentAllocations.id, reviewRequired: paymentAllocations.reviewRequired }).from(paymentAllocations).where(and(eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    // Whichever transaction acquired the league lock first owns the outcome:
    // cancellation either voids the unpaid reservation and provider recovery
    // fails closed, or provider evidence settles first and cancellation marks
    // that evidence for review. Both outcomes retain operation identity.
    expect(storedOperation?.status).toBe("reconciliation_required");
    if (providerResult.status === "fulfilled") {
      expect(storedObligation?.state).toBe("settled");
      expect(activeAllocations).toHaveLength(1);
      expect(activeAllocations[0]?.reviewRequired).toBe(true);
    } else {
      expect(storedObligation?.state).toBe("voided");
      expect(activeAllocations).toHaveLength(0);
    }
  });

  it("finalizes exact reservations idempotently and conserves the obligation", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const first = await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-01T21:00:00.000Z", actorUserId }));
    const second = await db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-01T21:01:00.000Z", actorUserId }));
    expect(first.finalized).toBe(true);
    expect(first.allocationIds).toEqual([]);
    expect(second.allocationIds).toEqual([]);
    const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const allocations = await db.select().from(paymentAllocations).where(and(eq(paymentAllocations.obligationId, fixture.obligation.id), eq(paymentAllocations.state, "active")));
    expect(obligation?.state).toBe("settled");
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.amountMinor).toBe(2_000);
  });

  it("replays an adopted V2 receipt after its original allocation was released", async () => {
    const fixture = await createOccurrence({
      targetLeagueId: adoptedReplayLeagueId,
      authoritativeLocalDate: "2038-01-15",
    });
    const captureAt = "2038-01-16T20:00:00.000Z";
    const providerPaymentId = `adopted-replay-provider-${randomUUID()}`;
    const prepared = await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, adoptedReplayLeagueId);
      const operation = await prepareInteractivePaymentOperation({
        organizationId,
        authorizingUserId: actorUserId,
        requestKey: `adopted-replay-${randomUUID()}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        providerName: "square",
        leagueId: adoptedReplayLeagueId,
        locationId,
        providerLocationId: null,
        payerBowlerId: bowlerId,
        requestKind: "direct",
        sourceId: `cnon:adopted-replay-${randomUUID()}`,
        customerId: null,
        buyerEmail: null,
        storeCard: false,
        sourceKind: "new_card",
        allocations: [{
          allocationIndex: 0,
          bowlerId,
          amountMinor: fixture.obligation.amountMinor,
          notes: null,
          paidByUserId: actorUserId,
          obligationId: fixture.obligation.id,
          responsibilityId: fixture.responsibility.id,
          responsibilityVersion: fixture.responsibility.version,
        }],
        lineItems: [],
        quoteFingerprint: `lvrosterquote:v1:${"c".repeat(64)}`,
        transaction: tx,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId: operation.id,
        organizationId,
        leagueId: adoptedReplayLeagueId,
        obligationId: fixture.obligation.id,
        allocationIndex: 0,
        amountMinor: fixture.obligation.amountMinor,
        state: "reserved",
      });
      await tx.update(paymentOperations).set({
        status: "succeeded",
        nextAttemptAt: null,
        providerObjectId: providerPaymentId,
        errorClassification: null,
        errorCode: null,
        completedAt: captureAt,
        updatedAt: captureAt,
      }).where(and(eq(paymentOperations.id, operation.id), eq(paymentOperations.organizationId, organizationId)));
      const [payment] = await tx.insert(payments).values({
        organizationId,
        leagueId: adoptedReplayLeagueId,
        bowlerId,
        amount: fixture.obligation.amountMinor,
        currency: "USD",
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operation.id,
        idempotencyKey: operation.id,
        paidByUserId: actorUserId,
        createdAt: captureAt,
      }).returning();
      if (!payment) throw new Error("adopted replay fixture receipt was not created");
      await finalizeRosterSnapshotInTransaction(tx, {
        organizationId,
        leagueId: adoptedReplayLeagueId,
        operationId: operation.id,
        now: captureAt,
        actorUserId,
      });
      const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.organizationId, organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, adoptedReplayLeagueId),
        eq(paymentOperationRosterSnapshots.operationId, operation.id),
      ));
      if (!snapshot) throw new Error("adopted replay fixture snapshot was not persisted");
      return { operation, payment, snapshot };
    });

    await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, adoptedReplayLeagueId);
      const [adoption] = await tx.insert(weeklyPaymentLedgerAdoptions).values({
        organizationId,
        leagueId: adoptedReplayLeagueId,
        adoptedThroughLocalDate: "2038-01-31",
        preflightFingerprint: `lvweeklyadoptpre:v1:${randomUUID().replaceAll("-", "").repeat(2)}`,
        resultFingerprint: `lvweeklyadopt:v1:${randomUUID().replaceAll("-", "").repeat(2)}`,
        grandfatheredAllocationCount: 0,
        recordedByUserId: actorUserId,
      }).returning({ id: weeklyPaymentLedgerAdoptions.id });
      if (!adoption) throw new Error("adopted replay fixture marker was not created");
      const [allocation] = await tx.select().from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, adoptedReplayLeagueId),
        eq(paymentAllocations.paymentId, prepared.payment.id),
        eq(paymentAllocations.state, "active"),
      ));
      if (!allocation) throw new Error("adopted replay fixture allocation was not finalized");
      const funding = await ownedPaymentLedger.recordOwnedFundingInTransaction(tx, {
        organizationId,
        leagueId: adoptedReplayLeagueId,
        paymentId: prepared.payment.id,
        creditedBowlerId: bowlerId,
        portionIndex: 0,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        source: "legacy_adoption",
        authorizationKind: "legacy_provider_snapshot",
        authorizationOperationId: prepared.operation.id,
        authorizationItemCount: 1,
        authorizationFingerprint: prepared.snapshot.snapshotFingerprint,
        adoptionId: adoption.id,
        recordedByUserId: actorUserId,
        authorizationItems: [{
          allocationIndex: 0,
          amountMinor: fixture.obligation.amountMinor,
          snapshotFingerprint: prepared.snapshot.snapshotFingerprint,
        }],
        now: captureAt,
      });
      await tx.insert(paymentAllocationFundingApplications).values({
        organizationId,
        leagueId: adoptedReplayLeagueId,
        allocationId: allocation.id,
        paymentId: prepared.payment.id,
        creditedBowlerId: bowlerId,
        genericFundingId: funding.id,
        rotatingFundingId: null,
        sourceAmountMinor: fixture.obligation.amountMinor,
        amountMinor: allocation.amountMinor,
        currency: "USD",
        obligationId: fixture.obligation.id,
        responsibilityId: fixture.responsibility.id,
        occurrenceId: fixture.occurrence.id,
        teamId: fixture.responsibility.teamId,
        targetKind: "bowler_responsibility",
        targetPayerBowlerId: bowlerId,
        assignmentId: null,
        appliedByUserId: actorUserId,
        createdAt: captureAt,
      });
      const [application] = await tx.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(and(
        eq(paymentAllocationFundingApplications.organizationId, organizationId),
        eq(paymentAllocationFundingApplications.leagueId, adoptedReplayLeagueId),
        eq(paymentAllocationFundingApplications.allocationId, allocation.id),
      ));
      if (!application) throw new Error("adopted replay fixture funding application was not created");
      await ownedPaymentLedger.releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId,
        leagueId: adoptedReplayLeagueId,
        applicationId: application.id,
        actorUserId,
        reason: "ledger_adoption",
        idempotencyKey: `adopted-replay-release-${randomUUID()}`,
        now: "2038-01-17T20:00:00.000Z",
      });
      return adoption.id;
    });
    await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, adoptedReplayLeagueId),
      eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id),
    ));

    const first = await db.transaction((tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId: adoptedReplayLeagueId,
      operationId: prepared.operation.id,
      now: "2038-02-01T20:00:00.000Z",
      actorUserId,
    }));
    const second = await db.transaction((tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId: adoptedReplayLeagueId,
      operationId: prepared.operation.id,
      now: "2038-02-02T20:00:00.000Z",
      actorUserId,
    }));
    const allocations = await db.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, adoptedReplayLeagueId),
      eq(paymentAllocations.paymentId, prepared.payment.id),
    ));
    expect(first).toMatchObject({ finalized: true, allocationIds: [] });
    expect(second).toMatchObject({ finalized: true, allocationIds: [] });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ state: "voided", amountMinor: fixture.obligation.amountMinor });
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, prepared.payment.id))).toHaveLength(1);
    expect(await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.paymentId, prepared.payment.id))).toHaveLength(1);
  });

  it("persists reconciliation when a provider snapshot becomes stale and recovers by operation id", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    await expect(db.transaction(async (tx) => finalizeRosterSnapshotInTransaction(tx, { organizationId, leagueId, operationId: operation.id, now: "2038-02-02T21:00:00.000Z", actorUserId }))).rejects.toBeInstanceOf(RosterSnapshotFinalizationError);
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "ROSTER_RESERVATION_STALE",
      updatedAt: "2038-02-02T21:00:00.000Z",
    }).where(eq(paymentOperations.id, operation.id));
    const recovered = await recoverRosterPaymentOperation({ organizationId, leagueId, operationId: operation.id, actorUserId });
    expect(recovered.status).toBe("reconciliation_required");
  });

  it("restores the retained V2/V3 success transition after successful recovery", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      errorClassification: "internal",
      errorCode: "ROSTER_FINALIZATION_PENDING",
      updatedAt: "2038-02-02T21:00:00.000Z",
    }).where(eq(paymentOperations.id, operation.id));

    const recovered = await recoverRosterPaymentOperation({ organizationId, leagueId, operationId: operation.id, actorUserId });

    expect(recovered).toMatchObject({ id: operation.id, status: "succeeded", errorClassification: null, errorCode: null });
  });

  it("recovers V4 funding with the original capture timestamp across a weekly boundary", async () => {
    await ensureOwnedLedgerAdoption(accountLeagueId);
    const captureAt = new Date("2038-02-07T23:59:00.000Z");
    const recoveryAt = new Date("2038-02-08T00:01:00.000Z");
    const operation = await createAccountFundingOperation({
      leagueId: accountLeagueId,
      requestKey: `account-capture-boundary-${randomUUID()}`,
      now: captureAt,
    });
    const providerPaymentId = `account-provider-${operation.id}`;
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      providerObjectId: providerPaymentId,
      nextAttemptAt: null,
      errorClassification: "provider_unknown",
      errorCode: "CAPTURE_FINALIZATION_PENDING",
      attemptCount: 1,
      startedAt: captureAt.toISOString(),
      dispatchClaimedAt: captureAt.toISOString(),
      completedAt: captureAt.toISOString(),
      updatedAt: captureAt.toISOString(),
    }).where(eq(paymentOperations.id, operation.id));

    const recovered = await recoverRosterPaymentOperation({
      organizationId,
      leagueId: accountLeagueId,
      operationId: operation.id,
      actorUserId,
      now: recoveryAt,
    });

    expect(recovered.status).toBe("succeeded");
    const [payment] = await db.select({ createdAt: payments.createdAt }).from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, accountLeagueId),
      eq(payments.paymentOperationId, operation.id),
    )).limit(1);
    const [funding] = await db.select({ createdAt: weeklyPaymentFundings.createdAt }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, accountLeagueId),
      eq(weeklyPaymentFundings.authorizationOperationId, operation.id),
    )).limit(1);
    expect(payment).toBeDefined();
    expect(new Date(payment.createdAt).toISOString()).toBe(captureAt.toISOString());
    expect(payment.createdAt.slice(0, 10)).toBe("2038-02-07");
    expect(funding).toBeDefined();
    expect(new Date(funding.createdAt).toISOString()).toBe(recoveryAt.toISOString());
    await recoverRosterPaymentOperation({ organizationId, leagueId: accountLeagueId, operationId: operation.id, actorUserId, now: recoveryAt });
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(1);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.authorizationOperationId, operation.id))).toHaveLength(1);
  });

  it("returns the persisted reconciliation error when V4 recovery evidence is invalid", async () => {
    const captureAt = new Date("2038-03-01T20:00:00.000Z");
    const operation = await createAccountFundingOperation({
      leagueId: accountFailureLeagueId,
      requestKey: `account-recovery-rollback-${randomUUID()}`,
      now: captureAt,
    });
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      providerObjectId: `account-provider-${operation.id}`,
      nextAttemptAt: null,
      errorClassification: "provider_unknown",
      errorCode: "CAPTURE_FINALIZATION_PENDING",
      attemptCount: 1,
      startedAt: captureAt.toISOString(),
      dispatchClaimedAt: captureAt.toISOString(),
      completedAt: captureAt.toISOString(),
      updatedAt: captureAt.toISOString(),
    }).where(eq(paymentOperations.id, operation.id));
    const recovered = await recoverRosterPaymentOperation({
      organizationId,
      leagueId: accountFailureLeagueId,
      operationId: operation.id,
      actorUserId,
      now: new Date("2038-03-08T20:00:00.000Z"),
    });
    const [storedOperation] = await db.select({ errorCode: paymentOperations.errorCode }).from(paymentOperations).where(eq(paymentOperations.id, operation.id));

    expect(recovered).toMatchObject({ id: operation.id, status: "reconciliation_required", errorCode: storedOperation.errorCode });
    expect(storedOperation.errorCode).not.toBe("CAPTURE_FINALIZATION_PENDING");
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.authorizationOperationId, operation.id))).toHaveLength(0);
  });

  it("retains captured provider identity when the SQL ledger assertion fails, then recovers the same receipt", async () => {
    await createAccountFailureForecastObligation();
    await ensureOwnedLedgerAdoption(accountFailureLeagueId, "2038-01-31");
    const captureAt = new Date("2038-02-07T23:59:00.000Z");
    const operation = await createAccountFundingOperation({
      leagueId: accountFailureLeagueId,
      requestKey: `account-ledger-assertion-${randomUUID()}`,
      now: captureAt,
    });
    const providerPaymentId = `account-ledger-assertion-provider-${operation.id}`;
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      providerObjectId: providerPaymentId,
      nextAttemptAt: null,
      errorClassification: "provider_unknown",
      errorCode: "CAPTURE_FINALIZATION_PENDING",
      attemptCount: 1,
      startedAt: captureAt.toISOString(),
      dispatchClaimedAt: captureAt.toISOString(),
      completedAt: captureAt.toISOString(),
      updatedAt: captureAt.toISOString(),
    }).where(eq(paymentOperations.id, operation.id));

    const originalAssert = ownedPaymentLedger.assertOwnedPaymentTenderInTransaction;
    let observedSqlInvariant = false;
    const assertionSpy = vi.spyOn(ownedPaymentLedger, "assertOwnedPaymentTenderInTransaction").mockImplementation(async (tx, scope) => {
      const [funding] = await tx.select().from(weeklyPaymentFundings).where(and(
        eq(weeklyPaymentFundings.organizationId, scope.organizationId),
        eq(weeklyPaymentFundings.leagueId, scope.leagueId),
        eq(weeklyPaymentFundings.paymentId, scope.paymentId),
      )).limit(1);
      if (!funding) throw new Error("V4 SQL assertion fixture is missing its owned funding lot");
      const [obligation] = await tx.select().from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, scope.organizationId),
        eq(paymentObligations.leagueId, scope.leagueId),
        eq(paymentObligations.payerBowlerId, bowlerId),
      )).limit(1);
      if (!obligation) throw new Error("V4 SQL assertion fixture is missing its unconfirmed forecast obligation");
      const [responsibility] = await tx.select().from(occurrencePaymentResponsibilities).where(eq(
        occurrencePaymentResponsibilities.id,
        obligation.responsibilityId,
      ));
      if (!responsibility) throw new Error("V4 SQL assertion fixture is missing the forecast responsibility");
      const [overallocated] = await tx.insert(paymentAllocations).values({
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        paymentId: scope.paymentId,
        obligationId: obligation.id,
        amountMinor: funding.amountMinor,
        currency: funding.currency,
        state: "active",
        allocationKind: "ordinary",
        recordedByUserId: actorUserId,
      }).returning({ id: paymentAllocations.id });
      if (!overallocated) throw new Error("V4 SQL assertion fixture did not create the forecast allocation");
      await tx.insert(paymentAllocationFundingApplications).values({
        organizationId: funding.organizationId,
        leagueId: funding.leagueId,
        allocationId: overallocated.id,
        paymentId: funding.paymentId,
        creditedBowlerId: funding.creditedBowlerId,
        genericFundingId: funding.id,
        rotatingFundingId: null,
        sourceAmountMinor: funding.amountMinor,
        amountMinor: funding.amountMinor,
        currency: funding.currency,
        obligationId: obligation.id,
        responsibilityId: responsibility.id,
        occurrenceId: obligation.occurrenceId,
        teamId: responsibility.teamId,
        targetKind: "bowler_responsibility",
        targetPayerBowlerId: obligation.payerBowlerId,
        assignmentId: null,
        appliedByUserId: actorUserId,
      });
      try {
        await originalAssert(tx, scope);
      } catch (error) {
        observedSqlInvariant = ownedPaymentLedger.isOwnedPaymentLedgerInvariantError(error);
        throw error;
      }
      throw new Error("SQL tender assertion accepted a forecast allocation");
    });
    let failedRecovery;
    try {
      failedRecovery = await recoverRosterPaymentOperation({
        organizationId,
        leagueId: accountFailureLeagueId,
        operationId: operation.id,
        actorUserId,
        now: new Date("2038-02-08T00:01:00.000Z"),
      });
    } finally {
      assertionSpy.mockRestore();
    }

    expect(observedSqlInvariant).toBe(true);
    expect(failedRecovery).toMatchObject({
      id: operation.id,
      status: "reconciliation_required",
      providerObjectId: providerPaymentId,
      errorCode: "TENDER_LEDGER_INVARIANT",
    });
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.authorizationOperationId, operation.id))).toHaveLength(0);

    const [recoveryAdmin] = await db.insert(users).values({
      email: `roster-finalizer-recovery-admin-${randomUUID()}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Recovery Administrator",
      role: "org_admin",
      organizationId,
    }).returning({ id: users.id });
    const recovered = await recoverRosterPaymentOperation({
      organizationId,
      leagueId: accountFailureLeagueId,
      operationId: operation.id,
      actorUserId: recoveryAdmin.id,
      now: new Date("2038-02-08T00:02:00.000Z"),
    });
    expect(recovered).toMatchObject({ id: operation.id, status: "succeeded", providerObjectId: providerPaymentId });
    const [receipt] = await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id));
    if (!receipt) throw new Error("V4 recovery did not persist the provider receipt");
    expect(receipt).toMatchObject({ paidByUserId: actorUserId, providerPaymentId });
    const [funding] = await db.select().from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.authorizationOperationId, operation.id));
    expect(funding).toMatchObject({ recordedByUserId: actorUserId, paymentId: receipt.id });
    expect(await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.paymentId, receipt.id))).toHaveLength(0);
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(1);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.authorizationOperationId, operation.id))).toHaveLength(1);
  });

  it("blocks a different-key V4 charge on an overlapping account but replays the same key first", async () => {
    await ensureOwnedLedgerAdoption(accountLeagueId);
    const selection = { kind: "explicit_amount" as const, amountMinor: 2_000 };
    const recipientRequest = { recipients: [{ bowlerId, selection }] };
    const quote = await quoteAccountPaymentFundingV4({ organizationId, leagueId: accountLeagueId, payerBowlerId: bowlerId, request: recipientRequest });
    const unresolvedRequestKey = `account-overlap-a-${randomUUID()}`;
    const unresolvedSourceId = `cnon:account-overlap-a-${randomUUID()}`;
    const sameKeyRequestKey = `account-overlap-b-${randomUUID()}`;
    const sameKeySourceId = `cnon:account-overlap-b-${randomUUID()}`;
    const unresolved = await createAccountFundingOperation({
      leagueId: accountLeagueId,
      requestKey: unresolvedRequestKey,
      quoteFingerprint: quote.quoteFingerprint,
      sourceId: unresolvedSourceId,
    });
    const sameKey = await createAccountFundingOperation({
      leagueId: accountLeagueId,
      requestKey: sameKeyRequestKey,
      quoteFingerprint: quote.quoteFingerprint,
      sourceId: sameKeySourceId,
    });
    const provider = vi.spyOn(paymentProviderFactory, "getPaymentProvider").mockResolvedValue({
      providerName: "square",
      locationId,
    } as Awaited<ReturnType<typeof paymentProviderFactory.getPaymentProvider>>);
    const execute = vi.spyOn(interactivePaymentOperationExecutor, "execute").mockResolvedValue(sameKey);
    const rearm = vi.spyOn(paymentOperationRetryExecutor, "rearm").mockResolvedValue(undefined);
    const makeRequest = (idempotencyKey: string, sourceId: string) => ({
      ...recipientRequest,
      sourceId,
      sourceKind: "new_card" as const,
      storeCard: false,
      idempotencyKey,
      quoteFingerprint: quote.quoteFingerprint,
    });
    try {
      await expect(chargeAccountPaymentFundingV4({
        organizationId,
        leagueId: accountLeagueId,
        actorUserId,
        payerBowlerId: bowlerId,
        request: makeRequest(`account-overlap-new-${randomUUID()}`, `cnon:new-${randomUUID()}`),
      })).rejects.toMatchObject({ code: "PAYMENT_IN_PROGRESS", status: 409 });
      expect(execute).not.toHaveBeenCalled();

      const replay = await chargeAccountPaymentFundingV4({
        organizationId,
        leagueId: accountLeagueId,
        actorUserId,
        payerBowlerId: bowlerId,
        request: makeRequest(sameKeyRequestKey, sameKeySourceId),
      });

      expect(replay).toMatchObject({ operationId: sameKey.id, status: "pending" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(rearm).toHaveBeenCalledTimes(1);
      expect(unresolved.status).toBe("pending");
    } finally {
      provider.mockRestore();
      execute.mockRestore();
      rearm.mockRestore();
    }
  });

  it("recovers by request key only for the same tenant, league, and authorizing user", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    const requestKey = `recover-by-key-${randomUUID()}`;
    await db.update(paymentOperations).set({ targetKey: `interactive-charge:${requestKey}` }).where(eq(paymentOperations.id, operation.id));

    await expect(recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId: actorUserId + 1 })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId: leagueId + 1, requestKey, actorUserId })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const recovered = await recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    expect(recovered).toMatchObject({ id: operation.id, status: "succeeded" });
  });

  it("returns a discovered pending operation without provider recovery or redispatch", async () => {
    const requestKey = `pending-recovery-${randomUUID()}`;
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:${requestKey}`,
      leagueId,
      amountMinor: 1_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"6".repeat(64)}`,
      providerIdempotencyKey: `pending-recovery-${operationId}`.slice(0, 45),
      providerName: "square",
      status: "pending",
      nextAttemptAt: "2038-06-01T20:00:00.000Z",
    });

    const discovered = await recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    expect(discovered).toMatchObject({ id: operationId, status: "pending", providerObjectId: null });
  });

  it("waits for an in-flight preparation commit before recovering by request key", async () => {
    const fixture = await createOccurrence();
    const operationId = randomUUID();
    const requestKey = `recovery-wait-${randomUUID()}`;
    const providerPaymentId = `recovery-wait-provider-${operationId}`;
    let preparationReady!: () => void;
    let preparationFailed!: (error: unknown) => void;
    let releasePreparation!: () => void;
    const preparationReadyPromise = new Promise<void>((resolve, reject) => {
      preparationReady = resolve;
      preparationFailed = reject;
    });
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });

    const preparation = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, organizationId, leagueId);
      await tx.insert(paymentOperations).values({
        id: operationId,
        organizationId,
        authorizingUserId: actorUserId,
        operationType: "interactive_charge",
        targetKey: `interactive-charge:${requestKey}`,
        leagueId,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        requestFingerprint: `lvpayreq:v1:${"4".repeat(64)}`,
        providerIdempotencyKey: `recovery-wait-${operationId}`.slice(0, 45),
        providerName: "square",
        providerObjectId: providerPaymentId,
        status: "succeeded",
        nextAttemptAt: null,
        completedAt: "2038-05-01T20:00:00.000Z",
      });
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotVersion: 2,
        snapshotKind: "interactive",
        locationId,
        providerLocationId: null,
        payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        requestKind: "direct",
        encryptedSourceId: "fixture-source",
        sourceKind: "new_card",
        quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
        amountMinor: fixture.obligation.amountMinor,
        currency: "USD",
        obligations: [{ id: fixture.obligation.id, responsibilityId: fixture.responsibility.id, responsibilityVersion: fixture.responsibility.version, payerBowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId), amountMinor: fixture.obligation.amountMinor }],
        lineItems: [],
        snapshotFingerprint: `lvrosterexec:v1:${"5".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId,
        organizationId,
        leagueId,
        obligationId: fixture.obligation.id,
        allocationIndex: 0,
        amountMinor: fixture.obligation.amountMinor,
        state: "reserved",
      });
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId: requirePayerBowlerId(fixture.obligation.payerBowlerId),
        leagueId,
        amount: fixture.obligation.amountMinor,
        status: "paid",
        type: "square",
        providerPaymentId,
        paymentOperationId: operationId,
        idempotencyKey: `${operationId}:0`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("provider payment fixture was not persisted");
      await finalizeRosterSnapshotInTransaction(tx, {
        organizationId,
        leagueId,
        operationId,
        now: "2038-05-01T20:00:00.000Z",
        actorUserId,
      });
      preparationReady();
      await preparationGate;
    }).catch((error) => {
      preparationFailed(error);
      throw error;
    });

    await preparationReadyPromise;
    const recovery = recoverRosterPaymentOperationByRequestKey({ organizationId, leagueId, requestKey, actorUserId });
    let recoverySettled = false;
    const recoveryWithState = recovery.finally(() => { recoverySettled = true; });
    const lockClient = await getTestPool().connect();
    try {
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await lockClient.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted = false) AS waiting",
          [organizationId, leagueId],
        );
        waiting = result.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(recoverySettled).toBe(false);
    } finally {
      releasePreparation();
      await preparation;
      lockClient.release();
    }

    await expect(recoveryWithState).resolves.toMatchObject({ id: operationId, status: "succeeded" });
  });

  it("blocks an interactive provider cutoff when a reserved roster version is stale", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_000, { withCanonicalPayment: false });
    await db.update(paymentOperations).set({ providerObjectId: null, status: "pending", nextAttemptAt: "2038-02-03T18:00:00.000Z", completedAt: null }).where(eq(paymentOperations.id, operation.id));
    const leaseToken = randomUUID();
    await db.update(paymentOperations).set({
      status: "leased",
      leaseOwner: "roster-cutoff-test",
      leaseToken,
      leaseExpiresAt: "2038-02-03T20:00:00.000Z",
      nextAttemptAt: null,
      dispatchClaimedAt: null,
      completedAt: null,
    }).where(eq(paymentOperations.id, operation.id));
    await db.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    const cutoff = await acquireInteractivePaymentOperationDispatchCutoff({ organizationId, operationId: operation.id, leaseToken, now: new Date("2038-02-03T19:00:00.000Z") });
    expect(cutoff).toBe(false);
    const [blocked] = await db.select({ status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    expect(blocked?.status).toBe("reconciliation_required");
    const [releasedItem] = await db.select({ state: paymentOperationRosterSnapshotItems.state }).from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(releasedItem?.state).toBe("released");
  });

  it("invalidates Main slots when a bowler is directly deactivated", async () => {
    const [team] = await db.insert(teams).values({ name: "Direct Deactivation Team", number: 2, leagueId }).returning({ id: teams.id });
    const [deactivated] = await db.insert(bowlers).values({ name: "Direct Deactivation Main", organizationId }).returning({ id: bowlers.id, active: bowlers.active });
    await db.insert(bowlerLeagues).values({ bowlerId: deactivated.id, leagueId, teamId: team.id });
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: deactivated.id, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);
    const fixture = await createOccurrence();
    const before = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.mainBowlerId, deactivated.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(before).toHaveLength(1);
    const updated = await updateBowler(deactivated.id, { active: false }, actorUserId);
    expect(updated.active).toBe(false);
    const [slot] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, team.id),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    expect(slot).toMatchObject({ occupant: "vacant", mainBowlerId: null });
    const after = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.mainBowlerId, deactivated.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(after).toHaveLength(0);
  });

  it.each(["dispatch_claimed_at", "provider_object_id", "provider_unknown"] as const)("rejects roster replacement when released snapshot evidence is fenced by %s", async (evidence) => {
    const fixture = await createOccurrence();
    const [substitute] = await db.insert(bowlers).values({ name: `Explicit Override Substitute ${evidence}`, organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: substitute.id, leagueId, teamId });
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_000, { withCanonicalPayment: false });
    await db.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    if (evidence === "dispatch_claimed_at") {
      await db.update(paymentOperations).set({
        status: "leased",
        leaseOwner: "roster-evidence-fence-test",
        leaseToken: randomUUID(),
        leaseExpiresAt: "2038-02-03T20:00:00.000Z",
        nextAttemptAt: null,
        dispatchClaimedAt: "2038-02-03T19:00:00.000Z",
        providerObjectId: null,
        completedAt: null,
      }).where(eq(paymentOperations.id, operation.id));
    } else if (evidence === "provider_unknown") {
      await db.update(paymentOperations).set({
        status: "provider_unknown",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: "2038-02-03T20:00:00.000Z",
        dispatchClaimedAt: null,
        providerObjectId: null,
        errorClassification: "provider_unknown",
        errorCode: "TEST_PROVIDER_UNKNOWN",
        completedAt: null,
      }).where(eq(paymentOperations.id, operation.id));
    }
    await db.insert(teamPaymentPolicies).values({ organizationId, leagueId, teamId, defaultPolicy: "main_pays_full", recordedByUserId: actorUserId }).onConflictDoNothing();
    const [slotBefore] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId, currentRevision: teamPaymentSlots.currentRevision }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    const [policyBefore] = await db.select({ defaultPolicy: teamPaymentPolicies.defaultPolicy, currentRevision: teamPaymentPolicies.currentRevision }).from(teamPaymentPolicies).where(and(
      eq(teamPaymentPolicies.organizationId, organizationId),
      eq(teamPaymentPolicies.leagueId, leagueId),
      eq(teamPaymentPolicies.teamId, teamId),
    ));
    const [responsibilityBefore] = await db.select({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    const [obligationBefore] = await db.select({ id: paymentObligations.id, state: paymentObligations.state, responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    const explicitResponsibility = {
      occurrenceId: fixture.occurrence.id,
      teamId,
      slotIndex: 0,
      positionIndex: 0,
      kind: "substitute" as const,
      mainBowlerId: bowlerId,
      substituteBowlerId: substitute.id,
      payerBowlerId: substitute.id,
      policy: "sub_pays_full" as const,
      amountMinor: 2_000,
      lineageAmountMinor: null,
      prizeFundAmountMinor: null,
      dueAt: "2038-02-02T19:00:00.000Z",
      pastDueAt: "2038-02-02T22:00:00.000Z",
      assignmentNote: `provider fence ${evidence}`,
    };
    await expect(recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: `explicit-override-evidence-${evidence}-${randomUUID()}`,
      requestFingerprint: canonicalResponsibilityFingerprint([explicitResponsibility]),
      responsibilities: [explicitResponsibility],
    })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED" });
    const request = {
      commandKey: `evidence-fence-roster-${evidence}-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      policy: "main_pays_full" as const,
      slots: [
        { slotIndex: 0, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED" });
    const [slotAfter] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId, currentRevision: teamPaymentSlots.currentRevision }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    const [policyAfter] = await db.select({ defaultPolicy: teamPaymentPolicies.defaultPolicy, currentRevision: teamPaymentPolicies.currentRevision }).from(teamPaymentPolicies).where(and(
      eq(teamPaymentPolicies.organizationId, organizationId),
      eq(teamPaymentPolicies.leagueId, leagueId),
      eq(teamPaymentPolicies.teamId, teamId),
    ));
    const [responsibilityAfter] = await db.select({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, responsibilityBefore.id));
    const [obligationAfter] = await db.select({ id: paymentObligations.id, state: paymentObligations.state, responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    expect(slotAfter).toEqual(slotBefore);
    expect(policyAfter).toEqual(policyBefore);
    expect(responsibilityAfter).toEqual(responsibilityBefore);
    expect(obligationAfter).toEqual(obligationBefore);
  });

  it("requires Main membership on the selected team and rejects cross-team materialization", async () => {
    const [sourceTeam] = await db.insert(teams).values({ name: "Cross Team Source", number: 32, leagueId }).returning({ id: teams.id });
    const [targetTeam] = await db.insert(teams).values({ name: "Cross Team Target", number: 33, leagueId }).returning({ id: teams.id });
    const [crossTeamMain] = await db.insert(bowlers).values({ name: "Cross Team Main", organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: crossTeamMain.id, leagueId, teamId: sourceTeam.id });
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 0, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);
    const request = {
      commandKey: `cross-team-roster-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      policy: "main_pays_full" as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: crossTeamMain.id },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId: targetTeam.id, actorUserId, request })).rejects.toMatchObject({ code: "BOWLER_NOT_IN_LEAGUE" });
    const [unchangedSlot] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, targetTeam.id),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    expect(unchangedSlot).toEqual({ occupant: "vacant", mainBowlerId: null });

    // Simulate a legacy/corrupt cross-team slot directly to exercise the
    // materializer's defense-in-depth team+bowler eligibility key.
    await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: crossTeamMain.id }).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, targetTeam.id),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    const fixture = await createOccurrence();
    await db.transaction(async (tx) => {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId: fixture.occurrence.id, actorUserId, teamId: targetTeam.id });
    });
    const targetMainRows = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, targetTeam.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
      eq(occurrencePaymentResponsibilities.responsibilityKind, "main"),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(targetMainRows).toHaveLength(0);
    const targetObligations = await db.select({ id: paymentObligations.id }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id)).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, targetTeam.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    ));
    expect(targetObligations).toHaveLength(0);
  });

  it("rejects snapshot totals that disagree with the operation or obligation at commit", async () => {
    const fixture = await createOccurrence();
    await expect(createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 2_500)).rejects.toThrow();
    const [remaining] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    expect(remaining?.state).toBe("open");
  });

  it("enforces exact one-parent gross conservation and whole-payment voids", async () => {
    const underallocated = await createOccurrence();
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 2_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-under-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("underallocated payment fixture was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: underallocated.obligation.id,
        amountMinor: 1_000,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
    })).rejects.toThrow();

    const overallocated = await createOccurrence();
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 2_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-over-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("overallocated payment fixture was not created");
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: payment.id,
        obligationId: overallocated.obligation.id,
        amountMinor: 3_000,
        currency: "USD",
        recordedByUserId: actorUserId,
      });
    })).rejects.toThrow();

    const first = await createOccurrence();
    const second = await createOccurrence();
    const paymentId = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 4_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-exact-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("exact payment fixture was not created");
      await tx.insert(paymentAllocations).values([
        { organizationId, leagueId, paymentId: payment.id, obligationId: first.obligation.id, amountMinor: 2_000, currency: "USD", recordedByUserId: actorUserId },
        { organizationId, leagueId, paymentId: payment.id, obligationId: second.obligation.id, amountMinor: 2_000, currency: "USD", recordedByUserId: actorUserId },
      ]);
      return payment.id;
    });
    const exactAllocations = await db.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));
    expect(exactAllocations.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([2_000, 2_000]);

    const sharedObligation = await createOccurrence();
    await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 1_500,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-shared-first-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("first shared-obligation payment fixture was not created");
      await tx.insert(paymentAllocations).values({ organizationId, leagueId, paymentId: payment.id, obligationId: sharedObligation.obligation.id, amountMinor: 1_500, currency: "USD", recordedByUserId: actorUserId });
    });
    await expect(db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        bowlerId,
        leagueId,
        amount: 1_000,
        currency: "USD",
        status: "paid",
        type: "cash",
        idempotencyKey: `conservation-shared-second-${randomUUID()}`,
      }).returning({ id: payments.id });
      if (!payment) throw new Error("second shared-obligation payment fixture was not created");
      await tx.insert(paymentAllocations).values({ organizationId, leagueId, paymentId: payment.id, obligationId: sharedObligation.obligation.id, amountMinor: 1_000, currency: "USD", recordedByUserId: actorUserId });
    })).rejects.toThrow();

    await expect(db.transaction(async (tx) => {
      await tx.insert(paymentVoids).values({ organizationId, leagueId, paymentId, reason: "mixed-state regression", recordedByUserId: actorUserId });
      await tx.update(payments).set({ status: "voided" }).where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId), eq(payments.leagueId, leagueId)));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.paymentId, paymentId),
        eq(paymentAllocations.obligationId, first.obligation.id),
      ));
    })).rejects.toThrow();
  });

  it("keeps tenant-scoped reservation identity and allocation index unique", async () => {
    const fixture = await createOccurrence();
    const { operation } = await createRosterOperation(fixture.obligation.id, fixture.responsibility.id);
    await expect(db.insert(paymentOperationRosterSnapshotItems).values({ operationId: operation.id, organizationId, leagueId, obligationId: fixture.obligation.id, allocationIndex: 0, amountMinor: 2_000, state: "reserved" })).rejects.toThrow();
    const itemRows = await db.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id));
    expect(itemRows).toHaveLength(1);
  });

  it("materializes configured positions independently and versions open roster transitions", async () => {
    const [incrementalTeam] = await db.insert(teams).values({ name: "Incremental Team", number: 30, leagueId }).returning({ id: teams.id });
    const [firstMain] = await db.insert(bowlers).values({ name: "Incremental Main One", organizationId }).returning({ id: bowlers.id });
    const [secondMain] = await db.insert(bowlers).values({ name: "Incremental Main Two", organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values([
      { bowlerId: firstMain.id, leagueId, teamId: incrementalTeam.id },
      { bowlerId: secondMain.id, leagueId, teamId: incrementalTeam.id },
    ]);
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: incrementalTeam.id, slotIndex: 0, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: incrementalTeam.id, slotIndex: 1, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: incrementalTeam.id, slotIndex: 2, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);

    const fixture = await createOccurrence();
    const untouchedBefore = await db.select({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    const initiallyUnassigned = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(initiallyUnassigned).toHaveLength(0);

    const save = async (slotValues: Array<{ slotIndex: number; occupant: "main" | "vacant" | "unassigned"; mainBowlerId: number | null }>) => {
      const request = {
        commandKey: `incremental-roster-${randomUUID()}`,
        requestFingerprint: "",
        lineupSize: 3 as const,
        policy: "main_pays_full" as const,
        slots: slotValues,
      };
      request.requestFingerprint = canonicalRosterFingerprint(request);
      return saveTeamRoster({ organizationId, leagueId, teamId: incrementalTeam.id, actorUserId, request });
    };

    await save([
      { slotIndex: 0, occupant: "main", mainBowlerId: firstMain.id },
      { slotIndex: 1, occupant: "vacant", mainBowlerId: null },
      { slotIndex: 2, occupant: "unassigned", mainBowlerId: null },
    ]);
    let active = await db.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(occurrencePaymentResponsibilities.slotIndex);
    expect(active.map((row) => [row.slotIndex, row.responsibilityKind])).toEqual([[0, "main"], [1, "vacant"]]);
    const firstMainResponsibility = active.find((row) => row.slotIndex === 0);
    const firstVacantResponsibility = active.find((row) => row.slotIndex === 1);
    if (!firstMainResponsibility || !firstVacantResponsibility) throw new Error("incremental roster responsibilities were not materialized");
    expect(firstMainResponsibility?.responsibilityKey).toBeTruthy();
    expect(firstVacantResponsibility?.amountMinor).toBe(0);
    const firstObligations = await db.select({ responsibilityId: paymentObligations.responsibilityId, state: paymentObligations.state }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.occurrenceId, fixture.occurrence.id),
      eq(paymentObligations.responsibilityId, firstMainResponsibility.id),
    ));
    expect(firstObligations).toHaveLength(1);

    await save([
      { slotIndex: 0, occupant: "main", mainBowlerId: secondMain.id },
      { slotIndex: 1, occupant: "vacant", mainBowlerId: null },
      { slotIndex: 2, occupant: "unassigned", mainBowlerId: null },
    ]);
    const mainVersions = await db.select({ responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 0),
    )).orderBy(occurrencePaymentResponsibilities.version);
    expect(mainVersions.map((row) => [row.version, row.state, row.mainBowlerId])).toEqual([[1, "voided", firstMain.id], [2, "active", secondMain.id]]);
    expect(mainVersions[1]?.responsibilityKey).toBe(mainVersions[0]?.responsibilityKey);

    await save([
      { slotIndex: 0, occupant: "vacant", mainBowlerId: null },
      { slotIndex: 1, occupant: "vacant", mainBowlerId: null },
      { slotIndex: 2, occupant: "unassigned", mainBowlerId: null },
    ]);
    active = await db.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(active.filter((row) => row.slotIndex === 0)).toHaveLength(1);
    expect(active.find((row) => row.slotIndex === 0)?.responsibilityKind).toBe("vacant");
    expect(active.find((row) => row.slotIndex === 0)?.amountMinor).toBe(0);
    const activeVacant = active.find((row) => row.slotIndex === 0);
    if (!activeVacant) throw new Error("VACANT responsibility was not materialized");
    expect(await db.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.occurrenceId, fixture.occurrence.id),
      eq(paymentObligations.responsibilityId, activeVacant.id),
    ))).toHaveLength(0);

    await save([
      { slotIndex: 0, occupant: "unassigned", mainBowlerId: null },
      { slotIndex: 1, occupant: "unassigned", mainBowlerId: null },
      { slotIndex: 2, occupant: "unassigned", mainBowlerId: null },
    ]);
    const finalActive = await db.select({ slotIndex: occurrencePaymentResponsibilities.slotIndex }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(finalActive).toHaveLength(0);
    const untouchedAfter = await db.select({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(untouchedAfter).toEqual(untouchedBefore);

    await db.update(bowlers).set({ active: false }).where(eq(bowlers.id, firstMain.id));
    await db.update(teamPaymentSlots).set({ occupant: "main", mainBowlerId: firstMain.id }).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, incrementalTeam.id),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    const inactiveFixture = await createOccurrence();
    const inactiveMainRows = await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, inactiveFixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, incrementalTeam.id),
      eq(occurrencePaymentResponsibilities.responsibilityKind, "main"),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ));
    expect(inactiveMainRows).toHaveLength(0);

    const [otherOrganization] = await db.insert(organizations).values({ name: "Cross Tenant Roster Fixture", slug: `roster-cross-tenant-${suffix}` }).returning({ id: organizations.id });
    const [crossTenantMain] = await db.insert(bowlers).values({ name: "Cross Tenant Main", organizationId: otherOrganization.id }).returning({ id: bowlers.id });
    const crossTenantRequest = {
      commandKey: `cross-tenant-roster-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      policy: "main_pays_full" as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: crossTenantMain.id },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "unassigned" as const, mainBowlerId: null },
      ],
    };
    crossTenantRequest.requestFingerprint = canonicalRosterFingerprint(crossTenantRequest);
    await expect(saveTeamRoster({ organizationId, leagueId, teamId: incrementalTeam.id, actorUserId, request: crossTenantRequest })).rejects.toMatchObject({ code: "BOWLER_NOT_IN_LEAGUE" });
    await deleteOrganization(otherOrganization.id);
  });

  it("records configured Main and VACANT overrides while rejecting an unassigned target", async () => {
    const [overrideTeam] = await db.insert(teams).values({ name: "Partial Override Team", number: 31, leagueId }).returning({ id: teams.id });
    const [overrideMain] = await db.insert(bowlers).values({ name: "Partial Override Main", organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: overrideMain.id, leagueId, teamId: overrideTeam.id });
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: overrideTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: overrideMain.id, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: overrideTeam.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: overrideTeam.id, slotIndex: 2, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
    ]);

    const fixture = await createOccurrence();
    const dueAt = "2038-02-02T19:00:00.000Z";
    const responsibilities = [
      {
        occurrenceId: fixture.occurrence.id,
        teamId: overrideTeam.id,
        slotIndex: 0,
        positionIndex: 0,
        kind: "main" as const,
        mainBowlerId: overrideMain.id,
        substituteBowlerId: null,
        payerBowlerId: overrideMain.id,
        policy: "main_pays_full" as const,
        amountMinor: 2_000,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt,
        pastDueAt: "2038-02-01T22:00:00.000Z",
        assignmentNote: "configured Main override",
      },
      {
        occurrenceId: fixture.occurrence.id,
        teamId: overrideTeam.id,
        slotIndex: 1,
        positionIndex: 1,
        kind: "vacant" as const,
        mainBowlerId: null,
        substituteBowlerId: null,
        payerBowlerId: null,
        policy: "main_pays_full" as const,
        amountMinor: 0,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt,
        pastDueAt: "2038-02-01T22:00:00.000Z",
        assignmentNote: "configured VACANT override",
      },
    ];
    await recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: `partial-override-${randomUUID()}`,
      requestFingerprint: canonicalResponsibilityFingerprint(responsibilities),
      responsibilities,
    });
    const configuredRows = await db.select({ slotIndex: occurrencePaymentResponsibilities.slotIndex, responsibilityKind: occurrencePaymentResponsibilities.responsibilityKind }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, overrideTeam.id),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(occurrencePaymentResponsibilities.slotIndex);
    expect(configuredRows.map((row) => [row.slotIndex, row.responsibilityKind])).toEqual([[0, "main"], [1, "vacant"]]);

    const unassignedResponsibility = {
      ...responsibilities[0],
      slotIndex: 2,
      positionIndex: 2,
      kind: "vacant" as const,
      mainBowlerId: null,
      payerBowlerId: null,
      amountMinor: 0,
      assignmentNote: "unassigned target must fail",
    };
    await expect(recordOccurrenceResponsibilities({
      organizationId,
      leagueId,
      actorUserId,
      commandKey: `unassigned-override-${randomUUID()}`,
      requestFingerprint: canonicalResponsibilityFingerprint([unassignedResponsibility]),
      responsibilities: [unassignedResponsibility],
    })).rejects.toMatchObject({ code: "INCOMPLETE_ROSTER" });
    expect(await db.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
      eq(occurrencePaymentResponsibilities.teamId, overrideTeam.id),
      eq(occurrencePaymentResponsibilities.slotIndex, 2),
    ))).toHaveLength(0);
  });

  it("swaps and cycles Main identities while preserving stable slot revisions", async () => {
    const [swapTeam] = await db.insert(teams).values({ name: "Main Swap Team", number: 34, leagueId }).returning({ id: teams.id });
    const [mainA, mainB, mainC] = await db.insert(bowlers).values([
      { name: "Swap Main A", organizationId },
      { name: "Swap Main B", organizationId },
      { name: "Swap Main C", organizationId },
    ]).returning({ id: bowlers.id });
    if (!mainA || !mainB || !mainC) throw new Error("Main swap fixture was incomplete");
    await db.insert(bowlerLeagues).values([mainA, mainB, mainC].map(({ id }) => ({ bowlerId: id, leagueId, teamId: swapTeam.id })));
    await db.insert(teamPaymentSlots).values([mainA, mainB, mainC].map((bowler, slotIndex) => ({
      organizationId,
      leagueId,
      teamId: swapTeam.id,
      slotIndex,
      lineupSize: 3,
      occupant: "main" as const,
      mainBowlerId: bowler.id,
      recordedByUserId: actorUserId,
    })));

    const save = async (mainBowlerIds: number[], label: string) => {
      const request = {
        commandKey: `main-identity-${label}-${randomUUID()}`,
        requestFingerprint: "",
        lineupSize: 3 as const,
        policy: "main_pays_full" as const,
        slots: [
          ...mainBowlerIds.map((mainBowlerId, slotIndex) => ({ slotIndex, occupant: "main" as const, mainBowlerId })),
        ],
      };
      request.requestFingerprint = canonicalRosterFingerprint(request);
      await saveTeamRoster({ organizationId, leagueId, teamId: swapTeam.id, actorUserId, request });
    };
    const initialSlots = await db.select({ id: teamPaymentSlots.id, slotIndex: teamPaymentSlots.slotIndex }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, swapTeam.id),
    )).orderBy(teamPaymentSlots.slotIndex);
    const slotIndexById = new Map(initialSlots.map((slot) => [slot.id, slot.slotIndex]));
    const slotIds = initialSlots.map(({ id }) => id);

    await save([mainB.id, mainA.id, mainC.id], "swap");
    let savedSlots = await db.select({ id: teamPaymentSlots.id, slotIndex: teamPaymentSlots.slotIndex, mainBowlerId: teamPaymentSlots.mainBowlerId, currentRevision: teamPaymentSlots.currentRevision }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, swapTeam.id),
    )).orderBy(teamPaymentSlots.slotIndex);
    expect(savedSlots.map(({ id }) => id)).toEqual(slotIds);
    expect(savedSlots.map(({ mainBowlerId, currentRevision }) => [mainBowlerId, currentRevision])).toEqual([
      [mainB.id, 2], [mainA.id, 2], [mainC.id, 1],
    ]);
    const swapRevisions = await db.select({ slotId: teamPaymentSlotRevisions.slotId, revisionNumber: teamPaymentSlotRevisions.revisionNumber, beforeSnapshot: teamPaymentSlotRevisions.beforeSnapshot, afterSnapshot: teamPaymentSlotRevisions.afterSnapshot }).from(teamPaymentSlotRevisions).where(and(
      eq(teamPaymentSlotRevisions.organizationId, organizationId),
      eq(teamPaymentSlotRevisions.leagueId, leagueId),
      inArray(teamPaymentSlotRevisions.slotId, slotIds),
    ));
    expect(swapRevisions.map((revision) => {
      const before = revision.beforeSnapshot as { mainBowlerId?: number | null } | null;
      const after = revision.afterSnapshot as { mainBowlerId?: number | null };
      return [slotIndexById.get(revision.slotId), revision.revisionNumber, before?.mainBowlerId, after.mainBowlerId];
    }).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [0, 2, mainA.id, mainB.id],
      [1, 2, mainB.id, mainA.id],
    ]);

    await save([mainC.id, mainB.id, mainA.id], "cycle");
    savedSlots = await db.select({ id: teamPaymentSlots.id, slotIndex: teamPaymentSlots.slotIndex, mainBowlerId: teamPaymentSlots.mainBowlerId, currentRevision: teamPaymentSlots.currentRevision }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, swapTeam.id),
    )).orderBy(teamPaymentSlots.slotIndex);
    expect(savedSlots.map(({ id }) => id)).toEqual(slotIds);
    expect(savedSlots.map(({ mainBowlerId, currentRevision }) => [mainBowlerId, currentRevision])).toEqual([
      [mainC.id, 3], [mainB.id, 3], [mainA.id, 2],
    ]);
    const cycleRevisions = await db.select({ slotId: teamPaymentSlotRevisions.slotId, revisionNumber: teamPaymentSlotRevisions.revisionNumber, beforeSnapshot: teamPaymentSlotRevisions.beforeSnapshot, afterSnapshot: teamPaymentSlotRevisions.afterSnapshot }).from(teamPaymentSlotRevisions).where(and(
      eq(teamPaymentSlotRevisions.organizationId, organizationId),
      eq(teamPaymentSlotRevisions.leagueId, leagueId),
      inArray(teamPaymentSlotRevisions.slotId, slotIds),
    ));
    expect(cycleRevisions).toHaveLength(5);
    const latestCycleRevisions = cycleRevisions.filter((revision) => revision.revisionNumber > 2 || revision.revisionNumber === 2 && slotIndexById.get(revision.slotId) === 2);
    expect(latestCycleRevisions.map((revision) => {
      const before = revision.beforeSnapshot as { mainBowlerId?: number | null } | null;
      const after = revision.afterSnapshot as { mainBowlerId?: number | null };
      return [slotIndexById.get(revision.slotId), revision.revisionNumber, before?.mainBowlerId, after.mainBowlerId];
    }).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [0, 3, mainB.id, mainC.id],
      [1, 3, mainA.id, mainB.id],
      [2, 2, mainC.id, mainA.id],
    ]);
  });

  it("rolls back staged Main identity releases when a final assignment conflicts", async () => {
    const [targetTeam, sourceTeam] = await db.insert(teams).values([
      { name: "Main Swap Rollback Target", number: 35, leagueId },
      { name: "Main Swap Rollback Source", number: 36, leagueId },
    ]).returning({ id: teams.id });
    if (!targetTeam || !sourceTeam) throw new Error("Main swap rollback fixture was incomplete");
    const [mainA, mainB, occupiedMain] = await db.insert(bowlers).values([
      { name: "Rollback Main A", organizationId },
      { name: "Rollback Main B", organizationId },
      { name: "Rollback Occupied Main", organizationId },
    ]).returning({ id: bowlers.id });
    if (!mainA || !mainB || !occupiedMain) throw new Error("Main swap rollback bowlers were incomplete");
    await db.insert(bowlerLeagues).values([
      ...[mainA, mainB, occupiedMain].map(({ id }) => ({ bowlerId: id, leagueId, teamId: targetTeam.id })),
      { bowlerId: occupiedMain.id, leagueId, teamId: sourceTeam.id },
    ]);
    await db.insert(teamPaymentSlots).values([
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: mainA.id, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 1, lineupSize: 3, occupant: "main", mainBowlerId: mainB.id, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: targetTeam.id, slotIndex: 2, lineupSize: 3, occupant: "unassigned", mainBowlerId: null, recordedByUserId: actorUserId },
      { organizationId, leagueId, teamId: sourceTeam.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: occupiedMain.id, recordedByUserId: actorUserId },
    ]);
    const commandKey = `main-identity-rollback-${randomUUID()}`;
    const request = {
      commandKey,
      requestFingerprint: "",
      lineupSize: 3 as const,
      policy: "main_pays_full" as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: mainB.id },
        { slotIndex: 1, occupant: "main" as const, mainBowlerId: occupiedMain.id },
        { slotIndex: 2, occupant: "unassigned" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);

    await expect(saveTeamRoster({ organizationId, leagueId, teamId: targetTeam.id, actorUserId, request })).rejects.toMatchObject({
      cause: { code: "23505", constraint: "team_payment_slots_main_bowler_unique" },
    });

    const targetSlots = await db.select({ id: teamPaymentSlots.id, slotIndex: teamPaymentSlots.slotIndex, occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId, currentRevision: teamPaymentSlots.currentRevision }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, targetTeam.id),
    )).orderBy(teamPaymentSlots.slotIndex);
    expect(targetSlots.map(({ occupant, mainBowlerId, currentRevision }) => [occupant, mainBowlerId, currentRevision])).toEqual([
      ["main", mainA.id, 1], ["main", mainB.id, 1], ["unassigned", null, 1],
    ]);
    expect(await db.select({ id: teamPaymentSlotRevisions.id }).from(teamPaymentSlotRevisions).where(and(
      eq(teamPaymentSlotRevisions.organizationId, organizationId),
      eq(teamPaymentSlotRevisions.leagueId, leagueId),
      inArray(teamPaymentSlotRevisions.slotId, targetSlots.map(({ id }) => id)),
    ))).toHaveLength(0);
    expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
      eq(financialCommands.organizationId, organizationId),
      eq(financialCommands.leagueId, leagueId),
      eq(financialCommands.idempotencyKey, commandKey),
    ))).toHaveLength(0);
  });

  it("replaces one open slot across the season while preserving other slot identities", async () => {
    await resetBaseRosterToWeeklyMain();
    const [replacement] = await db.insert(bowlers).values({ name: "Batched replacement Main", organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: replacement.id, leagueId, teamId });
    const fixtures = [await createOccurrence(), await createOccurrence(), await createOccurrence()];
    const untouchedBefore = await db.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      inArray(occurrencePaymentResponsibilities.occurrenceId, fixtures.map((fixture) => fixture.occurrence.id)),
      inArray(occurrencePaymentResponsibilities.slotIndex, [1, 2]),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(occurrencePaymentResponsibilities.id);
    const request = {
      commandKey: `batched-slot-replacement-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: replacement.id },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    await saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request });

    for (const fixture of fixtures) {
      const [activeReplacement] = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, leagueId),
        eq(occurrencePaymentResponsibilities.occurrenceId, fixture.occurrence.id),
        eq(occurrencePaymentResponsibilities.teamId, teamId),
        eq(occurrencePaymentResponsibilities.slotIndex, 0),
        eq(occurrencePaymentResponsibilities.state, "active"),
      ));
      if (!activeReplacement) throw new Error("batched replacement responsibility was not materialized");
      expect(activeReplacement).toMatchObject({ version: fixture.responsibility.version + 1, mainBowlerId: replacement.id, state: "active" });
      const [oldResponsibility] = await db.select({ state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
      expect(oldResponsibility?.state).toBe("voided");
      const [oldObligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(oldObligation?.state).toBe("voided");
      const replacementObligations = await db.select({ payerBowlerId: paymentObligations.payerBowlerId, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.responsibilityId, activeReplacement.id),
      ));
      expect(replacementObligations).toEqual([{ payerBowlerId: replacement.id, state: "open" }]);
    }
    const untouchedAfter = await db.select({ occurrenceId: occurrencePaymentResponsibilities.occurrenceId, id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, teamId),
      inArray(occurrencePaymentResponsibilities.occurrenceId, fixtures.map((fixture) => fixture.occurrence.id)),
      inArray(occurrencePaymentResponsibilities.slotIndex, [1, 2]),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(occurrencePaymentResponsibilities.id);
    expect(untouchedAfter).toEqual(untouchedBefore);
  });

  it("repairs a missing default obligation without changing its responsibility version", async () => {
    await resetBaseRosterToWeeklyMain();
    const fixture = await createOccurrence();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      await tx.delete(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.id, fixture.obligation.id),
      ));
    });
    const request = {
      commandKey: `missing-default-obligation-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: bowlerId },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    await saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request });
    const [responsibilityAfter] = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    expect(responsibilityAfter).toEqual({ id: fixture.responsibility.id, version: fixture.responsibility.version, state: "active" });
    const repaired = await db.select({ responsibilityId: paymentObligations.responsibilityId, payerBowlerId: paymentObligations.payerBowlerId, amountMinor: paymentObligations.amountMinor, state: paymentObligations.state }).from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.responsibilityId, fixture.responsibility.id),
    ));
    expect(repaired).toEqual([{ responsibilityId: fixture.responsibility.id, payerBowlerId: bowlerId, amountMinor: 2_000, state: "open" }]);
  });

  it.each(["settled", "partial"] as const)("preserves %s default evidence while applying the new roster to the slot", async (settlement) => {
    await resetBaseRosterToWeeklyMain();
    const [replacement] = await db.insert(bowlers).values({ name: `Paid roster replacement ${settlement}`, organizationId }).returning({ id: bowlers.id });
    await db.insert(bowlerLeagues).values({ bowlerId: replacement.id, leagueId, teamId });
    const fixture = await createOccurrence();
    await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, settlement === "partial" ? 1_000 : 2_000);
    const request = {
      commandKey: `paid-roster-preservation-${settlement}-${randomUUID()}`,
      requestFingerprint: "",
      lineupSize: 3 as const,
      slots: [
        { slotIndex: 0, occupant: "main" as const, mainBowlerId: replacement.id },
        { slotIndex: 1, occupant: "vacant" as const, mainBowlerId: null },
        { slotIndex: 2, occupant: "vacant" as const, mainBowlerId: null },
      ],
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    await saveTeamRoster({ organizationId, leagueId, teamId, actorUserId, request });
    const [responsibilityAfter] = await db.select({ id: occurrencePaymentResponsibilities.id, mainBowlerId: occurrencePaymentResponsibilities.mainBowlerId, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(eq(occurrencePaymentResponsibilities.id, fixture.responsibility.id));
    expect(responsibilityAfter).toEqual({ id: fixture.responsibility.id, mainBowlerId: bowlerId, version: fixture.responsibility.version, state: "active" });
    const [obligationAfter] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
    expect(obligationAfter?.state).toBe(settlement === "partial" ? "partially_settled" : "settled");
    const [slotAfter] = await db.select({ occupant: teamPaymentSlots.occupant, mainBowlerId: teamPaymentSlots.mainBowlerId }).from(teamPaymentSlots).where(and(
      eq(teamPaymentSlots.organizationId, organizationId),
      eq(teamPaymentSlots.leagueId, leagueId),
      eq(teamPaymentSlots.teamId, teamId),
      eq(teamPaymentSlots.slotIndex, 0),
    ));
    expect(slotAfter).toEqual({ occupant: "main", mainBowlerId: replacement.id });
  });

  describe("atomic cash payment edits", () => {
    it("hides the voided original from list, pagination, canonical, and direct read projections while retaining audit evidence", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const listBefore = await getPayments({ organizationId, leagueId });
      const reportBefore = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const request = cashEditRequest(source.payment.id, 1_700, "2038-02-20");

      const result = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });
      const list = await getPayments({ organizationId, leagueId });
      expect(list.map((payment) => payment.id)).toContain(result.replacementPaymentId);
      expect(list.map((payment) => payment.id)).not.toContain(source.payment.id);
      expect(list).toHaveLength(listBefore.length + 1);

      const paginated = await getPaymentsPaginated({ organizationId, leagueId }, 1, 200);
      expect(paginated.pagination).toMatchObject({ total: list.length, totalPages: 1 });
      expect(paginated.items.map((payment) => payment.id)).toContain(result.replacementPaymentId);
      expect(paginated.items.map((payment) => payment.id)).not.toContain(source.payment.id);
      expect(await getVisiblePaymentByIdForOrganization(source.payment.id, organizationId)).toBeUndefined();
      expect((await getVisiblePaymentByIdForOrganization(result.replacementPaymentId, organizationId))?.amount).toBe(1_700);

      const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
      expect(report.rows.map((row) => row.paymentId)).toContain(result.replacementPaymentId);
      expect(report.rows.map((row) => row.paymentId)).not.toContain(source.payment.id);
      const transactionPaymentIds = report.transactions.flatMap((transaction) => transaction.rows.map((row) => row.paymentId));
      expect(transactionPaymentIds).toContain(result.replacementPaymentId);
      expect(transactionPaymentIds).not.toContain(source.payment.id);
      expect(report.totalRows).toBe(reportBefore.totalRows + 1);
      expect(report.totalTransactions).toBe(reportBefore.totalTransactions + 1);
      expect(report.totals.grossConfirmedPaidMinor).toBe(reportBefore.totals.grossConfirmedPaidMinor + 1_700);

      const [retainedOriginal] = await db.select({ status: payments.status, amount: payments.amount }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      ));
      expect(retainedOriginal).toEqual({ status: "voided", amount: 2_000 });
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
        eq(paymentVoids.organizationId, organizationId),
        eq(paymentVoids.leagueId, leagueId),
        eq(paymentVoids.paymentId, source.payment.id),
      ))).toHaveLength(1);
      const [audit] = await db.select({ state: financialCommands.state, result: financialCommands.result }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ));
      expect(audit?.state).toBe("applied");
      expect(audit?.result).toMatchObject({ originalPaymentId: source.payment.id, replacementPaymentId: result.replacementPaymentId });
    });

    it("hides every superseded link in a chained edit and leaves only the latest replacement visible", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const listBefore = await getPayments({ organizationId, leagueId });
      const reportBefore = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
      const source = await createCashEvidence(fixture.obligation.id, 2_000);

      const first = await editCanonicalCashPayment({
        organizationId,
        leagueId,
        actorUserId,
        request: cashEditRequest(source.payment.id, 1_900, "2038-02-03"),
      });
      const second = await editCanonicalCashPayment({
        organizationId,
        leagueId,
        actorUserId,
        request: cashEditRequest(first.replacementPaymentId, 1_700, "2038-02-05"),
      });

      const visibleIds = (await getPayments({ organizationId, leagueId })).map((payment) => payment.id);
      expect(visibleIds).toContain(second.replacementPaymentId);
      expect(visibleIds).not.toContain(source.payment.id);
      expect(visibleIds).not.toContain(first.replacementPaymentId);
      expect(visibleIds).toHaveLength(listBefore.length + 1);
      expect(await getVisiblePaymentByIdForOrganization(source.payment.id, organizationId)).toBeUndefined();
      expect(await getVisiblePaymentByIdForOrganization(first.replacementPaymentId, organizationId)).toBeUndefined();
      expect((await getVisiblePaymentByIdForOrganization(second.replacementPaymentId, organizationId))?.amount).toBe(1_700);

      const report = await readCanonicalPaymentReport({ organizationId, leagueId, page: 1, limit: 200 });
      const reportIds = report.rows.map((row) => row.paymentId);
      expect(reportIds).toContain(second.replacementPaymentId);
      expect(reportIds).not.toContain(source.payment.id);
      expect(reportIds).not.toContain(first.replacementPaymentId);
      expect(report.totalRows).toBe(reportBefore.totalRows + 1);
      expect(report.totals.grossConfirmedPaidMinor).toBe(reportBefore.totals.grossConfirmedPaidMinor + 1_700);
    });

    it("keeps ordinary voids visible and ignores malformed or cross-league edit command evidence", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const voidRequest = {
        paymentId: source.payment.id,
        correctionMode: "void_only" as const,
        reason: "ordinary void fixture",
        idempotencyKey: `ordinary-void-${randomUUID()}`,
        requestFingerprint: "",
      };
      voidRequest.requestFingerprint = canonicalCorrectionFingerprint(voidRequest);
      await correctCanonicalAllocation({ organizationId, leagueId, actorUserId, request: voidRequest });

      const otherLeague = await createUpfrontFallbackFixture();
      const matchingResult = {
        contractVersion: "canonical-cash-payment-edit/1",
        originalPaymentId: source.payment.id,
        replacementPaymentId: source.payment.id + 1,
      };
      await db.insert(financialCommands).values([
        {
          organizationId,
          leagueId: otherLeague.leagueId,
          actorUserId,
          commandType: "roster_payment.edit_cash_payment",
          idempotencyKey: `cross-league-edit-${randomUUID()}`,
          requestFingerprint: `cross-league-fingerprint-${randomUUID()}`,
          state: "applied",
          result: matchingResult,
        },
        {
          organizationId,
          leagueId,
          actorUserId,
          commandType: "roster_payment.edit_cash_payment",
          idempotencyKey: `malformed-edit-${randomUUID()}`,
          requestFingerprint: `malformed-edit-fingerprint-${randomUUID()}`,
          state: "applied",
          result: "malformed-result",
        },
      ]);

      const visible = await getPayments({ organizationId, leagueId });
      expect(visible.map((payment) => payment.id)).toContain(source.payment.id);
      expect((await getVisiblePaymentByIdForOrganization(source.payment.id, organizationId))?.status).toBe("voided");
    });

    it("copies allocations for a date-only edit and records original/replacement audit linkage", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const request = cashEditRequest(source.payment.id, 2_000, "2038-02-20");

      const result = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });
      expect(result).toMatchObject({
        mode: "edit_cash",
        originalPaymentId: source.payment.id,
        oldAmountMinor: 2_000,
        newAmountMinor: 2_000,
        oldPaymentDate: "2038-02-01",
        newPaymentDate: "2038-02-20",
        allocationMode: "copied",
      });
      const [oldPayment] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, source.payment.id));
      const [newPayment] = await db.select({ id: payments.id, status: payments.status, amount: payments.amount, createdAt: payments.createdAt }).from(payments).where(eq(payments.id, result.replacementPaymentId));
      expect(oldPayment?.status).toBe("voided");
      expect(newPayment).toMatchObject({ status: "paid", amount: 2_000 });
      expect(newPayment?.createdAt.slice(0, 10)).toBe("2038-02-20");
      const allocations = await db.select({ paymentId: paymentAllocations.paymentId, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, state: paymentAllocations.state }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.obligationId, fixture.obligation.id),
      )).orderBy(paymentAllocations.createdAt);
      expect(allocations).toEqual([
        { paymentId: source.payment.id, obligationId: fixture.obligation.id, amountMinor: 2_000, state: "voided" },
        { paymentId: result.replacementPaymentId, obligationId: fixture.obligation.id, amountMinor: 2_000, state: "active" },
      ]);
      const [command] = await db.select({ actorUserId: financialCommands.actorUserId, result: financialCommands.result }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ));
      expect(command?.actorUserId).toBe(actorUserId);
      expect(command?.result).toMatchObject({ originalPaymentId: source.payment.id, replacementPaymentId: result.replacementPaymentId, oldAmountMinor: 2_000, newAmountMinor: 2_000, oldPaymentDate: "2038-02-01", newPaymentDate: "2038-02-20" });

      await expect(editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
      const changedRequest = { ...request, amountMinor: 1_500 };
      changedRequest.requestFingerprint = canonicalCashPaymentEditFingerprint(changedRequest);
      await expect(editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: changedRequest })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("reallocates an audited cash tender through a same-amount same-date replacement", async () => {
      await resetBaseRosterToWeeklyMain();
      const sourceFixture = await createOccurrence();
      const targetFixture = await createOccurrence();
      const source = await createCashEvidence(sourceFixture.obligation.id, 2_000);
      const request = historicalCashRepairRequest(source.payment.id, source.allocation, targetFixture.obligation.id);
      const allowlist = historicalCashRepairAllowlist(source.payment.id, source.payment.amount);

      const result = await repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request });

      expect(result).toMatchObject({
        contractVersion: "canonical-historical-cash-reallocation/1",
        mode: "repair_cash_allocation",
        sameTender: true,
        originalPaymentId: source.payment.id,
        amountMinor: source.payment.amount,
        oldAllocationFingerprint: request.expectedOldAllocationFingerprint,
        targetAllocationFingerprint: request.expectedTargetAllocationFingerprint,
      });
      expect(result.replacementPaymentId).not.toBe(source.payment.id);
      expect(result.replacementPayment.createdAt).toBe(source.payment.createdAt);
      expect(result.replacementPayment.amount).toBe(source.payment.amount);
      expect(result.replacementPayment.type).toBe("cash");
      expect(result.replacementPayment.providerPaymentId).toBeNull();
      expect(result.replacementPayment.paymentOperationId).toBeNull();
      expect(result.oldAllocations).toEqual([{
        allocationId: source.allocation.id,
        obligationId: sourceFixture.obligation.id,
        amountMinor: 2_000,
        state: "voided",
        allocationKind: "ordinary",
      }]);
      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0]).toMatchObject({
        paymentId: result.replacementPaymentId,
        obligationId: targetFixture.obligation.id,
        amountMinor: 2_000,
        state: "active",
        allocationKind: "ordinary",
      });

      const [sourceAfter] = await db.select({ status: payments.status }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      ));
      const [replacementAfter] = await db.select({ amount: payments.amount, createdAt: payments.createdAt, status: payments.status }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, result.replacementPaymentId),
      ));
      expect(sourceAfter?.status).toBe("voided");
      expect(replacementAfter).toEqual({ amount: 2_000, createdAt: source.payment.createdAt, status: "paid" });
      expect(await db.select({ state: paymentAllocations.state }).from(paymentAllocations).where(eq(paymentAllocations.id, source.allocation.id))).toEqual([{ state: "voided" }]);

      const allocations = await db.select({ paymentId: paymentAllocations.paymentId, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, state: paymentAllocations.state }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        inArray(paymentAllocations.obligationId, [sourceFixture.obligation.id, targetFixture.obligation.id]),
      )).orderBy(paymentAllocations.createdAt);
      expect(allocations).toEqual([
        { paymentId: source.payment.id, obligationId: sourceFixture.obligation.id, amountMinor: 2_000, state: "voided" },
        { paymentId: result.replacementPaymentId, obligationId: targetFixture.obligation.id, amountMinor: 2_000, state: "active" },
      ]);
      const obligationStates = await db.select({ id: paymentObligations.id, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        inArray(paymentObligations.id, [sourceFixture.obligation.id, targetFixture.obligation.id]),
      )).orderBy(paymentObligations.id);
      expect(Object.fromEntries(obligationStates.map((row) => [row.id, row.state]))).toEqual({
        [sourceFixture.obligation.id]: "open",
        [targetFixture.obligation.id]: "settled",
      });

      const [command] = await db.select({ state: financialCommands.state, result: financialCommands.result }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.repair_historical_cash_allocation"),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ));
      expect(command?.state).toBe("applied");
      expect(command?.result).toMatchObject({
        contractVersion: "canonical-historical-cash-reallocation/1",
        originalPaymentId: source.payment.id,
        replacementPaymentId: result.replacementPaymentId,
        oldAllocationFingerprint: request.expectedOldAllocationFingerprint,
        targetAllocationFingerprint: request.expectedTargetAllocationFingerprint,
      });
    });

    it("atomically moves prepaid cash to the payer's next open date before recording a sub-pays-full responsibility", async () => {
      await resetBaseRosterToWeeklyMain();
      const septemberDate = await createOccurrence({ authoritativeLocalDate: "2038-09-29", plannedOrdinal: 1_009_029 });
      const retainedDate = await createOccurrence({ authoritativeLocalDate: "2038-10-06", plannedOrdinal: 1_010_006 });
      const nextOpenDate = await createOccurrence({ authoritativeLocalDate: "2038-10-13", plannedOrdinal: 1_010_013 });
      const [substitute] = await db.insert(bowlers).values({ name: `Credit fixture substitute ${randomUUID()}`, organizationId }).returning({ id: bowlers.id });
      const source = await createCashEvidenceForAllocations([
        { obligationId: septemberDate.obligation.id, amountMinor: 2_000 },
        { obligationId: retainedDate.obligation.id, amountMinor: 2_000 },
      ], "2038-09-28T12:00:00.000Z");
      const request = historicalCashRepairRequest(source.payment.id, source.allocations, [
        { obligationId: retainedDate.obligation.id, amountMinor: 2_000 },
        { obligationId: nextOpenDate.obligation.id, amountMinor: 2_000 },
      ], `cash-credit-composition-${randomUUID()}`);
      const allowlist = historicalCashRepairAllowlist(source.payment.id, source.payment.amount);
      const responsibility = {
        occurrenceId: septemberDate.occurrence.id,
        teamId,
        slotIndex: 0,
        positionIndex: 0,
        kind: "substitute" as const,
        mainBowlerId: bowlerId,
        substituteBowlerId: substitute.id,
        payerBowlerId: substitute.id,
        policy: "sub_pays_full" as const,
        amountMinor: 2_000,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
        dueAt: septemberDate.obligation.dueAt,
        pastDueAt: septemberDate.obligation.pastDueAt,
        assignmentNote: "credit composition fixture",
      };
      const responsibilities = [responsibility];
      const requestFingerprint = canonicalResponsibilityFingerprint(responsibilities);
      const commandKey = `credit-substitute-composition-${randomUUID()}`;
      const obligationIds = [septemberDate.obligation.id, retainedDate.obligation.id, nextOpenDate.obligation.id];
      const compose = () => db.transaction(async (tx) => {
        const repair = await repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request, transaction: tx });
        const assignment = await recordOccurrenceResponsibilities({
          organizationId,
          leagueId,
          actorUserId,
          commandKey,
          requestFingerprint,
          responsibilities,
          transaction: tx,
        });
        return { repair, assignment };
      });

      await expect(compose()).rejects.toMatchObject({ code: "SUBSTITUTE_ACCESS_DENIED" });

      const [paymentAfterRollback] = await db.select({ status: payments.status, amount: payments.amount }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      ));
      expect(paymentAfterRollback).toEqual({ status: "paid", amount: 4_000 });
      const allocationsAfterRollback = await db.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, state: paymentAllocations.state }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.paymentId, source.payment.id),
      ));
      expect(Object.fromEntries(allocationsAfterRollback.map((allocation) => [allocation.obligationId, { amountMinor: allocation.amountMinor, state: allocation.state }]))).toEqual({
        [septemberDate.obligation.id]: { amountMinor: 2_000, state: "active" },
        [retainedDate.obligation.id]: { amountMinor: 2_000, state: "active" },
      });
      expect(Object.fromEntries((await db.select({ id: paymentObligations.id, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        inArray(paymentObligations.id, obligationIds),
      ))).map((row) => [row.id, row.state]))).toEqual({
        [septemberDate.obligation.id]: "settled",
        [retainedDate.obligation.id]: "settled",
        [nextOpenDate.obligation.id]: "open",
      });
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        inArray(financialCommands.idempotencyKey, [request.idempotencyKey, commandKey]),
      ))).toHaveLength(0);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
        eq(paymentVoids.organizationId, organizationId),
        eq(paymentVoids.leagueId, leagueId),
        eq(paymentVoids.paymentId, source.payment.id),
      ))).toHaveLength(0);

      await db.insert(bowlerLeagues).values({ bowlerId: substitute.id, leagueId, teamId });
      const { repair, assignment } = await compose();

      expect(repair).toMatchObject({
        originalPaymentId: source.payment.id,
        amountMinor: source.payment.amount,
        allocationCount: 2,
      });
      expect(assignment.responsibilities).toHaveLength(1);
      expect(repair.replacementPayment.amount).toBe(source.payment.amount);
      expect(Object.fromEntries(repair.allocations.map((allocation) => [allocation.obligationId, { amountMinor: allocation.amountMinor, state: allocation.state }]))).toEqual({
        [retainedDate.obligation.id]: { amountMinor: 2_000, state: "active" },
        [nextOpenDate.obligation.id]: { amountMinor: 2_000, state: "active" },
      });
      expect(repair.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(repair.replacementPayment.amount);
      expect(Object.fromEntries(repair.oldAllocations.map((allocation) => [allocation.obligationId, { amountMinor: allocation.amountMinor, state: allocation.state }]))).toEqual({
        [septemberDate.obligation.id]: { amountMinor: 2_000, state: "voided" },
        [retainedDate.obligation.id]: { amountMinor: 2_000, state: "voided" },
      });

      const [originalPayment] = await db.select({ status: payments.status, amount: payments.amount }).from(payments).where(eq(payments.id, source.payment.id));
      expect(originalPayment).toEqual({ status: "voided", amount: 4_000 });
      const replacementAllocations = await db.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor, state: paymentAllocations.state }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.paymentId, repair.replacementPaymentId),
      )).orderBy(paymentAllocations.id);
      expect(Object.fromEntries(replacementAllocations.map((allocation) => [allocation.obligationId, { amountMinor: allocation.amountMinor, state: allocation.state }]))).toEqual({
        [retainedDate.obligation.id]: { amountMinor: 2_000, state: "active" },
        [nextOpenDate.obligation.id]: { amountMinor: 2_000, state: "active" },
      });
      expect(replacementAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(repair.replacementPayment.amount);
      expect(await db.select({ id: paymentVoids.id, reason: paymentVoids.reason }).from(paymentVoids).where(and(
        eq(paymentVoids.organizationId, organizationId),
        eq(paymentVoids.leagueId, leagueId),
        eq(paymentVoids.paymentId, source.payment.id),
      ))).toMatchObject([{ reason: request.reason }]);

      const [activeResponsibility] = await db.select({ id: occurrencePaymentResponsibilities.id, responsibilityKind: occurrencePaymentResponsibilities.responsibilityKind, substituteBowlerId: occurrencePaymentResponsibilities.substituteBowlerId, payerBowlerId: occurrencePaymentResponsibilities.payerBowlerId, policy: occurrencePaymentResponsibilities.policy }).from(occurrencePaymentResponsibilities).where(and(
        eq(occurrencePaymentResponsibilities.organizationId, organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, leagueId),
        eq(occurrencePaymentResponsibilities.occurrenceId, septemberDate.occurrence.id),
        eq(occurrencePaymentResponsibilities.state, "active"),
      ));
      expect(activeResponsibility).toMatchObject({ responsibilityKind: "substitute", substituteBowlerId: substitute.id, payerBowlerId: substitute.id, policy: "sub_pays_full" });
      const [substituteObligation] = await db.select({ payerBowlerId: paymentObligations.payerBowlerId, amountMinor: paymentObligations.amountMinor, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.responsibilityId, activeResponsibility.id),
      ));
      expect(substituteObligation).toEqual({ payerBowlerId: substitute.id, amountMinor: 2_000, state: "open" });
      const settledDateStates = await db.select({ id: paymentObligations.id, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        inArray(paymentObligations.id, [retainedDate.obligation.id, nextOpenDate.obligation.id]),
      ));
      expect(Object.fromEntries(settledDateStates.map((row) => [row.id, row.state]))).toEqual({
        [retainedDate.obligation.id]: "settled",
        [nextOpenDate.obligation.id]: "settled",
      });
      const commands = await db.select({ commandType: financialCommands.commandType, idempotencyKey: financialCommands.idempotencyKey, state: financialCommands.state }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        inArray(financialCommands.idempotencyKey, [request.idempotencyKey, commandKey]),
      ));
      expect(Object.fromEntries(commands.map((command) => [command.idempotencyKey, { commandType: command.commandType, state: command.state }]))).toEqual({
        [request.idempotencyKey]: { commandType: "roster_payment.repair_historical_cash_allocation", state: "applied" },
        [commandKey]: { commandType: "roster_payment.record_responsibilities", state: "applied" },
      });

      await expect(repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
      await expect(recordOccurrenceResponsibilities({ organizationId, leagueId, actorUserId, commandKey, requestFingerprint, responsibilities })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
    });

    it("fails closed when a payment is absent from or mismatched with the private allowlist", async () => {
      await resetBaseRosterToWeeklyMain();
      const sourceFixture = await createOccurrence();
      const targetFixture = await createOccurrence();
      const source = await createCashEvidence(sourceFixture.obligation.id, 2_000);
      const request = historicalCashRepairRequest(source.payment.id, source.allocation, targetFixture.obligation.id);

      await expect(repairHistoricalCashPaymentAllocation({
        organizationId,
        leagueId,
        actorUserId,
        allowlist: historicalCashRepairAllowlist(source.payment.id, 1_999),
        request,
      })).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
      await expect(repairHistoricalCashPaymentAllocation({
        organizationId,
        leagueId,
        actorUserId,
        allowlist: { paymentAmountsMinor: {} },
        request,
      })).rejects.toMatchObject({ code: "PAYMENT_NOT_ALLOWLISTED" });

      const [payment] = await db.select({ status: payments.status }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      ));
      expect(payment?.status).toBe("paid");
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ))).toHaveLength(0);
    });

    it("replays an audited cash repair and rejects a conflicting reuse of its command key", async () => {
      await resetBaseRosterToWeeklyMain();
      const sourceFixture = await createOccurrence();
      const targetFixture = await createOccurrence();
      const source = await createCashEvidence(sourceFixture.obligation.id, 2_000);
      const request = historicalCashRepairRequest(source.payment.id, source.allocation, targetFixture.obligation.id);
      const allowlist = historicalCashRepairAllowlist(source.payment.id, source.payment.amount);
      const first = await repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request });

      await expect(repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });

      const changedRequest: HistoricalCashAllocationRepairRequest = {
        ...request,
        reason: "different audited reason",
        requestFingerprint: "",
      };
      changedRequest.requestFingerprint = canonicalHistoricalCashAllocationRepairFingerprint({ organizationId, leagueId, request: changedRequest });
      await expect(repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request: changedRequest })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      expect(await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.status, "paid"),
      ))).toHaveLength(1);
      expect((await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.repair_historical_cash_allocation"),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ))).length).toBe(1);
      expect(first.replacementPaymentId).not.toBe(source.payment.id);
    });

    it("rejects stale source allocation evidence without recording a command or changing the tender", async () => {
      await resetBaseRosterToWeeklyMain();
      const sourceFixture = await createOccurrence();
      const targetFixture = await createOccurrence();
      const source = await createCashEvidence(sourceFixture.obligation.id, 2_000);
      const request = historicalCashRepairRequest(source.payment.id, source.allocation, targetFixture.obligation.id);
      const allowlist = historicalCashRepairAllowlist(source.payment.id, source.payment.amount);
      const staleRequest: HistoricalCashAllocationRepairRequest = {
        ...request,
        expectedOldAllocationFingerprint: "lvrepaircashalloc:v1:" + "0".repeat(64),
        requestFingerprint: "",
      };
      staleRequest.requestFingerprint = canonicalHistoricalCashAllocationRepairFingerprint({ organizationId, leagueId, request: staleRequest });

      await expect(repairHistoricalCashPaymentAllocation({ organizationId, leagueId, actorUserId, allowlist, request: staleRequest })).rejects.toMatchObject({ code: "REPAIR_SOURCE_FINGERPRINT_MISMATCH" });
      const [payment] = await db.select({ status: payments.status }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      ));
      expect(payment?.status).toBe("paid");
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
        eq(paymentVoids.organizationId, organizationId),
        eq(paymentVoids.leagueId, leagueId),
        eq(paymentVoids.paymentId, source.payment.id),
      ))).toHaveLength(0);
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.idempotencyKey, staleRequest.idempotencyKey),
      ))).toHaveLength(0);
    });

    it.each([
      { label: "increase", editedAmount: 1_500, expected: [1_500] },
      { label: "decrease", editedAmount: 500, expected: [500] },
    ])("reapplies FIFO on amount $label", async ({ editedAmount, expected }) => {
      await resetBaseRosterToWeeklyMain();
      const first = await createOccurrence();
      const second = await createOccurrence();
      const source = await createCashEvidence(first.obligation.id, 1_000);
      const request = cashEditRequest(source.payment.id, editedAmount, "2038-02-01");

      const result = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });
      expect(result.allocationMode).toBe("fifo_reapplied");
      const active = await db.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
        eq(paymentAllocations.paymentId, result.replacementPaymentId),
        eq(paymentAllocations.state, "active"),
      )).orderBy(paymentAllocations.id);
      if (editedAmount === 1_500) {
        expect(active).toEqual([
          { obligationId: first.obligation.id, amountMinor: 1_500 },
        ]);
        expect(second.obligation.id).not.toBe(first.obligation.id);
      } else {
        expect(active).toEqual([{ obligationId: first.obligation.id, amountMinor: 500 }]);
      }
      expect(expected[0]).toBe(editedAmount);
    });

    it("reopens a partially covered FIFO tail only for the audited cash edit", async () => {
      await resetBaseRosterToWeeklyMain();
      const first = await createOccurrence();
      const second = await createOccurrence();
      const source = await createCashEvidenceForAllocations([
        { obligationId: first.obligation.id, amountMinor: 1_000 },
        { obligationId: second.obligation.id, amountMinor: 500 },
      ]);
      const request = cashEditRequest(source.payment.id, 800, "2038-02-01");

      const result = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });
      const active = await db.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
        eq(paymentAllocations.paymentId, result.replacementPaymentId),
        eq(paymentAllocations.state, "active"),
      )).orderBy(paymentAllocations.id);
      expect(active).toEqual([{ obligationId: first.obligation.id, amountMinor: 800 }]);
      const obligationStates = await db.select({ id: paymentObligations.id, state: paymentObligations.state }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        inArray(paymentObligations.id, [first.obligation.id, second.obligation.id]),
      )).orderBy(paymentObligations.id);
      expect(Object.fromEntries(obligationStates.map((row) => [row.id, row.state]))).toEqual({
        [first.obligation.id]: "partially_settled",
        [second.obligation.id]: "open",
      });
    });

    it("keeps unsupported manual partial-to-open obligation reopening rejected", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      await createCashEvidence(fixture.obligation.id, 1_000);

      await expect(db.update(paymentObligations).set({ state: "open" }).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, fixture.obligation.id),
      ))).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining("roster payment evidence is append-only") }),
      });
      const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(obligation?.state).toBe("partially_settled");
    });

    it("serializes concurrent edits so one original wins and the stale retry is rejected", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const firstRequest = cashEditRequest(source.payment.id, 1_500, "2038-02-03");
      const secondRequest = cashEditRequest(source.payment.id, 1_000, "2038-02-04");

      const outcomes = await Promise.allSettled([
        editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: firstRequest }),
        editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: secondRequest }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "CASH_EDIT_UNAVAILABLE" } });
      const [sourceAfter] = await db.select({ status: payments.status }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, source.payment.id),
      )).orderBy(payments.id);
      expect(sourceAfter?.status).toBe("voided");
      const paidAfter = await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.status, "paid"),
      ));
      expect(paidAfter).toHaveLength(1);
      expect(paidAfter[0]?.id).not.toBe(source.payment.id);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
        eq(paymentVoids.organizationId, organizationId),
        eq(paymentVoids.leagueId, leagueId),
        eq(paymentVoids.paymentId, source.payment.id),
      ))).toHaveLength(1);
    });

    it("resolves payment dates in the league timezone across a UTC boundary and DST", async () => {
      await resetBaseRosterToWeeklyMain();
      await db.update(leagues).set({ timezone: "America/New_York" }).where(and(
        eq(leagues.organizationId, organizationId),
        eq(leagues.id, leagueId),
      ));
      try {
        const fixture = await createOccurrence();
        const source = await createCashEvidence(fixture.obligation.id, 2_000, "2038-03-13T04:30:00.000Z");
        const request = cashEditRequest(source.payment.id, 2_000, "2038-03-14");

        const result = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });
        expect(result).toMatchObject({ oldPaymentDate: "2038-03-12", newPaymentDate: "2038-03-14", allocationMode: "copied" });
        const [replacement] = await db.select({ createdAt: payments.createdAt }).from(payments).where(and(
          eq(payments.organizationId, organizationId),
          eq(payments.id, result.replacementPaymentId),
        ));
        expect(new Date(replacement?.createdAt ?? "").toISOString()).toBe("2038-03-14T16:00:00.000Z");
      } finally {
        await db.update(leagues).set({ timezone: "UTC" }).where(and(
          eq(leagues.organizationId, organizationId),
          eq(leagues.id, leagueId),
        ));
      }
    });

    it("rolls back the void and replacement when the edited amount cannot be allocated", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 1_000);
      const request = cashEditRequest(source.payment.id, 3_000, "2038-02-02");

      await expect(editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "EXCESS_PAYMENT" });
      const [payment] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, source.payment.id));
      expect(payment?.status).toBe("paid");
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(and(eq(paymentVoids.organizationId, organizationId), eq(paymentVoids.paymentId, source.payment.id)))).toHaveLength(0);
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(eq(financialCommands.organizationId, organizationId), eq(financialCommands.idempotencyKey, request.idempotencyKey)))).toHaveLength(0);
    });

    it("rejects allocation review evidence before making any correction", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      await db.update(paymentAllocations).set({ reviewRequired: true, reviewReason: "fixture review" }).where(eq(paymentAllocations.id, source.allocation.id));
      const request = cashEditRequest(source.payment.id, 2_000, "2038-02-02");

      await expect(editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "CASH_EDIT_UNAVAILABLE" });
      const [payment] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, source.payment.id));
      expect(payment?.status).toBe("paid");
    });
  });

  describe("permanent cash payment deletion", () => {
    it("deletes an active cash payment, preserves another tender, restores the partial balance, and guards both replays", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const manualIdempotencyKey = `manual-delete-${randomUUID()}`;
      const quote = await quoteInteractiveObligations({ organizationId, leagueId, amountMinor: 1_000, payerBowlerId: bowlerId });
      const manualRequest = {
        amountMinor: 1_000,
        payerBowlerId: bowlerId,
        type: "cash" as const,
        idempotencyKey: manualIdempotencyKey,
        requestFingerprint: quote.fingerprint,
      };
      const created = await recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request: manualRequest });
      const deletedPayment = created.records[0]?.payment;
      if (!deletedPayment) throw new Error("manual cash fixture was not created");
      const remainingTender = await createCashEvidence(fixture.obligation.id, 1_000, "2038-02-02T12:00:00.000Z");
      const request = cashDeleteRequest(deletedPayment.id);
      const paymentHistoryBefore = await readCanonicalPaymentReport({ organizationId, leagueId, bowlerId, page: 1, limit: 100 });
      expect(paymentHistoryBefore.rows.map((row) => row.paymentId)).toContain(deletedPayment.id);

      const result = await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });

      expect(result).toMatchObject({
        contractVersion: "canonical-cash-payment-delete/1",
        deleted: true,
        paymentId: deletedPayment.id,
        previousStatus: "paid",
        amountMinor: 1_000,
        reason: request.reason,
        deletedAllocationCount: 1,
        deletedVoidEvidence: false,
        restoredObligationIds: [fixture.obligation.id],
      });
      expect(await db.select({ id: payments.id }).from(payments).where(and(
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, leagueId),
        eq(payments.id, deletedPayment.id),
      ))).toHaveLength(0);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(eq(paymentVoids.paymentId, deletedPayment.id))).toHaveLength(0);
      const paymentHistoryAfter = await readCanonicalPaymentReport({ organizationId, leagueId, bowlerId, page: 1, limit: 100 });
      expect(paymentHistoryAfter.rows.map((row) => row.paymentId)).not.toContain(deletedPayment.id);
      const activeAllocations = await db.select({ paymentId: paymentAllocations.paymentId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, organizationId),
        eq(paymentAllocations.leagueId, leagueId),
        eq(paymentAllocations.obligationId, fixture.obligation.id),
        eq(paymentAllocations.state, "active"),
      ));
      expect(activeAllocations).toEqual([{ paymentId: remainingTender.payment.id, amountMinor: 1_000 }]);
      const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(obligation?.state).toBe("partially_settled");

      const [deleteCommand] = await db.select({ state: financialCommands.state, result: financialCommands.result }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.delete_cash_payment"),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ));
      expect(deleteCommand).toMatchObject({ state: "applied", result: { paymentId: deletedPayment.id, reason: request.reason } });
      await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
      await expect(recordCanonicalManualPayment({ organizationId, leagueId, actorUserId, request: manualRequest })).rejects.toMatchObject({ code: "PAYMENT_COMMAND_TARGET_DELETED" });
      await expectCashDeletionMarkerOff();
    });

    it("restores a settled obligation to open when deleting its sole active cash tender", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const [before] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(before?.state).toBe("settled");

      await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: cashDeleteRequest(source.payment.id) });

      const [after] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(after?.state).toBe("open");
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(eq(paymentVoids.paymentId, source.payment.id))).toHaveLength(0);
      await expectCashDeletionMarkerOff();
    });

    it("reopens a partially settled obligation when its only partial cash tender is deleted", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 1_000);
      const [before] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(before?.state).toBe("partially_settled");

      await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: cashDeleteRequest(source.payment.id) });

      const [after] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(after?.state).toBe("open");
      await expectCashDeletionMarkerOff();
    });

    it("does not resolve a payment ID from another league in the same organization", async () => {
      await resetBaseRosterToWeeklyMain();
      const otherLeague = await createUpfrontFallbackFixture();
      const fixture = await otherLeague.createOccurrence();
      const otherPayment = await db.transaction(async (tx) => {
        const [payment] = await tx.insert(payments).values({
          organizationId,
          bowlerId,
          leagueId: otherLeague.leagueId,
          amount: 2_000,
          currency: "USD",
          status: "paid",
          type: "cash",
        }).returning({ id: payments.id });
        if (!payment) throw new Error("cross-league payment fixture was not created");
        await tx.insert(paymentAllocations).values({
          organizationId,
          leagueId: otherLeague.leagueId,
          paymentId: payment.id,
          obligationId: fixture.obligation.id,
          amountMinor: 2_000,
          currency: "USD",
          recordedByUserId: actorUserId,
        });
        await tx.update(paymentObligations).set({ state: "settled" }).where(and(
          eq(paymentObligations.organizationId, organizationId),
          eq(paymentObligations.leagueId, otherLeague.leagueId),
          eq(paymentObligations.id, fixture.obligation.id),
        ));
        return payment;
      });
      const request = cashDeleteRequest(otherPayment.id);

      await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      expect(await db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.id, otherPayment.id))).toEqual([{ id: otherPayment.id, status: "paid" }]);
      expect(await db.select({ state: paymentAllocations.state }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, otherPayment.id))).toEqual([{ state: "active" }]);
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.delete_cash_payment"),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ))).toHaveLength(0);
      await expectCashDeletionMarkerOff();

      await deleteCanonicalCashPayment({ organizationId, leagueId: otherLeague.leagueId, actorUserId, request });
    });

    it("removes a voided cash payment without restoring its balances twice and rejects an old void replay", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const voidRequest = {
        paymentId: source.payment.id,
        correctionMode: "void_only" as const,
        reason: "duplicate tender",
        idempotencyKey: `void-before-delete-${randomUUID()}`,
        requestFingerprint: "",
      };
      voidRequest.requestFingerprint = canonicalCorrectionFingerprint(voidRequest);
      await correctCanonicalAllocation({ organizationId, leagueId, actorUserId, request: voidRequest });
      const voidedHistory = await readCanonicalPaymentReport({ organizationId, leagueId, bowlerId, page: 1, limit: 100 });
      expect(voidedHistory.rows.find((row) => row.paymentId === source.payment.id)).toMatchObject({ correctionEvidence: { status: "voided" } });
      const request = cashDeleteRequest(source.payment.id, "remove the voided duplicate");

      const result = await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request });

      expect(result).toMatchObject({ previousStatus: "voided", deletedVoidEvidence: true, deletedAllocationCount: 1 });
      expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.id, source.payment.id))).toHaveLength(0);
      expect(await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, source.payment.id))).toHaveLength(0);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(eq(paymentVoids.paymentId, source.payment.id))).toHaveLength(0);
      const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(obligation?.state).toBe("open");
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.void_payment"),
        eq(financialCommands.idempotencyKey, voidRequest.idempotencyKey),
      ))).toHaveLength(1);
      await expect(correctCanonicalAllocation({ organizationId, leagueId, actorUserId, request: voidRequest })).rejects.toMatchObject({ code: "PAYMENT_COMMAND_TARGET_DELETED" });
      await expectCashDeletionMarkerOff();
    });

    it("preserves the cash-edit original visibility link and rejects an edit replay after deleting its replacement", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const editRequest = cashEditRequest(source.payment.id, 2_000, "2038-02-20");
      const edited = await editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: editRequest });
      const deletion = cashDeleteRequest(edited.replacementPaymentId);

      await deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: deletion });

      const [editCommand] = await db.select({ result: financialCommands.result }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.edit_cash_payment"),
        eq(financialCommands.idempotencyKey, editRequest.idempotencyKey),
      ));
      expect(editCommand?.result).toMatchObject({ originalPaymentId: source.payment.id, replacementPaymentId: edited.replacementPaymentId });
      expect(await getVisiblePaymentByIdForOrganization(source.payment.id, organizationId)).toBeUndefined();
      expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.id, edited.replacementPaymentId))).toHaveLength(0);
      await expect(editCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: editRequest })).rejects.toMatchObject({ code: "PAYMENT_COMMAND_TARGET_DELETED" });
    });

    it("rejects rotating-credit funding evidence and retains the tender", async () => {
      await resetBaseRosterToWeeklyMain();
      const creditFundingKey = `cash-delete-credit-${randomUUID()}`;
      const paymentId = await db.transaction(async (tx) => {
        const [payment] = await tx.insert(payments).values({
          organizationId,
          bowlerId,
          leagueId,
          amount: 2_000,
          currency: "USD",
          status: "paid",
          type: "cash",
          idempotencyKey: `${creditFundingKey}:payment`,
        }).returning({ id: payments.id });
        if (!payment) throw new Error("rotating-credit dependency fixture was not created");
        await tx.insert(rotatingCreditFundings).values({
          organizationId,
          leagueId,
          bowlerId,
          paymentId: payment.id,
          amountMinor: 2_000,
          currency: "USD",
          fundingKind: "cash",
          idempotencyKey: creditFundingKey,
          requestFingerprint: `lvrotcrreq:v1:${"a".repeat(64)}`,
          quoteFingerprint: `lvrotcrquote:v1:${"b".repeat(64)}`,
          actorUserId,
        });
        return payment.id;
      });
      const request = cashDeleteRequest(paymentId);

      try {
        await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "ROTATING_CREDIT_TENDER_IMMUTABLE", status: 409 });

        expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.id, paymentId))).toHaveLength(1);
        expect(await db.select({ paymentId: rotatingCreditFundings.paymentId }).from(rotatingCreditFundings).where(eq(rotatingCreditFundings.paymentId, paymentId))).toEqual([{ paymentId }]);
        expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
          eq(financialCommands.organizationId, organizationId),
          eq(financialCommands.leagueId, leagueId),
          eq(financialCommands.commandType, "roster_payment.delete_cash_payment"),
          eq(financialCommands.idempotencyKey, request.idempotencyKey),
        ))).toHaveLength(0);
        await expectCashDeletionMarkerOff();
      } finally {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
          await tx.delete(rotatingCreditFundings).where(eq(rotatingCreditFundings.paymentId, paymentId));
          await tx.delete(payments).where(eq(payments.id, paymentId));
        });
      }
    });

    it("rejects restrictive refund snapshot evidence before changing the payment", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const operationId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(paymentOperations).values({
          id: operationId,
          organizationId,
          authorizingUserId: actorUserId,
          operationType: "refund",
          targetKey: `cash-delete-refund:${operationId}`,
          leagueId,
          amountMinor: 2_000,
          currency: "USD",
          requestFingerprint: `lvpayreq:v1:${"d".repeat(64)}`,
          providerIdempotencyKey: `cash-delete-refund-${operationId}`.slice(0, 45),
          providerName: "square",
          status: "pending",
        });
        await tx.insert(refundPaymentOperationSnapshots).values({
          operationId,
          snapshotVersion: 2,
          snapshotFingerprint: `lvpayexecrf:v2:${"e".repeat(64)}`,
          paymentId: source.payment.id,
          leagueId,
          locationId,
          encryptedProviderPaymentId: "fixture-encrypted-provider-payment-id",
          reason: "linked refund operation",
          requestedByUserId: actorUserId,
          requestedByRole: "org_admin",
          requestedByOrganizationId: organizationId,
          disposition: "still_owed",
          allocationSnapshot: [{ allocationId: source.allocation.id, obligationId: fixture.obligation.id, amountMinor: 2_000, currency: "USD" }],
        });
      });
      const request = cashDeleteRequest(source.payment.id);

      await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "CASH_PAYMENT_DELETE_HAS_DEPENDENT_EVIDENCE", status: 409 });

      expect(await db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.id, source.payment.id))).toEqual([{ id: source.payment.id, status: "paid" }]);
      expect(await db.select({ state: paymentAllocations.state }).from(paymentAllocations).where(eq(paymentAllocations.id, source.allocation.id))).toEqual([{ state: "active" }]);
      expect(await db.select({ operationId: refundPaymentOperationSnapshots.operationId }).from(refundPaymentOperationSnapshots).where(eq(refundPaymentOperationSnapshots.paymentId, source.payment.id))).toEqual([{ operationId }]);
      await expectCashDeletionMarkerOff();
    });

    it("rejects reserved obligations before creating temporary void evidence", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 1_000);
      await createRosterOperation(fixture.obligation.id, fixture.responsibility.id, 1_000, { withCanonicalPayment: false });
      const request = cashDeleteRequest(source.payment.id);

      await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "OBLIGATION_RESERVED", status: 409 });

      expect(await db.select({ status: payments.status }).from(payments).where(eq(payments.id, source.payment.id))).toEqual([{ status: "paid" }]);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(eq(paymentVoids.paymentId, source.payment.id))).toHaveLength(0);
      await expectCashDeletionMarkerOff();
    });

    it("rejects allocation review flags without changing the cash payment", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      await db.update(paymentAllocations).set({ reviewRequired: true, reviewReason: "fixture review" }).where(eq(paymentAllocations.id, source.allocation.id));

      await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request: cashDeleteRequest(source.payment.id) })).rejects.toMatchObject({ code: "CASH_PAYMENT_DELETE_UNAVAILABLE", status: 409 });

      expect(await db.select({ status: payments.status }).from(payments).where(eq(payments.id, source.payment.id))).toEqual([{ status: "paid" }]);
      expect(await db.select({ state: paymentAllocations.state }).from(paymentAllocations).where(eq(paymentAllocations.id, source.allocation.id))).toEqual([{ state: "active" }]);
      await expectCashDeletionMarkerOff();
    });

    it("rolls back removed allocations and restored balances when the final parent delete fails", async () => {
      await resetBaseRosterToWeeklyMain();
      const fixture = await createOccurrence();
      const source = await createCashEvidence(fixture.obligation.id, 2_000);
      const request = cashDeleteRequest(source.payment.id);
      await db.execute(sql`CREATE OR REPLACE FUNCTION cash_payment_delete_test_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated restrictive foreign-key dependency' USING ERRCODE = '23503'; END; $$`);
      await db.execute(sql`CREATE TRIGGER cash_payment_delete_test_failure_trigger
        BEFORE DELETE ON payments FOR EACH ROW
        EXECUTE FUNCTION cash_payment_delete_test_failure()`);
      try {
        await expect(deleteCanonicalCashPayment({ organizationId, leagueId, actorUserId, request })).rejects.toMatchObject({ code: "CASH_PAYMENT_DELETE_HAS_DEPENDENT_EVIDENCE", status: 409 });
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS cash_payment_delete_test_failure_trigger ON payments`);
        await db.execute(sql`DROP FUNCTION IF EXISTS cash_payment_delete_test_failure()`);
      }

      expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.id, source.payment.id))).toHaveLength(1);
      expect(await db.select({ state: paymentAllocations.state }).from(paymentAllocations).where(eq(paymentAllocations.id, source.allocation.id))).toEqual([{ state: "active" }]);
      expect(await db.select({ id: paymentVoids.id }).from(paymentVoids).where(eq(paymentVoids.paymentId, source.payment.id))).toHaveLength(0);
      const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(paymentObligations.id, fixture.obligation.id));
      expect(obligation?.state).toBe("settled");
      expect(await db.select({ id: financialCommands.id }).from(financialCommands).where(and(
        eq(financialCommands.organizationId, organizationId),
        eq(financialCommands.leagueId, leagueId),
        eq(financialCommands.commandType, "roster_payment.delete_cash_payment"),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ))).toHaveLength(0);
      await expectCashDeletionMarkerOff();
    });
  });
});
