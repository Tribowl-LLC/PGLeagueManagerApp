import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  financialActivations,
  financialResponsibilities,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueOccurrenceRevisions,
  leagueOccurrenceRelationshipRevisions,
  leagueOccurrenceRelationships,
  leagueOccurrenceBillingTermRevisions,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  teams,
  users,
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceObligations,
  bowlerOccurrenceTeamAssignments,
  financialActivationRevisions,
  financialActivationCancellationSuppressions,
  bowlerOccurrenceEligibilityRevisions,
  bowlerOccurrenceTeamAssignmentRevisions,
  bowlerOccurrenceObligationRevisions,
  payments,
  paymentOccurrenceAllocations,
  paymentSchedules,
  paymentOperations,
  scheduledPaymentOperationSnapshots,
  interactivePaymentOperationSnapshots,
  refundPaymentOperationSnapshots,
  paymentOperationOccurrenceSnapshots,
  paymentOperationOccurrenceSnapshotAllocations,
  occurrenceCollectionPlans,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlanRevisions,
  paymentOccurrenceAllocationRevisions,
  paymentDisputes,
  webhookEvents,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { activateCanonicalFinancials, getCanonicalActivationSource, readCanonicalDuePastDue } from "../../server/services/canonical-due-past-due";
import { quoteInteractiveOccurrenceAllocations } from "../../server/services/interactive-occurrence-allocation";
import { prepareInteractivePaymentOperation } from "../../server/services/interactive-payment-operation-preparation";
import { buildCanonicalScheduleCommandFingerprint, cancelOccurrence } from "../../server/services/canonical-occurrence-transactions";
import { getTestDb } from "../setup/test-db";
import { apiDelete, login, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "../helpers";

const db = getTestDb();
const createdOrganizations: number[] = [];

async function operationalFixture(paymentMode: "weekly" | "upfront", lineupSize: 3 | 4) {
  const suffix = `${paymentMode}-${lineupSize}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [organization] = await db.insert(organizations).values({ name: `F1 activation ${suffix}`, slug: `f1-activation-${suffix}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture failed");
  createdOrganizations.push(organization.id);
  const [actor] = await db.insert(users).values({ email: `f1-activation-${suffix}@example.test`, password: "test", name: "F1 activation actor", role: "org_admin", organizationId: organization.id }).returning({ id: users.id });
  const [location] = await db.insert(locations).values({ name: "F1 activation lanes", organizationId: organization.id }).returning({ id: locations.id });
  const [league] = await db.insert(leagues).values({ name: `F1 activation league ${suffix}`, organizationId: organization.id, locationId: location.id, seasonStart: "2038-01-01", seasonEnd: "2038-12-31", weekDay: "Sunday", competitionStartTime: "19:00", timezone: "UTC", totalBowlingWeeks: 12, weeklyFee: 500, paymentMode }).returning({ id: leagues.id });
  const [team] = await db.insert(teams).values({ name: "F1 explicit team", number: 1, leagueId: league.id }).returning({ id: teams.id });
  const bowlersInserted = await db.insert(bowlers).values(Array.from({ length: lineupSize }, (_, index) => ({ name: `F1 payer ${index}`, organizationId: organization.id, active: true }))).returning({ id: bowlers.id });
  await db.insert(bowlerLeagues).values(bowlersInserted.map((bowler) => ({ bowlerId: bowler.id, leagueId: league.id, teamId: team.id, active: true })));
  const [command] = await db.insert(leagueScheduleCommands).values({ organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, commandType: "publish", reason: "F1 operational fixture", idempotencyKey: `f1-publish-${suffix}`, requestFingerprint: `lvf1publish:${suffix}` }).returning({ id: leagueScheduleCommands.id });
  const generatedCount = paymentMode === "weekly" ? 7 : 1;
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({ organizationId: organization.id, leagueId: league.id, originatingCommandId: command.id, generatorVersion: "f1-activation-fixture/1", inputFingerprint: `lvf1run:${suffix}`, sourceScheduleRevision: 1, normalizedInputSnapshot: { fixture: "f1" }, rangeStartDate: "2038-01-01", rangeEndDate: "2038-12-31", candidateOccurrenceCount: generatedCount, generatedOccurrenceCount: generatedCount, state: "applied", approvedAt: "2037-12-01T00:00:00.000Z", approvedByUserId: actor.id, approvalCommandId: command.id }).returning({ id: leagueOccurrenceGenerationRuns.id });
  const kinds = ["regular", "makeup", "position_round", "rolloff", "playoff", "extension"] as const;
  const occurrences = [] as Array<{ id: string; kind: typeof kinds[number]; status: "scheduled" | "cancelled" | "completed" | "discarded"; startAt: string }>;
  for (let index = 0; index < (paymentMode === "weekly" ? kinds.length + 1 : 1); index += 1) {
    const kind = (kinds[index] ?? "regular");
    const cancelled = paymentMode === "weekly" && index === kinds.length - 1;
    const explicitNone = paymentMode === "weekly" && index === kinds.length;
    const [occurrence] = await db.insert(leagueOccurrences).values({ organizationId: organization.id, leagueId: league.id, locationId: location.id, generationKey: `f1-occurrence-${suffix}-${index}`, generationRunId: run.id, kind, status: cancelled ? "cancelled" : "scheduled", lifecycle: "published", authoritativeLocalDate: `2038-02-${String(index + 1).padStart(2, "0")}`, authoritativeLocalStartTime: "19:00:00", timezone: "UTC", startAt: `2038-02-${String(index + 1).padStart(2, "0")}T19:00:00.000Z`, selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous", resolverVersion: "f1-activation-fixture/1", plannedOrdinal: index + 1, competitionNumber: cancelled ? null : index + 1, competitive: !cancelled, countsInStandings: !cancelled, currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id, cancelledAt: cancelled ? "2037-12-02T00:00:00.000Z" : null, cancelledByUserId: cancelled ? actor.id : null, cancellationCommandId: cancelled ? command.id : null }).returning({ id: leagueOccurrences.id, kind: leagueOccurrences.kind, status: leagueOccurrences.status, startAt: leagueOccurrences.startAt });
    if (!occurrence) throw new Error("occurrence fixture failed");
    occurrences.push(occurrence);
    const [term] = await db.insert(leagueOccurrenceBillingTerms).values({ organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, purpose: "league_weekly_fee", obligationPolicy: cancelled || explicitNone ? "none" : "eligible_bowlers", defaultAmountMinor: cancelled || explicitNone ? 0 : 500, currency: "USD", billingOrdinal: cancelled || explicitNone ? null : index + 1, version: 1, state: "published", currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id }).returning({ id: leagueOccurrenceBillingTerms.id });
    await db.insert(leagueOccurrenceRevisions).values({ organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, commandId: command.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { lifecycle: "published", status: occurrence.status, kind: occurrence.kind, plannedOrdinal: index + 1 } });
    await db.insert(leagueOccurrenceBillingTermRevisions).values({ organizationId: organization.id, leagueId: league.id, billingTermId: term.id, commandId: command.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { id: term.id, organizationId: organization.id, leagueId: league.id, occurrenceId: occurrence.id, purpose: "league_weekly_fee", obligationPolicy: cancelled || explicitNone ? "none" : "eligible_bowlers", defaultAmountMinor: cancelled || explicitNone ? 0 : 500, currency: "USD", billingOrdinal: cancelled || explicitNone ? null : index + 1, version: 1, state: "published", currentRevision: 1, lastCommandId: command.id } });
  }
  if (paymentMode === "weekly") {
    const [relationship] = await db.insert(leagueOccurrenceRelationships).values({ organizationId: organization.id, leagueId: league.id, kind: "makeup_for", sourceOccurrenceId: occurrences[1].id, targetOccurrenceId: occurrences[0].id, state: "published", currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id }).returning({ id: leagueOccurrenceRelationships.id });
    await db.insert(leagueOccurrenceRelationshipRevisions).values({ organizationId: organization.id, leagueId: league.id, relationshipId: relationship.id, commandId: command.id, revisionNumber: 1, snapshotSchemaVersion: 1, afterSnapshot: { state: "published", kind: "makeup_for" } });
  }
  return { organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, locationId: location.id, teamId: team.id, scheduleCommandId: command.id, bowlers: bowlersInserted, occurrences };
}

function selections(fixture: Awaited<ReturnType<typeof operationalFixture>>, lineupSize: 3 | 4) {
  return fixture.occurrences.filter((occurrence, index) => occurrence.status === "scheduled" && !(fixture.occurrences.length > 1 && index === fixture.occurrences.length - 1)).flatMap((occurrence) => fixture.bowlers.map((bowler, slotIndex) => ({ occurrenceId: occurrence.id, teamId: fixture.teamId, slotIndex, bowlerId: bowler.id, role: slotIndex === lineupSize - 1 ? "substitute" as const : "regular" as const, provenance: "explicit_admin_selection" as const })));
}

async function insertPristineRefusalEvidence(fixture: Awaited<ReturnType<typeof operationalFixture>>, kind: string): Promise<void> {
  const occurrenceId = fixture.occurrences[0].id;
  if (kind === "payment_schedule") {
    await db.insert(paymentSchedules).values({ bowlerId: fixture.bowlers[0].id, leagueId: fixture.leagueId, frequency: "weekly", amount: 500, nextPaymentDate: "2038-02-01T19:00:00.000Z", nextOccurrenceId: occurrenceId, active: true, paymentCardId: "fixture-card" });
    return;
  }
  if (kind === "collection_plan") {
    await db.insert(occurrenceCollectionPlans).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, planKey: `f1-refusal-${kind}`, collectAt: "2038-02-01T18:00:00.000Z", currency: "USD", state: "draft", recordedByUserId: fixture.actorUserId });
    return;
  }
  if (kind === "eligibility") {
    await db.insert(bowlerOccurrenceEligibilities).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, occurrenceId, bowlerId: fixture.bowlers[0].id, state: "eligible", reason: "explicit_admin_selection", recordedByUserId: fixture.actorUserId });
    return;
  }
  const operationType = kind === "refund_snapshot" ? "refund" : kind === "interactive_snapshot" ? "interactive_charge" : "scheduled_charge";
  let paymentScheduleId: number | undefined;
  if (operationType === "scheduled_charge") {
    const [schedule] = await db.insert(paymentSchedules).values({ bowlerId: fixture.bowlers[0].id, leagueId: fixture.leagueId, frequency: "weekly", amount: 500, nextPaymentDate: "2038-02-01T19:00:00.000Z", nextOccurrenceId: occurrenceId, active: true, paymentCardId: "fixture-card" }).returning({ id: paymentSchedules.id });
    paymentScheduleId = schedule.id;
  }
  const [operation] = await db.insert(paymentOperations).values({ organizationId: fixture.organizationId, operationType, targetKey: `f1-refusal-${kind}`, ...(operationType === "scheduled_charge" ? { paymentScheduleId, billingCycleAt: "2038-02-01T19:00:00.000Z" } : {}), amountMinor: 500, currency: "USD", requestFingerprint: `lvpayreq:v1:${"0".repeat(64)}`, providerIdempotencyKey: `f1-refusal-${kind}`, providerName: "test", status: "pending" }).returning({ id: paymentOperations.id });
  if (kind === "scheduled_snapshot") {
    await db.insert(scheduledPaymentOperationSnapshots).values({ operationId: operation.id, snapshotFingerprint: `lvpayexec:v1:${"0".repeat(64)}`, leagueId: fixture.leagueId, locationId: fixture.locationId, requestKind: "direct", encryptedSourceId: "fixture-source" });
  } else if (kind === "interactive_snapshot") {
    await db.insert(interactivePaymentOperationSnapshots).values({ operationId: operation.id, snapshotFingerprint: `lvpayexecic:v2:${"0".repeat(64)}`, leagueId: fixture.leagueId, locationId: fixture.locationId, payerBowlerId: fixture.bowlers[0].id, requestKind: "direct", encryptedSourceId: "fixture-source", sourceKind: "new_card", weekOf: "2038-02-01T19:00:00.000Z" });
  } else if (kind === "refund_snapshot") {
    const [payment] = await db.insert(payments).values({ bowlerId: fixture.bowlers[0].id, leagueId: fixture.leagueId, amount: 500, weekOf: "2038-02-01T19:00:00.000Z", status: "paid", type: "cash" }).returning({ id: payments.id });
    await db.insert(refundPaymentOperationSnapshots).values({ operationId: operation.id, snapshotFingerprint: `lvpayexecrf:v1:${"0".repeat(64)}`, paymentId: payment.id, leagueId: fixture.leagueId, locationId: fixture.locationId, encryptedProviderPaymentId: "fixture-provider-payment", reason: "fixture", requestedByUserId: fixture.actorUserId, requestedByRole: "org_admin" });
  } else if (kind === "occurrence_snapshot") {
    await db.transaction(async (tx) => {
      await tx.insert(scheduledPaymentOperationSnapshots).values({ operationId: operation.id, snapshotFingerprint: `lvpayexec:v1:${"0".repeat(64)}`, leagueId: fixture.leagueId, locationId: fixture.locationId, requestKind: "direct", encryptedSourceId: "fixture-source" });
      const term = (await tx.select().from(leagueOccurrenceBillingTerms).where(and(eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId), eq(leagueOccurrenceBillingTerms.occurrenceId, occurrenceId))))[0];
      const [obligation] = await tx.insert(bowlerOccurrenceObligations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, occurrenceId, bowlerId: fixture.bowlers[0].id, purpose: "league_weekly_fee", amountMinor: 500, currency: "USD", dueAt: "2038-02-01T19:00:00.000Z", pastDueAt: "2038-02-01T22:00:00.000Z", billingTermId: term.id, billingTermVersion: term.version, recordedByUserId: fixture.actorUserId }).returning({ id: bowlerOccurrenceObligations.id });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: operation.id, organizationId: fixture.organizationId, leagueId: fixture.leagueId, snapshotFingerprint: `lvpayocc:v1:${"0".repeat(64)}`, amountMinor: 500, currency: "USD", allocationCount: 1 });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({ operationId: operation.id, allocationIndex: 0, organizationId: fixture.organizationId, leagueId: fixture.leagueId, snapshotVersion: 1, obligationId: obligation.id, occurrenceId, bowlerId: fixture.bowlers[0].id, amountMinor: 500, currency: "USD" });
    });
  }
}

afterEach(async () => { for (const organizationId of createdOrganizations.splice(0)) await deleteOrganization(organizationId).catch(() => undefined); });

async function recordAllocationRevision(allocationId: string, actorUserId: number) {
  const allocation = (await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.id, allocationId)))[0];
  await db.insert(paymentOccurrenceAllocationRevisions).values({ organizationId: allocation.organizationId, leagueId: allocation.leagueId, allocationId, revisionNumber: allocation.currentRevision, snapshotSchemaVersion: 1, afterSnapshot: { state: allocation.state, amountMinor: allocation.amountMinor, currency: allocation.currency, paymentId: allocation.paymentId, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId }, recordedByUserId: actorUserId });
}

async function recordObligationState(obligationId: string, state: "open" | "partially_settled" | "settled" | "voided", actorUserId: number) {
  const obligation = (await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, obligationId)))[0];
  const revisionNumber = obligation.currentRevision + 1;
  await db.update(bowlerOccurrenceObligations).set({ state, currentRevision: revisionNumber }).where(eq(bowlerOccurrenceObligations.id, obligationId));
  await db.insert(bowlerOccurrenceObligationRevisions).values({ organizationId: obligation.organizationId, leagueId: obligation.leagueId, obligationId, revisionNumber, snapshotSchemaVersion: 1, beforeSnapshot: { state: obligation.state, dueAt: obligation.dueAt, pastDueAt: obligation.pastDueAt }, afterSnapshot: { state, dueAt: obligation.dueAt, pastDueAt: obligation.pastDueAt }, recordedByUserId: actorUserId });
}

async function financialBoundaryCounts(fixture: Awaited<ReturnType<typeof operationalFixture>>) {
  const [activations, activationRevisions, responsibilities, eligibilities, eligibilityRevisions, assignments, assignmentRevisions, obligations, obligationRevisions, allocations, allocationRevisions, collectionPlans, collectionPlanItems, collectionPlanRevisions, operations, occurrenceSnapshots, occurrenceSnapshotAllocations, disputes, webhooks] = await Promise.all([
    db.select().from(financialActivations).where(eq(financialActivations.organizationId, fixture.organizationId)),
    db.select().from(financialActivationRevisions).where(eq(financialActivationRevisions.organizationId, fixture.organizationId)),
    db.select().from(financialResponsibilities).where(eq(financialResponsibilities.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceEligibilities).where(eq(bowlerOccurrenceEligibilities.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceEligibilityRevisions).where(eq(bowlerOccurrenceEligibilityRevisions.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceTeamAssignments).where(eq(bowlerOccurrenceTeamAssignments.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceTeamAssignmentRevisions).where(eq(bowlerOccurrenceTeamAssignmentRevisions.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId)),
    db.select().from(bowlerOccurrenceObligationRevisions).where(eq(bowlerOccurrenceObligationRevisions.organizationId, fixture.organizationId)),
    db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.organizationId, fixture.organizationId)),
    db.select().from(paymentOccurrenceAllocationRevisions).where(eq(paymentOccurrenceAllocationRevisions.organizationId, fixture.organizationId)),
    db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.organizationId, fixture.organizationId)),
    db.select().from(occurrenceCollectionPlanItems).where(eq(occurrenceCollectionPlanItems.organizationId, fixture.organizationId)),
    db.select().from(occurrenceCollectionPlanRevisions).where(eq(occurrenceCollectionPlanRevisions.organizationId, fixture.organizationId)),
    db.select().from(paymentOperations).where(eq(paymentOperations.organizationId, fixture.organizationId)),
    db.select().from(paymentOperationOccurrenceSnapshots).where(eq(paymentOperationOccurrenceSnapshots.organizationId, fixture.organizationId)),
    db.select().from(paymentOperationOccurrenceSnapshotAllocations).where(eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, fixture.organizationId)),
    db.select().from(paymentDisputes).where(eq(paymentDisputes.organizationId, fixture.organizationId)),
    db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, fixture.organizationId)),
  ]);
  const [leaguePayments, schedules, scheduledSnapshots, interactiveSnapshots, refundSnapshots] = await Promise.all([
    db.select().from(payments).where(eq(payments.leagueId, fixture.leagueId)),
    db.select().from(paymentSchedules).where(eq(paymentSchedules.leagueId, fixture.leagueId)),
    db.select().from(scheduledPaymentOperationSnapshots).where(eq(scheduledPaymentOperationSnapshots.leagueId, fixture.leagueId)),
    db.select().from(interactivePaymentOperationSnapshots).where(eq(interactivePaymentOperationSnapshots.leagueId, fixture.leagueId)),
    db.select().from(refundPaymentOperationSnapshots).where(eq(refundPaymentOperationSnapshots.leagueId, fixture.leagueId)),
  ]);
  return {
    activations: activations.length, activationRevisions: activationRevisions.length, responsibilities: responsibilities.length,
    eligibilities: eligibilities.length, eligibilityRevisions: eligibilityRevisions.length, assignments: assignments.length, assignmentRevisions: assignmentRevisions.length, obligations: obligations.length, obligationRevisions: obligationRevisions.length,
    allocations: allocations.length, allocationRevisions: allocationRevisions.length, collectionPlans: collectionPlans.length, collectionPlanItems: collectionPlanItems.length, collectionPlanRevisions: collectionPlanRevisions.length,
    payments: leaguePayments.length, schedules: schedules.length, operations: operations.length, scheduledSnapshots: scheduledSnapshots.length, interactiveSnapshots: interactiveSnapshots.length, refundSnapshots: refundSnapshots.length, occurrenceSnapshots: occurrenceSnapshots.length, occurrenceSnapshotAllocations: occurrenceSnapshotAllocations.length, disputes: disputes.length, webhooks: webhooks.length,
  };
}

describe("F1 successful canonical activation and durable retry", () => {
  it("activates weekly 3-slot operational rows across all six kinds and keeps cancelled/none excluded", async () => {
    const fixture = await operationalFixture("weekly", 3);
    const source = await getCanonicalActivationSource(fixture);
    const input = { ...fixture, commandKey: "weekly-activation", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 3 as const, responsibilities: selections(fixture, 3) };
    const result = await activateCanonicalFinancials(input);
    const retry = await activateCanonicalFinancials(input);
    expect(retry).toEqual(result);
    expect(result.obligationIds).toHaveLength(15);
    const activationRows = await db.select().from(financialActivations).where(eq(financialActivations.id, result.activationId));
    expect(activationRows[0]?.expectedGroupCount).toBe(5);
    expect(await db.select().from(financialActivationRevisions).where(eq(financialActivationRevisions.activationId, result.activationId))).toHaveLength(1);
    expect(await db.select().from(financialResponsibilities).where(eq(financialResponsibilities.activationId, result.activationId))).toHaveLength(15);
    expect(await db.select().from(paymentOperations).where(eq(paymentOperations.organizationId, fixture.organizationId))).toHaveLength(0);
    const beforeRead = await financialBoundaryCounts(fixture);
    const read = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, now: new Date("2038-02-02T23:00:00.000Z") });
    expect(read.mode).toBe("canonical");
    expect(read.rows).toHaveLength(15);
    expect(read.rows.every((row) => row.dueAt && row.pastDueAt)).toBe(true);
    const firstObligation = (await db.select({ dueAt: bowlerOccurrenceObligations.dueAt, pastDueAt: bowlerOccurrenceObligations.pastDueAt }).from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.occurrenceId, fixture.occurrences[0].id)))[0];
    expect(firstObligation).toMatchObject({
      dueAt: "2038-02-01 19:00:00+00",
      pastDueAt: "2038-02-01 22:00:00+00",
    });
    const afterRead = await financialBoundaryCounts(fixture);
    expect(afterRead).toEqual(beforeRead);
  });

  it("activates upfront 4-slot rows with one stable transaction due instant", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const input = { ...fixture, commandKey: "upfront-activation", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) };
    const result = await activateCanonicalFinancials(input);
    const activation = (await db.select().from(financialActivations).where(eq(financialActivations.id, result.activationId)))[0];
    const obligations = await db.select({ dueAt: bowlerOccurrenceObligations.dueAt, pastDueAt: bowlerOccurrenceObligations.pastDueAt }).from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId), eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId)));
    expect(activation?.upfrontDueAt).toBeTruthy();
    expect(obligations).toHaveLength(4);
    const upfrontDueAt = activation?.upfrontDueAt;
    if (!upfrontDueAt) throw new Error("upfront timing evidence is incomplete");
    const obligationTiming = obligations.map(({ dueAt, pastDueAt }) => {
      if (!dueAt || !pastDueAt) throw new Error("upfront timing evidence is incomplete");
      return { dueAt, pastDueAt };
    });
    expect(new Set(obligationTiming.map((row) => new Date(row.dueAt).getTime()))).toEqual(new Set([new Date(upfrontDueAt).getTime()]));
    expect(new Set(obligationTiming.map((row) => new Date(row.pastDueAt).getTime()))).toEqual(new Set([new Date(upfrontDueAt).getTime()]));
  });

  it("keeps activation, revision, and responsibility evidence immutable", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const result = await activateCanonicalFinancials({ ...fixture, commandKey: "immutable-evidence", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) });
    const revision = (await db.select().from(financialActivationRevisions).where(eq(financialActivationRevisions.activationId, result.activationId)))[0];
    const responsibility = (await db.select().from(financialResponsibilities).where(eq(financialResponsibilities.activationId, result.activationId)))[0];
    await expect(db.update(financialActivations).set({ commandKey: "tampered" }).where(eq(financialActivations.id, result.activationId))).rejects.toThrow();
    await expect(db.delete(financialActivationRevisions).where(eq(financialActivationRevisions.id, revision.id))).rejects.toThrow();
    await expect(db.delete(financialResponsibilities).where(eq(financialResponsibilities.id, responsibility.id))).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lv.allow_financial_teardown = 'on'`);
      await tx.update(financialActivations).set({ commandKey: "tampered-through-guc" }).where(eq(financialActivations.id, result.activationId));
    })).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE pg_database_owner`);
      await tx.update(financialActivations).set({ commandKey: "tampered-through-role" }).where(eq(financialActivations.id, result.activationId));
    })).rejects.toThrow();
    await expect(deleteOrganization(fixture.organizationId)).rejects.toMatchObject({ code: "FINANCIAL_ACTIVATION_RETENTION_REQUIRED" });
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const response = await apiDelete(`/api/organizations/${fixture.organizationId}`, adminSession);
    expect(response.status).toBe(409);
    expect(response.data.error?.code).toBe("FINANCIAL_ACTIVATION_RETENTION_REQUIRED");
  });

  it("rejects changed command semantics and concurrent competing keys without extra activation", async () => {
    const fixture = await operationalFixture("weekly", 3);
    const source = await getCanonicalActivationSource(fixture);
    const input = { ...fixture, commandKey: "race-a", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 3 as const, responsibilities: selections(fixture, 3) };
    const results = await Promise.allSettled([activateCanonicalFinancials(input), activateCanonicalFinancials({ ...input, commandKey: "race-b" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(activateCanonicalFinancials({ ...input, responsibilities: input.responsibilities.slice(0, -1) })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const [otherActor] = await db.insert(users).values({ email: `f1-other-actor-${Date.now()}@example.test`, password: "test", name: "F1 other actor", role: "org_admin", organizationId: fixture.organizationId }).returning({ id: users.id });
    await expect(activateCanonicalFinancials({ ...input, actorUserId: otherActor.id })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.select().from(financialActivations).where(and(eq(financialActivations.organizationId, fixture.organizationId), eq(financialActivations.leagueId, fixture.leagueId)))).toHaveLength(1);
  });

  it("serializes distinct F2 preparations against one obligation reservation", async () => {
    const fixture = await operationalFixture("upfront", 3);
    const source = await getCanonicalActivationSource(fixture);
    const f2ReservationCommand = ["f2", "reservation", "race"].join("-");
    await activateCanonicalFinancials({
      ...fixture,
      commandKey: f2ReservationCommand,
      sourceFingerprint: source.sourceFingerprint,
      payingLineupSize: 3 as const,
      responsibilities: selections(fixture, 3),
    });
    expect((await getCanonicalActivationSource(fixture)).sourceFingerprint).toBe(source.sourceFingerprint);
    const [obligation] = await db.select().from(bowlerOccurrenceObligations)
      .where(and(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId), eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId)));
    if (!obligation) throw new Error("F2 reservation obligation fixture is missing");
    const quote = await quoteInteractiveOccurrenceAllocations({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      allowedBowlerIds: [obligation.bowlerId],
    });
    const input = (requestKey: string) => ({
      organizationId: fixture.organizationId,
      authorizingUserId: fixture.actorUserId,
      requestKey,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      providerName: "square",
      leagueId: fixture.leagueId,
      locationId: fixture.locationId,
      providerLocationId: "f2-reservation-location",
      payerBowlerId: obligation.bowlerId,
      requestKind: "direct" as const,
      sourceId: `cnon:f2-race-${requestKey}`,
      customerId: null,
      buyerEmail: "f2-race@example.test",
      storeCard: false,
      sourceKind: "new_card" as const,
      weekOf: "2038-02-01T19:00:00.000Z",
      combined: false,
      allocations: [{ allocationIndex: 0, bowlerId: obligation.bowlerId, amountMinor: obligation.amountMinor, lineageAmountMinor: null, prizeFundAmountMinor: null, weekOf: "2038-02-01T19:00:00.000Z", notes: null, paidByUserId: fixture.actorUserId }],
      lineItems: [],
      occurrenceSelections: [{ obligationId: obligation.id, amountMinor: obligation.amountMinor }],
      occurrenceQuoteFingerprint: quote.fingerprint,
    });
    const results = await Promise.allSettled([
      prepareInteractivePaymentOperation(input("f2-race-request-a")),
      prepareInteractivePaymentOperation(input("f2-race-request-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(paymentOperationOccurrenceSnapshots)
      .where(eq(paymentOperationOccurrenceSnapshots.organizationId, fixture.organizationId))).toHaveLength(1);
    expect(await db.select().from(paymentOperationOccurrenceSnapshotAllocations)
      .where(eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, fixture.organizationId))).toHaveLength(1);
    expect(await db.select().from(paymentOperations)
      .where(eq(paymentOperations.organizationId, fixture.organizationId))).toHaveLength(1);
  });

  it("returns identical IDs for concurrent retries of the same command", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const input = { ...fixture, commandKey: "same-command-race", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) };
    const results = await Promise.all([activateCanonicalFinancials(input), activateCanonicalFinancials(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.select().from(financialActivations).where(and(eq(financialActivations.organizationId, fixture.organizationId), eq(financialActivations.leagueId, fixture.leagueId)))).toHaveLength(1);
  });

  it("rejects a stale source fingerprint before first activation", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    await db.update(leagueOccurrences).set({ startAt: "2038-03-01T19:00:00.000Z" }).where(eq(leagueOccurrences.id, fixture.occurrences[0].id));
    await expect(activateCanonicalFinancials({ ...fixture, commandKey: "stale-before-first", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) })).rejects.toMatchObject({ code: "stale_source" });
    expect(await db.select().from(financialActivations).where(eq(financialActivations.organizationId, fixture.organizationId))).toHaveLength(0);
  });

  it("includes completed occurrences and rejects a missing published term", async () => {
    const completedFixture = await operationalFixture("weekly", 3);
    await db.update(leagueOccurrences).set({ status: "completed", lifecycle: "locked", currentRevision: 2, lockedAt: "2038-01-01T00:00:00.000Z", lockedByUserId: completedFixture.actorUserId, lockReason: "F1 completed fixture", lockCommandId: completedFixture.scheduleCommandId, completedAt: "2038-02-01T23:00:00.000Z", completedByUserId: completedFixture.actorUserId, completionCommandId: completedFixture.scheduleCommandId }).where(eq(leagueOccurrences.id, completedFixture.occurrences[0].id));
    await db.insert(leagueOccurrenceRevisions).values({ organizationId: completedFixture.organizationId, leagueId: completedFixture.leagueId, occurrenceId: completedFixture.occurrences[0].id, commandId: completedFixture.scheduleCommandId, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: { status: "scheduled", lifecycle: "published" }, afterSnapshot: { status: "completed", lifecycle: "locked", kind: "regular", plannedOrdinal: 1 } });
    const completedSource = await getCanonicalActivationSource(completedFixture);
    const completedResult = await activateCanonicalFinancials({ ...completedFixture, commandKey: "completed-kind", sourceFingerprint: completedSource.sourceFingerprint, payingLineupSize: 3 as const, responsibilities: selections(completedFixture, 3) });
    expect(completedResult.obligationIds).toHaveLength(15);

    const missingFixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(missingFixture);
    await db.update(leagueOccurrenceBillingTerms).set({ state: "superseded", supersededAt: "2038-01-01T00:00:00.000Z", supersededByCommandId: missingFixture.scheduleCommandId }).where(and(eq(leagueOccurrenceBillingTerms.organizationId, missingFixture.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, missingFixture.leagueId), eq(leagueOccurrenceBillingTerms.occurrenceId, missingFixture.occurrences[0].id)));
    await expect(activateCanonicalFinancials({ ...missingFixture, commandKey: "missing-term", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(missingFixture, 4) })).rejects.toMatchObject({ code: "canonical_incomplete" });
  });

  it.each(["missing", "gapped", "mismatched"] as const)("rejects %s billing-term revision evidence", async (failure) => {
    const fixture = await operationalFixture("upfront", 4);
    await getCanonicalActivationSource(fixture);
    const [term] = await db.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId),
      eq(leagueOccurrenceBillingTerms.occurrenceId, fixture.occurrences[0].id),
    ));
    if (!term) throw new Error("billing term fixture is missing");
    if (failure === "missing") {
      await db.update(leagueOccurrenceBillingTerms).set({ currentRevision: 2 }).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    } else if (failure === "gapped") {
      await db.update(leagueOccurrenceBillingTerms).set({ currentRevision: 3 }).where(eq(leagueOccurrenceBillingTerms.id, term.id));
      const [revision] = await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
      if (!revision) throw new Error("billing term revision fixture is missing");
      await db.insert(leagueOccurrenceBillingTermRevisions).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, billingTermId: term.id, commandId: fixture.scheduleCommandId, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: revision.afterSnapshot, afterSnapshot: { ...(revision.afterSnapshot as Record<string, unknown>), currentRevision: 3 } });
    } else {
      await db.update(leagueOccurrenceBillingTermRevisions).set({ afterSnapshot: { id: term.id, organizationId: fixture.organizationId, leagueId: fixture.leagueId, occurrenceId: term.occurrenceId, purpose: term.purpose, obligationPolicy: term.obligationPolicy, defaultAmountMinor: 999, currency: term.currency, billingOrdinal: term.billingOrdinal, version: term.version, state: term.state, currentRevision: term.currentRevision, lastCommandId: term.lastCommandId } }).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
    }
    await expect(getCanonicalActivationSource(fixture)).rejects.toMatchObject({ code: "canonical_incomplete" });
  });

  it.each(["fall-draft-billing-term-revision/1", "completed-summer-billing-term-revision/1"] as const)("accepts the %s billing-term snapshot contract", async (snapshotContractVersion) => {
    const fixture = await operationalFixture("upfront", 4);
    const [term] = await db.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId),
      eq(leagueOccurrenceBillingTerms.occurrenceId, fixture.occurrences[0].id),
    ));
    if (!term) throw new Error("billing term fixture is missing");
    const [revision] = await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
    if (!revision) throw new Error("billing term revision fixture is missing");
    await db.update(leagueOccurrenceBillingTermRevisions).set({ afterSnapshot: {
      ...(revision.afterSnapshot as Record<string, unknown>),
      snapshotContractVersion,
      publishedAt: "2037-12-01T00:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: fixture.scheduleCommandId,
      supersededAt: null,
      supersededByCommandId: null,
    } }).where(eq(leagueOccurrenceBillingTermRevisions.id, revision.id));
    await expect(getCanonicalActivationSource(fixture)).resolves.toMatchObject({ expected: expect.any(Array), sourceFingerprint: expect.stringMatching(/^lvfinancialsource:v1:[0-9a-f]{64}$/) });
  });

  it("accepts a complete unversioned C2 billing-term snapshot", async () => {
    const fixture = await operationalFixture("upfront", 4);
    await expect(getCanonicalActivationSource(fixture)).resolves.toMatchObject({ expected: expect.any(Array) });
  });

  it("rejects an unversioned partial C2 billing-term snapshot", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const [term] = await db.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId),
      eq(leagueOccurrenceBillingTerms.occurrenceId, fixture.occurrences[0].id),
    ));
    if (!term) throw new Error("billing term fixture is missing");
    const [revision] = await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
    if (!revision) throw new Error("billing term revision fixture is missing");
    await db.update(leagueOccurrenceBillingTermRevisions).set({ afterSnapshot: {
      state: term.state,
      obligationPolicy: term.obligationPolicy,
      defaultAmountMinor: term.defaultAmountMinor,
    } }).where(eq(leagueOccurrenceBillingTermRevisions.id, revision.id));
    await expect(getCanonicalActivationSource(fixture)).rejects.toMatchObject({ code: "canonical_incomplete" });
  });

  it("rejects an unsupported billing-term snapshot contract version", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const [term] = await db.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId),
      eq(leagueOccurrenceBillingTerms.occurrenceId, fixture.occurrences[0].id),
    ));
    if (!term) throw new Error("billing term fixture is missing");
    const [revision] = await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
    if (!revision) throw new Error("billing term revision fixture is missing");
    await db.update(leagueOccurrenceBillingTermRevisions).set({ afterSnapshot: {
      ...(revision.afterSnapshot as Record<string, unknown>),
      snapshotContractVersion: "unsupported-billing-term-revision/99",
    } }).where(eq(leagueOccurrenceBillingTermRevisions.id, revision.id));
    await expect(getCanonicalActivationSource(fixture)).rejects.toMatchObject({ code: "canonical_incomplete" });
  });

  it("preserves the D2 effective lock and fails closed on source drift", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const result = await activateCanonicalFinancials({ ...fixture, commandKey: "source-drift", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) });
    const occurrenceId = fixture.occurrences[0].id;
    const cancelRequest = {
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      actorUserId: fixture.actorUserId,
      commandType: "cancel" as const,
      idempotencyKey: ["f1", "cancel", "after", "activation"].join("_"),
      requestFingerprint: "",
      occurrenceId,
      now: "2038-01-01T00:00:00.000Z",
      reason: "F1 effective-lock test",
    };
    const cancelled = await cancelOccurrence({ ...cancelRequest, requestFingerprint: buildCanonicalScheduleCommandFingerprint(cancelRequest) });
    expect(cancelled.status).toBe("cancelled");
    expect((await db.select({ currentRevision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(eq(leagueOccurrences.id, occurrenceId)))[0]?.currentRevision).toBe(2);
    expect((await db.select({ state: bowlerOccurrenceObligations.state }).from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.occurrenceId, occurrenceId))).every((obligation) => obligation.state === "voided")).toBe(true);
    expect(await db.select().from(financialActivationCancellationSuppressions).where(and(eq(financialActivationCancellationSuppressions.organizationId, fixture.organizationId), eq(financialActivationCancellationSuppressions.occurrenceId, occurrenceId)))).toHaveLength(1);
    const afterCancellation = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(afterCancellation.rows.filter((row) => row.occurrenceId === occurrenceId).every((row) => row.state === "voided")).toBe(true);
    await db.update(leagues).set({ paymentMode: "weekly" }).where(eq(leagues.id, fixture.leagueId));
    await expect(readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId })).rejects.toThrow();
    expect(result.activationId).toBeTruthy();
  });

  it("rolls back all rows when a selected member is invalid", async () => {
    const fixture = await operationalFixture("weekly", 3);
    const source = await getCanonicalActivationSource(fixture);
    const input = { ...fixture, commandKey: "rollback", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 3 as const, responsibilities: selections(fixture, 3).map((row, index) => index === 0 ? { ...row, bowlerId: 999999 } : row) };
    await expect(activateCanonicalFinancials(input)).rejects.toMatchObject({ code: "invalid_matrix" });
    expect(await db.select().from(financialActivations).where(eq(financialActivations.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(bowlerOccurrenceEligibilities).where(eq(bowlerOccurrenceEligibilities.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(bowlerOccurrenceTeamAssignments).where(eq(bowlerOccurrenceTeamAssignments.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(financialResponsibilities).where(eq(financialResponsibilities.organizationId, fixture.organizationId))).toHaveLength(0);
  });

  it.each(["payment_schedule", "collection_plan", "scheduled_snapshot", "interactive_snapshot", "refund_snapshot", "occurrence_snapshot", "eligibility"] as const)("refuses pristine activation over %s evidence", async (kind) => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    await insertPristineRefusalEvidence(fixture, kind);
    if (kind === "occurrence_snapshot") expect(await db.select().from(paymentOperationOccurrenceSnapshots).where(eq(paymentOperationOccurrenceSnapshots.organizationId, fixture.organizationId))).toHaveLength(1);
    await expect(activateCanonicalFinancials({ ...fixture, commandKey: `refusal-${kind}`, sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) })).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(await db.select().from(financialActivations).where(eq(financialActivations.organizationId, fixture.organizationId))).toHaveLength(0);
  });

  it("settles from explicit allocations and preserves refund/dispute review evidence", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const result = await activateCanonicalFinancials({ ...fixture, commandKey: "settlement", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) });
    const obligationId = result.obligationIds[0];
    const obligation = (await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, obligationId)))[0];
    const [payment] = await db.insert(payments).values({ bowlerId: obligation.bowlerId, leagueId: fixture.leagueId, amount: 500, weekOf: "2038-01-01T00:00:00.000Z", status: "paid", type: "cash" }).returning({ id: payments.id });
    const [settlementAllocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: payment.id, obligationId, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId, amountMinor: 500, currency: "USD", state: "active", allocationKey: "f1-settlement-1", recordedByUserId: fixture.actorUserId }).returning({ id: paymentOccurrenceAllocations.id });
    await recordAllocationRevision(settlementAllocation.id, fixture.actorUserId);
    await recordObligationState(obligationId, "settled", fixture.actorUserId);
    const settled = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(settled.rows.find((row) => row.obligationId === obligationId)).toMatchObject({ classification: "settled", outstandingMinor: 0, reviewRequired: false });
    await db.update(payments).set({ status: "refunded", refundedAt: "2038-01-02T00:00:00.000Z" }).where(eq(payments.id, payment.id));
    const refunded = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(refunded.rows.find((row) => row.obligationId === obligationId)).toMatchObject({ classification: "review_required", reviewRequired: true, reviewCategory: "refund", outstandingMinor: 0 });
    const partialObligationId = result.obligationIds[1];
    const partialObligation = (await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, partialObligationId)))[0];
    const [partialPayment] = await db.insert(payments).values({ bowlerId: partialObligation.bowlerId, leagueId: fixture.leagueId, amount: 200, weekOf: "2038-01-01T00:00:00.000Z", status: "paid", type: "cash" }).returning({ id: payments.id });
    const [partialAllocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: partialPayment.id, obligationId: partialObligationId, occurrenceId: partialObligation.occurrenceId, bowlerId: partialObligation.bowlerId, amountMinor: 200, currency: "USD", state: "active", allocationKey: "f1-settlement-partial", recordedByUserId: fixture.actorUserId }).returning({ id: paymentOccurrenceAllocations.id });
    await recordAllocationRevision(partialAllocation.id, fixture.actorUserId);
    await recordObligationState(partialObligationId, "partially_settled", fixture.actorUserId);
    const partial = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(partial.rows.find((row) => row.obligationId === partialObligationId)).toMatchObject({ classification: "past_due", outstandingMinor: 300, allocatedMinor: 200 });
    await db.update(payments).set({ status: "disputed", disputedAt: "2038-01-03T00:00:00.000Z", disputeId: "f1-dispute-evidence" }).where(eq(payments.id, partialPayment.id));
    const disputed = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(disputed.rows.find((row) => row.obligationId === partialObligationId)).toMatchObject({ classification: "review_required", reviewRequired: true, reviewCategory: "dispute", outstandingMinor: 300 });
    const pendingObligationId = result.obligationIds[3];
    const pendingObligation = (await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, pendingObligationId)))[0];
    const [pendingPayment] = await db.insert(payments).values({ bowlerId: pendingObligation.bowlerId, leagueId: fixture.leagueId, amount: 100, weekOf: "2038-01-01T00:00:00.000Z", status: "pending", type: "cash" }).returning({ id: payments.id });
    const [pendingAllocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: pendingPayment.id, obligationId: pendingObligationId, occurrenceId: pendingObligation.occurrenceId, bowlerId: pendingObligation.bowlerId, amountMinor: 100, currency: "USD", state: "active", allocationKey: "f1-settlement-pending", recordedByUserId: fixture.actorUserId }).returning({ id: paymentOccurrenceAllocations.id });
    await recordAllocationRevision(pendingAllocation.id, fixture.actorUserId);
    await recordObligationState(pendingObligationId, "partially_settled", fixture.actorUserId);
    await expect(readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId })).rejects.toThrow();
    await db.update(payments).set({ status: "paid" }).where(eq(payments.id, pendingPayment.id));
    const cleanVoidedId = result.obligationIds[2];
    await recordObligationState(cleanVoidedId, "voided", fixture.actorUserId);
    const cleanVoided = await readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId });
    expect(cleanVoided.rows.find((row) => row.obligationId === cleanVoidedId)).toMatchObject({ classification: "voided", outstandingMinor: 0, reviewRequired: false });
    await recordObligationState(obligationId, "voided", fixture.actorUserId);
    await expect(readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId })).rejects.toThrow();
  });

  it("fails closed for missing revisions and ignores an audited voided allocation", async () => {
    const fixture = await operationalFixture("upfront", 4);
    const source = await getCanonicalActivationSource(fixture);
    const result = await activateCanonicalFinancials({ ...fixture, commandKey: "revision-failure", sourceFingerprint: source.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(fixture, 4) });
    const firstObligationId = result.obligationIds[0];
    await db.delete(bowlerOccurrenceObligationRevisions).where(eq(bowlerOccurrenceObligationRevisions.obligationId, firstObligationId));
    await expect(readCanonicalDuePastDue({ organizationId: fixture.organizationId, leagueId: fixture.leagueId })).rejects.toThrow();

    const cleanFixture = await operationalFixture("upfront", 4);
    const [nonResponsibleBowler] = await db.insert(bowlers).values({ name: "F1 nonpayer", organizationId: cleanFixture.organizationId, active: true }).returning({ id: bowlers.id });
    if (!nonResponsibleBowler) throw new Error("non-responsible bowler fixture failed");
    await db.insert(bowlerLeagues).values({ bowlerId: nonResponsibleBowler.id, leagueId: cleanFixture.leagueId, teamId: cleanFixture.teamId, active: true });
    const cleanSource = await getCanonicalActivationSource(cleanFixture);
    const cleanResult = await activateCanonicalFinancials({ ...cleanFixture, commandKey: "revision-allocation", sourceFingerprint: cleanSource.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(cleanFixture, 4) });
    const obligation = (await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, cleanResult.obligationIds[0])))[0];
    const [payment] = await db.insert(payments).values({ bowlerId: obligation.bowlerId, leagueId: cleanFixture.leagueId, amount: 100, weekOf: "2038-01-01T00:00:00.000Z", status: "paid", type: "cash" }).returning({ id: payments.id });
    const [allocation] = await db.insert(paymentOccurrenceAllocations).values({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId, paymentId: payment.id, obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId, amountMinor: 100, currency: "USD", state: "active", allocationKey: "f1-revision-missing", recordedByUserId: cleanFixture.actorUserId }).returning({ id: paymentOccurrenceAllocations.id });
    await expect(readCanonicalDuePastDue({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId })).rejects.toThrow();
    await recordAllocationRevision(allocation.id, cleanFixture.actorUserId);
    await db.update(paymentOccurrenceAllocations).set({ state: "voided", currentRevision: 2 }).where(eq(paymentOccurrenceAllocations.id, allocation.id));
    await expect(readCanonicalDuePastDue({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId })).rejects.toThrow();
    await db.insert(paymentOccurrenceAllocationRevisions).values({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId, allocationId: allocation.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: { state: "active", amountMinor: 100, currency: "USD", paymentId: payment.id, obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId }, afterSnapshot: { state: "voided", amountMinor: 100, currency: "USD", paymentId: payment.id, obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId: obligation.bowlerId }, recordedByUserId: cleanFixture.actorUserId });
    const auditedVoid = await readCanonicalDuePastDue({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId });
    expect(auditedVoid.rows.find((row) => row.obligationId === obligation.id)?.allocatedMinor).toBe(0);
    const empty = await readCanonicalDuePastDue({ organizationId: cleanFixture.organizationId, leagueId: cleanFixture.leagueId, bowlerId: nonResponsibleBowler.id });
    expect(empty.mode).toBe("canonical");
    expect(empty.rows).toHaveLength(0);
  });

  it("fails closed for gapped and mismatched latest obligation revisions", async () => {
    const mismatchFixture = await operationalFixture("upfront", 4);
    const mismatchSource = await getCanonicalActivationSource(mismatchFixture);
    const mismatchResult = await activateCanonicalFinancials({ ...mismatchFixture, commandKey: "revision-mismatch", sourceFingerprint: mismatchSource.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(mismatchFixture, 4) });
    const mismatchObligationId = mismatchResult.obligationIds[0];
    await db.update(bowlerOccurrenceObligationRevisions).set({ afterSnapshot: { state: "settled", dueAt: "2038-01-01T00:00:00.000Z", pastDueAt: "2038-01-01T00:00:00.000Z" } }).where(eq(bowlerOccurrenceObligationRevisions.obligationId, mismatchObligationId));
    await expect(readCanonicalDuePastDue({ organizationId: mismatchFixture.organizationId, leagueId: mismatchFixture.leagueId })).rejects.toThrow();

    const gappedFixture = await operationalFixture("upfront", 4);
    const gappedSource = await getCanonicalActivationSource(gappedFixture);
    const gappedResult = await activateCanonicalFinancials({ ...gappedFixture, commandKey: "revision-gapped", sourceFingerprint: gappedSource.sourceFingerprint, payingLineupSize: 4 as const, responsibilities: selections(gappedFixture, 4) });
    const gappedObligationId = gappedResult.obligationIds[0];
    await db.update(bowlerOccurrenceObligations).set({ currentRevision: 2 }).where(eq(bowlerOccurrenceObligations.id, gappedObligationId));
    await expect(readCanonicalDuePastDue({ organizationId: gappedFixture.organizationId, leagueId: gappedFixture.leagueId })).rejects.toThrow();
  });
});
