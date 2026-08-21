import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceEligibilityRevisions,
  bowlerOccurrenceObligations,
  bowlerOccurrenceObligationRevisions,
  bowlerOccurrenceTeamAssignments,
  bowlerOccurrenceTeamAssignmentRevisions,
  bowlers,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationSnapshots,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlanRevisions,
  occurrenceCollectionPlans,
  organizations,
  paymentOccurrenceAllocationRevisions,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperationOccurrenceSnapshots,
  paymentOperations,
  payments,
  teams,
  users,
  financialActivations,
} from "@shared/schema";
import {
  buildCanonicalScheduleCommandFingerprint,
  cancelOccurrence,
  rescheduleOccurrence,
  type CanonicalScheduleCommandFingerprintRequest,
} from "../../server/services/canonical-occurrence-transactions";
import {
  PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
  fingerprintPaymentOperationOccurrenceSnapshot,
  type PaymentOperationOccurrenceSnapshotV1,
} from "../../server/services/payment-operation-occurrence-snapshot";
import {
  getInteractiveOccurrenceActivation,
  InteractiveOccurrenceAllocationError,
  persistInteractiveOccurrenceSnapshot,
  validateInteractiveOccurrenceReplay,
} from "../../server/services/interactive-occurrence-allocation";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  PaymentOperationImmutableMismatchError,
  acquirePaymentOperationLease,
  finalizePaymentOperationSuccess,
} from "../../server/storage/payment-operations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

interface Fixture {
  organizationId: number;
  actorUserId: number;
  locationId: number;
  leagueId: number;
  otherLeagueId: number;
  teamId: number;
  secondTeamId: number;
  otherLeagueTeamId: number;
  bowlerId: number;
  occurrenceIds: [string, string, string];
  billingTermIds: [string, string, string];
}

let fixture: Fixture | undefined;
let foreignFixture: Fixture | undefined;

function withFingerprint<T extends CanonicalScheduleCommandFingerprintRequest>(
  request: T,
): Omit<T, "requestFingerprint"> & { requestFingerprint: string } {
  return { ...request, requestFingerprint: buildCanonicalScheduleCommandFingerprint(request) };
}

async function expectDatabaseConstraint(
  action: Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (!(error instanceof Error) || !(error.cause instanceof Error)) throw error;
    expect(error.cause.message).toMatch(expectedMessage);
    return;
  }
  throw new Error(`expected PostgreSQL constraint rejection matching ${expectedMessage}`);
}

async function createFixture(label: string): Promise<Fixture> {
  const key = `${label.toLowerCase()}-${suffix}`;
  const [organization] = await db.insert(organizations).values({
    name: `D2 ${label}`,
    slug: `d2-${key}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("D2 organization was not created");
  const [actor] = await db.insert(users).values({
    email: `d2-${key}@example.test`,
    password: "d2-test-password-hash",
    name: `D2 ${label} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  const [location] = await db.insert(locations).values({
    name: `D2 ${label} location`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!actor || !location) throw new Error("D2 actor/location was not created");
  const leagueValues = {
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2038-01-01",
    seasonEnd: "2038-12-31",
    weekDay: "Sunday" as const,
    timezone: "America/New_York",
    competitionStartTime: "19:00",
    totalBowlingWeeks: 12,
    paymentMode: "upfront" as const,
    weeklyFee: 500,
  };
  const [league] = await db.insert(leagues).values({
    ...leagueValues,
    name: `D2 ${label} league`,
  }).returning({ id: leagues.id });
  const [otherLeague] = await db.insert(leagues).values({
    ...leagueValues,
    name: `D2 ${label} other league`,
  }).returning({ id: leagues.id });
  if (!league || !otherLeague) throw new Error("D2 leagues were not created");
  const [team, secondTeam, otherLeagueTeam] = await db.insert(teams).values([
    { name: `D2 ${label} team one`, number: 1, leagueId: league.id },
    { name: `D2 ${label} team two`, number: 2, leagueId: league.id },
    { name: `D2 ${label} foreign league team`, number: 1, leagueId: otherLeague.id },
  ]).returning({ id: teams.id, leagueId: teams.leagueId });
  const [bowler] = await db.insert(bowlers).values({
    name: `D2 ${label} bowler`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  if (!team || !secondTeam || !otherLeagueTeam || !bowler) {
    throw new Error("D2 teams/bowler were not created");
  }
  const occurrenceRows = await db.insert(leagueOccurrences).values([
    { date: "2038-02-07", startAt: "2038-02-08T00:00:00.000Z", ordinal: 1 },
    { date: "2038-02-14", startAt: "2038-02-15T00:00:00.000Z", ordinal: 2 },
    { date: "2038-02-21", startAt: "2038-02-22T00:00:00.000Z", ordinal: 3 },
  ].map((row) => ({
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    generationKey: `d2-${key}-occurrence-${row.ordinal}`,
    kind: "regular" as const,
    status: "scheduled" as const,
    lifecycle: "draft" as const,
    authoritativeLocalDate: row.date,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/New_York",
    startAt: row.startAt,
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous" as const,
    resolverVersion: "d2-test-resolver/1",
    plannedOrdinal: row.ordinal,
    competitionNumber: row.ordinal,
  }))).returning({ id: leagueOccurrences.id });
  if (occurrenceRows.length !== 3) throw new Error("D2 occurrences were not created");
  const termRows = await db.insert(leagueOccurrenceBillingTerms).values(
    occurrenceRows.map((occurrence, index) => ({
      organizationId: organization.id,
      leagueId: league.id,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee" as const,
      obligationPolicy: "eligible_bowlers" as const,
      defaultAmountMinor: 500,
      currency: "USD",
      billingOrdinal: index + 1,
      version: 1,
    })),
  ).returning({ id: leagueOccurrenceBillingTerms.id });
  if (termRows.length !== 3) throw new Error("D2 billing terms were not created");
  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    locationId: location.id,
    leagueId: league.id,
    otherLeagueId: otherLeague.id,
    teamId: team.id,
    secondTeamId: secondTeam.id,
    otherLeagueTeamId: otherLeagueTeam.id,
    bowlerId: bowler.id,
    occurrenceIds: [occurrenceRows[0].id, occurrenceRows[1].id, occurrenceRows[2].id],
    billingTermIds: [termRows[0].id, termRows[1].id, termRows[2].id],
  };
}

async function insertObligation(scope: Fixture, occurrenceIndex: number, amountMinor = 500) {
  const [row] = await db.insert(bowlerOccurrenceObligations).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    occurrenceId: scope.occurrenceIds[occurrenceIndex],
    bowlerId: scope.bowlerId,
    purpose: "league_weekly_fee",
    amountMinor,
    currency: "USD",
    billingTermId: scope.billingTermIds[occurrenceIndex],
    billingTermVersion: 1,
    recordedByUserId: scope.actorUserId,
  }).returning();
  if (!row) throw new Error("D2 obligation was not created");
  await db.insert(bowlerOccurrenceObligationRevisions).values({
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    obligationId: row.id,
    revisionNumber: 1,
    snapshotSchemaVersion: 1,
    afterSnapshot: { amountMinor, currency: "USD", state: "open" },
    recordedByUserId: scope.actorUserId,
  });
  return row;
}

beforeAll(async () => {
  fixture = await createFixture("Foundation");
  foreignFixture = await createFixture("Foreign");
});

afterAll(async () => {
  for (const scope of [fixture, foreignFixture]) {
    if (scope) await deleteOrganization(scope.organizationId).catch(() => undefined);
  }
});

describe("D2 occurrence financial foundation PostgreSQL contract", () => {
  it("keeps eligibility independent from team assignment and obligation with tenant-proven revisions", async () => {
    const scope = fixture;
    const foreign = foreignFixture;
    if (!scope || !foreign) throw new Error("D2 fixtures are missing");
    const [eligibility] = await db.insert(bowlerOccurrenceEligibilities).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceIds[0],
      bowlerId: scope.bowlerId,
      state: "eligible",
      reason: "Explicit D2 participation decision",
      recordedByUserId: scope.actorUserId,
    }).returning();
    if (!eligibility) throw new Error("D2 eligibility was not created");
    await db.insert(bowlerOccurrenceEligibilityRevisions).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      eligibilityId: eligibility.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "eligible" },
      recordedByUserId: scope.actorUserId,
    });
    expect(await db.select().from(bowlerOccurrenceTeamAssignments).where(and(
      eq(bowlerOccurrenceTeamAssignments.organizationId, scope.organizationId),
      eq(bowlerOccurrenceTeamAssignments.occurrenceId, scope.occurrenceIds[0]),
    ))).toEqual([]);
    expect(await db.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, scope.organizationId),
      eq(bowlerOccurrenceObligations.occurrenceId, scope.occurrenceIds[0]),
    ))).toEqual([]);

    const [assignment] = await db.insert(bowlerOccurrenceTeamAssignments).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceIds[0],
      bowlerId: scope.bowlerId,
      teamId: scope.teamId,
      state: "assigned",
      reason: "Explicit D2 occurrence assignment",
      recordedByUserId: scope.actorUserId,
    }).returning();
    if (!assignment) throw new Error("D2 team assignment was not created");
    await db.insert(bowlerOccurrenceTeamAssignmentRevisions).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      assignmentId: assignment.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { teamId: scope.teamId, state: "assigned" },
      recordedByUserId: scope.actorUserId,
    });
    await db.update(bowlerOccurrenceTeamAssignments).set({
      teamId: scope.secondTeamId,
      currentRevision: 2,
      reason: "Audited reassignment for this occurrence only",
    }).where(eq(bowlerOccurrenceTeamAssignments.id, assignment.id));
    await db.insert(bowlerOccurrenceTeamAssignmentRevisions).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      assignmentId: assignment.id,
      revisionNumber: 2,
      snapshotSchemaVersion: 1,
      beforeSnapshot: { teamId: scope.teamId, state: "assigned" },
      afterSnapshot: { teamId: scope.secondTeamId, state: "assigned" },
      recordedByUserId: scope.actorUserId,
    });
    const revisions = await db.select().from(bowlerOccurrenceTeamAssignmentRevisions)
      .where(eq(bowlerOccurrenceTeamAssignmentRevisions.assignmentId, assignment.id));
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.afterSnapshot).toMatchObject({ teamId: scope.teamId });

    await expect(db.insert(bowlerOccurrenceEligibilities).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceIds[1],
      bowlerId: foreign.bowlerId,
      state: "eligible",
      reason: "Cross-tenant attempt",
      recordedByUserId: scope.actorUserId,
    })).rejects.toThrow();
    await expect(db.insert(bowlerOccurrenceTeamAssignments).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceIds[1],
      bowlerId: scope.bowlerId,
      teamId: scope.otherLeagueTeamId,
      state: "assigned",
      reason: "Cross-league attempt",
      recordedByUserId: scope.actorUserId,
    })).rejects.toThrow();
  });

  it("distinguishes zero-evidence legacy fallback from partial canonical evidence", async () => {
    const scope = fixture;
    if (!scope) throw new Error("D2 fixture is missing");
    // The fixture's other league has no D2 rows and remains an exact legacy
    // fallback; the primary league now has partial D2 rows but no F1 activation.
    expect(await getInteractiveOccurrenceActivation({
      organizationId: scope.organizationId,
      leagueId: scope.otherLeagueId,
    })).toBe(false);
    await expect(getInteractiveOccurrenceActivation({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
    })).rejects.toBeInstanceOf(InteractiveOccurrenceAllocationError);
  });

  it("finalizes a partial occurrence allocation once, advances an auditable revision, and replays idempotently", async () => {
    const scope = await createFixture("F2Finalize");
    const obligation = await insertObligation(scope, 0, 1_000);
    const [operation] = await db.insert(paymentOperations).values({
      organizationId: scope.organizationId,
      authorizingUserId: scope.actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:f2-finalize-${suffix}`,
      amountMinor: 400,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
      providerIdempotencyKey: `f2-finalize-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning();
    if (!operation) throw new Error("F2 finalization operation was not created");
    const leased = await acquirePaymentOperationLease({
      organizationId: scope.organizationId,
      operationId: operation.id,
      leaseOwner: "f2-finalizer-test",
      leaseDurationMs: 60_000,
    });
    if (!leased?.leaseToken) throw new Error("F2 finalization lease was not acquired");
    const firstOccurrenceSnapshot: PaymentOperationOccurrenceSnapshotV1 = {
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: 1,
      operationId: operation.id,
      operationType: "interactive_charge",
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 400,
      currency: "USD",
      allocations: [{
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId: obligation.occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 400,
        currency: "USD",
      }],
    };
    await db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({
        operationId: operation.id,
        snapshotVersion: 2,
        snapshotFingerprint: `lvpayexecic:v2:${"f".repeat(64)}`,
        leagueId: scope.leagueId,
        locationId: scope.locationId,
        payerBowlerId: scope.bowlerId,
        requestKind: "direct",
        encryptedSourceId: "F2_FINALIZE_SOURCE",
        storeCard: false,
        sourceKind: "new_card",
        weekOf: "2038-01-01T00:00:00.000Z",
      });
      await tx.insert(interactivePaymentOperationAllocations).values({
        operationId: operation.id,
        allocationIndex: 0,
        bowlerId: scope.bowlerId,
        amountMinor: 400,
        weekOf: "2038-01-01T00:00:00.000Z",
      });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: operation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(firstOccurrenceSnapshot),
        amountMinor: 400,
        currency: "USD",
        allocationCount: 1,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({
        operationId: operation.id,
        snapshotVersion: 1,
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId: obligation.occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 400,
        currency: "USD",
      });
    });
    const input = {
      organizationId: scope.organizationId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: `sq-f2-finalize-${suffix}`,
      paymentRows: [{
        allocationIndex: 0,
        values: {
          bowlerId: scope.bowlerId,
          leagueId: scope.leagueId,
          amount: 400,
          weekOf: "2038-01-01T00:00:00.000Z",
          status: "paid" as const,
          type: "square" as const,
          providerPaymentId: `sq-f2-finalize-${suffix}`,
        },
      }],
    };
    await db.update(paymentOperationOccurrenceSnapshots).set({
      snapshotFingerprint: `lvpayocc:v1:${"8".repeat(64)}`,
    }).where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id));
    await expect(finalizePaymentOperationSuccess(input)).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
    expect(await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.allocationKey, `payment-operation:${operation.id}:0`))).toHaveLength(0);
    await db.update(paymentOperationOccurrenceSnapshots).set({
      snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(firstOccurrenceSnapshot),
    }).where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id));
    await finalizePaymentOperationSuccess(input);
    await finalizePaymentOperationSuccess(input);
    const allocations = await db.select().from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.allocationKey, `payment-operation:${operation.id}:0`));
    const revisions = await db.select().from(paymentOccurrenceAllocationRevisions)
      .where(eq(paymentOccurrenceAllocationRevisions.organizationId, scope.organizationId));
    const [after] = await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, obligation.id));
    expect(allocations).toHaveLength(1);
    expect(revisions.filter((row) => row.allocationId === allocations[0]?.id)).toHaveLength(1);
    expect(after?.state).toBe("partially_settled");
    expect(after?.currentRevision).toBe(2);

    // The remaining amount must settle through the same common finalizer,
    // producing one contiguous allocation/revision pair and preserving the
    // F1-readable obligation state rather than creating a replacement row.
    const [secondOperation] = await db.insert(paymentOperations).values({
      organizationId: scope.organizationId,
      authorizingUserId: scope.actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:f2-finalize-second-${suffix}`,
      amountMinor: 600,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"b".repeat(64)}`,
      providerIdempotencyKey: `f2-finalize-second-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning();
    if (!secondOperation) throw new Error("second F2 finalization operation was not created");
    const secondLease = await acquirePaymentOperationLease({
      organizationId: scope.organizationId,
      operationId: secondOperation.id,
      leaseOwner: "f2-finalizer-test-second",
      leaseDurationMs: 60_000,
    });
    if (!secondLease?.leaseToken) throw new Error("second F2 finalization lease was not acquired");
    const secondOccurrenceSnapshot: PaymentOperationOccurrenceSnapshotV1 = {
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: 1,
      operationId: secondOperation.id,
      operationType: "interactive_charge",
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 600,
      currency: "USD",
      allocations: [{
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId: obligation.occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 600,
        currency: "USD",
      }],
    };
    await db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({
        operationId: secondOperation.id,
        snapshotVersion: 2,
        snapshotFingerprint: `lvpayexecic:v2:${"e".repeat(64)}`,
        leagueId: scope.leagueId,
        locationId: scope.locationId,
        payerBowlerId: scope.bowlerId,
        requestKind: "direct",
        encryptedSourceId: "F2_FINALIZE_SOURCE_2",
        storeCard: false,
        sourceKind: "new_card",
        weekOf: "2038-01-01T00:00:00.000Z",
      });
      await tx.insert(interactivePaymentOperationAllocations).values({
        operationId: secondOperation.id,
        allocationIndex: 0,
        bowlerId: scope.bowlerId,
        amountMinor: 600,
        weekOf: "2038-01-01T00:00:00.000Z",
      });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: secondOperation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(secondOccurrenceSnapshot),
        amountMinor: 600,
        currency: "USD",
        allocationCount: 1,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({
        operationId: secondOperation.id,
        snapshotVersion: 1,
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId: obligation.occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 600,
        currency: "USD",
      });
    });
    const secondInput = {
      organizationId: scope.organizationId,
      operationId: secondOperation.id,
      leaseToken: secondLease.leaseToken,
      providerObjectId: `sq-f2-finalize-second-${suffix}`,
      paymentRows: [{
        allocationIndex: 0,
        values: {
          bowlerId: scope.bowlerId,
          leagueId: scope.leagueId,
          amount: 600,
          weekOf: "2038-01-01T00:00:00.000Z",
          status: "paid" as const,
          type: "square" as const,
          providerPaymentId: `sq-f2-finalize-second-${suffix}`,
        },
      }],
    };
    await finalizePaymentOperationSuccess(secondInput);
    await finalizePaymentOperationSuccess(secondInput);
    const allAllocations = await db.select().from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.obligationId, obligation.id));
    const allRevisions = await db.select().from(paymentOccurrenceAllocationRevisions)
      .where(eq(paymentOccurrenceAllocationRevisions.organizationId, scope.organizationId));
    const [fullySettled] = await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, obligation.id));
    expect(allAllocations).toHaveLength(2);
    expect(allRevisions.filter((row) => allAllocations.some((allocation) => allocation.id === row.allocationId))).toHaveLength(2);
    expect(allAllocations.map((row) => row.currentRevision).sort()).toEqual([1, 1]);
    expect(fullySettled?.state).toBe("settled");
    expect(fullySettled?.currentRevision).toBe(3);
    await expect(validateInteractiveOccurrenceReplay({
      operationId: operation.id,
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 400,
      currency: "USD",
      selections: [{ obligationId: obligation.id, amountMinor: 400 }],
    })).resolves.toBeUndefined();
    await expect(validateInteractiveOccurrenceReplay({
      operationId: operation.id,
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 400,
      currency: "USD",
      selections: [{ obligationId: obligation.id, amountMinor: 399 }],
    })).rejects.toMatchObject({ code: "IMMUTABLE_SELECTION_MISMATCH" });
    await db.update(paymentOperationOccurrenceSnapshots).set({
      snapshotFingerprint: `lvpayocc:v1:${"9".repeat(64)}`,
    }).where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id));
    await expect(validateInteractiveOccurrenceReplay({
      operationId: operation.id,
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 400,
      currency: "USD",
      selections: [{ obligationId: obligation.id, amountMinor: 400 }],
    })).rejects.toMatchObject({ code: "CANONICAL_EVIDENCE_INCOMPATIBLE" });
    await deleteOrganization(scope.organizationId);
  });

  it("retains provider identity and payment evidence when cancellation wins after an interactive claim", async () => {
    const scope = await createFixture("F2CancelClaim");
    const occurrenceId = scope.occurrenceIds[0];
    const testNow = "2038-01-01T00:00:00.000Z";
    const [publishCommand] = await db.insert(leagueScheduleCommands).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      actorUserId: scope.actorUserId,
      commandType: "publish",
      reason: "F2 claim/cancel race fixture",
      idempotencyKey: `f2-cancel-publish-${suffix}-${Date.now()}`,
      requestFingerprint: `lvf2publish:${"a".repeat(56)}`,
    }).returning({ id: leagueScheduleCommands.id });
    if (!publishCommand) throw new Error("F2 publish command was not created");
    // The fixture rows are intentionally draft. Publish through a valid
    // command identity before exercising the cancellation/dispatch race.
    const [occurrence] = await db.update(leagueOccurrences).set({
      lifecycle: "published",
      plannedOrdinal: 1,
      competitionNumber: 1,
      competitive: true,
      countsInStandings: true,
      publishedAt: testNow,
      publishedByUserId: scope.actorUserId,
      publicationCommandId: publishCommand.id,
    }).where(eq(leagueOccurrences.id, occurrenceId)).returning();
    if (!occurrence) throw new Error("F2 cancellation occurrence was not created");
    const obligation = await insertObligation(scope, 0, 1_000);
    const [operation] = await db.insert(paymentOperations).values({
      organizationId: scope.organizationId,
      authorizingUserId: scope.actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:f2-cancel-claim-${suffix}`,
      amountMinor: 400,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"c".repeat(64)}`,
      providerIdempotencyKey: `f2-cancel-claim-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning();
    if (!operation) throw new Error("F2 cancellation operation was not created");
    const leased = await acquirePaymentOperationLease({
      organizationId: scope.organizationId,
      operationId: operation.id,
      leaseOwner: "f2-cancel-claim",
      leaseDurationMs: 60_000,
      now: new Date(testNow),
    });
    if (!leased?.leaseToken) throw new Error("F2 cancellation lease was not acquired");
    const snapshot: PaymentOperationOccurrenceSnapshotV1 = {
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: 1,
      operationId: operation.id,
      operationType: "interactive_charge",
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      amountMinor: 400,
      currency: "USD",
      allocations: [{
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 400,
        currency: "USD",
      }],
    };
    await db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({
        operationId: operation.id,
        snapshotVersion: 2,
        snapshotFingerprint: `lvpayexecic:v2:${"d".repeat(64)}`,
        leagueId: scope.leagueId,
        locationId: scope.locationId,
        payerBowlerId: scope.bowlerId,
        requestKind: "direct",
        encryptedSourceId: "F2_CANCEL_SOURCE",
        storeCard: false,
        sourceKind: "new_card",
        weekOf: testNow,
      });
      await tx.insert(interactivePaymentOperationAllocations).values({
        operationId: operation.id,
        allocationIndex: 0,
        bowlerId: scope.bowlerId,
        amountMinor: 400,
        weekOf: testNow,
      });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: operation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(snapshot),
        amountMinor: 400,
        currency: "USD",
        allocationCount: 1,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values({
        operationId: operation.id,
        snapshotVersion: 1,
        allocationIndex: 0,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 400,
        currency: "USD",
      });
    });
    await cancelOccurrence(withFingerprint({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      actorUserId: scope.actorUserId,
      commandType: "cancel" as const,
      idempotencyKey: `f2-cancel-claim-${suffix}`,
      requestFingerprint: "",
      reason: "Cancel the physical session after provider claim",
      occurrenceId,
      now: testNow,
    }));
    const [retainedLease] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    expect(retainedLease).toMatchObject({ status: "leased", dispatchClaimedAt: null, providerObjectId: null });
    await finalizePaymentOperationSuccess({
      organizationId: scope.organizationId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "f2-cancel-provider",
      providerOrderId: "f2-cancel-order",
      paymentRows: [{
        allocationIndex: 0,
        values: {
          bowlerId: scope.bowlerId,
          leagueId: scope.leagueId,
          amount: 400,
          weekOf: testNow,
          status: "paid",
          type: "square",
          providerPaymentId: "f2-cancel-provider",
        },
      }],
      now: new Date(testNow),
    });
    const [after] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    const linkedPayments = await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id));
    const allocations = await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.obligationId, obligation.id));
    const [voided] = await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.id, obligation.id));
    expect(after).toMatchObject({ status: "reconciliation_required", providerObjectId: "f2-cancel-provider", providerOrderId: "f2-cancel-order" });
    expect(linkedPayments).toHaveLength(1);
    expect(allocations).toHaveLength(0);
    expect(voided?.state).toBe("voided");
    await deleteOrganization(scope.organizationId);
  });

  it("never retrofits a pre-F2 interactive operation with an occurrence supplement", async () => {
    const scope = await createFixture("PreF2");
    const [operation] = await db.insert(paymentOperations).values({
      organizationId: scope.organizationId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:pre-f2-${suffix}`,
      amountMinor: 500,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
      providerIdempotencyKey: `pre-f2-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning();
    if (!operation) throw new Error("pre-F2 operation was not created");
    const selection = { obligationId: "11111111-1111-4111-8111-111111111111", amountMinor: 500 };
    await expect(db.transaction((tx) => persistInteractiveOccurrenceSnapshot(tx, operation, {
      leagueId: scope.leagueId,
      selections: [selection],
      quoteFingerprint: `lvpayquote:v1:${"q".repeat(64)}`,
    }))).rejects.toMatchObject({ code: "PRE_F2_OPERATION" });
    expect(await db.select().from(paymentOperationOccurrenceSnapshots)
      .where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id))).toEqual([]);
    expect(await db.select().from(paymentOperationOccurrenceSnapshotAllocations)
      .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id))).toEqual([]);
    await deleteOrganization(scope.organizationId);
  });

  it("creates authoritative prepaid obligations before occurrence time without rewriting amount evidence", async () => {
    const scope = fixture;
    if (!scope) throw new Error("D2 fixture is missing");
    const obligation = await insertObligation(scope, 0);
    expect(new Date(obligation.createdAt).getTime()).toBeLessThan(new Date("2038-02-08T00:00:00.000Z").getTime());
    await expect(insertObligation(scope, 0)).rejects.toThrow();
    await expect(db.insert(bowlerOccurrenceObligations).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      occurrenceId: scope.occurrenceIds[1],
      bowlerId: scope.bowlerId,
      purpose: "league_weekly_fee",
      amountMinor: 0,
      currency: "usd",
      recordedByUserId: scope.actorUserId,
    })).rejects.toThrow();
    await expect(db.update(bowlerOccurrenceObligations).set({ amountMinor: 1 })
      .where(eq(bowlerOccurrenceObligations.id, obligation.id))).rejects.toThrow();
    const [after] = await db.select().from(bowlerOccurrenceObligations)
      .where(eq(bowlerOccurrenceObligations.id, obligation.id));
    expect(after?.amountMinor).toBe(500);

    await expect(rescheduleOccurrence(withFingerprint({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      actorUserId: scope.actorUserId,
      commandType: "reschedule",
      reason: "D2 effective-lock regression proof",
      idempotencyKey: `d2-effective-lock-${suffix}`,
      requestFingerprint: "",
      occurrenceId: scope.occurrenceIds[0],
      now: "2037-01-01T00:00:00.000Z",
      authoritativeLocalDate: "2038-02-08",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "America/New_York",
      ambiguousFold: "reject",
    }))).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
  });

  it("represents prepaid and double-pay collection as plans over distinct real obligations", async () => {
    const scope = fixture;
    if (!scope) throw new Error("D2 fixture is missing");
    const first = (await db.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, scope.organizationId),
      eq(bowlerOccurrenceObligations.occurrenceId, scope.occurrenceIds[0]),
    )))[0];
    const second = await insertObligation(scope, 1);
    if (!first) throw new Error("first D2 obligation is missing");
    const [weeklyPlan] = await db.insert(occurrenceCollectionPlans).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planKey: `double-pay-${suffix}`,
      triggerOccurrenceId: scope.occurrenceIds[0],
      currency: "USD",
      state: "ready",
      version: 1,
      recordedByUserId: scope.actorUserId,
    }).returning();
    const [prepaidPlan] = await db.insert(occurrenceCollectionPlans).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planKey: `prepaid-${suffix}`,
      collectAt: "2037-12-01T00:00:00.000Z",
      currency: "USD",
      state: "draft",
      version: 1,
      recordedByUserId: scope.actorUserId,
    }).returning();
    if (!weeklyPlan || !prepaidPlan) throw new Error("D2 collection plans were not created");
    await db.insert(occurrenceCollectionPlanItems).values([
      {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        planId: weeklyPlan.id,
        obligationId: first.id,
        occurrenceId: scope.occurrenceIds[0],
        bowlerId: scope.bowlerId,
        amountMinor: 500,
        currency: "USD",
        itemIndex: 0,
      },
      {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        planId: weeklyPlan.id,
        obligationId: second.id,
        occurrenceId: scope.occurrenceIds[1],
        bowlerId: scope.bowlerId,
        amountMinor: 500,
        currency: "USD",
        itemIndex: 1,
      },
      {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        planId: prepaidPlan.id,
        obligationId: second.id,
        occurrenceId: scope.occurrenceIds[1],
        bowlerId: scope.bowlerId,
        amountMinor: 500,
        currency: "USD",
        itemIndex: 0,
      },
    ]);
    await db.insert(occurrenceCollectionPlanRevisions).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planId: weeklyPlan.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "ready", obligationIds: [first.id, second.id] },
      recordedByUserId: scope.actorUserId,
    });
    const doublePayItems = await db.select().from(occurrenceCollectionPlanItems)
      .where(eq(occurrenceCollectionPlanItems.planId, weeklyPlan.id));
    expect(doublePayItems.map((item) => item.occurrenceId).sort())
      .toEqual([...scope.occurrenceIds.slice(0, 2)].sort());
    expect(new Set(doublePayItems.map((item) => item.obligationId)).size).toBe(2);
    await expectDatabaseConstraint(
      db.update(occurrenceCollectionPlans).set({ state: "ready" })
        .where(eq(occurrenceCollectionPlans.id, prepaidPlan.id)),
      /collectable plan items exceed their obligation amount/i,
    );
    const [prepaidAfterRejectedActivation] = await db.select({ state: occurrenceCollectionPlans.state })
      .from(occurrenceCollectionPlans)
      .where(eq(occurrenceCollectionPlans.id, prepaidPlan.id));
    expect(prepaidAfterRejectedActivation?.state).toBe("draft");
    await expect(db.insert(occurrenceCollectionPlanItems).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planId: prepaidPlan.id,
      obligationId: first.id,
      occurrenceId: scope.occurrenceIds[0],
      bowlerId: scope.bowlerId,
      amountMinor: 501,
      currency: "USD",
      itemIndex: 1,
    })).rejects.toThrow();
    await expect(db.insert(occurrenceCollectionPlanItems).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planId: prepaidPlan.id,
      obligationId: first.id,
      occurrenceId: scope.occurrenceIds[0],
      bowlerId: scope.bowlerId,
      amountMinor: 500,
      currency: "CAD",
      itemIndex: 1,
    })).rejects.toThrow();

    const third = await insertObligation(scope, 2);
    const partialPlans = await db.insert(occurrenceCollectionPlans).values([
      {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        planKey: `partial-a-${suffix}`,
        collectAt: "2037-12-02T00:00:00.000Z",
        currency: "USD",
        state: "draft" as const,
        version: 1,
        recordedByUserId: scope.actorUserId,
      },
      {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        planKey: `partial-b-${suffix}`,
        collectAt: "2037-12-03T00:00:00.000Z",
        currency: "USD",
        state: "draft" as const,
        version: 1,
        recordedByUserId: scope.actorUserId,
      },
    ]).returning({ id: occurrenceCollectionPlans.id });
    if (!partialPlans[0] || !partialPlans[1]) throw new Error("partial plan fixtures are missing");
    await db.insert(occurrenceCollectionPlanItems).values(partialPlans.map((plan) => ({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      planId: plan.id,
      obligationId: third.id,
      occurrenceId: third.occurrenceId,
      bowlerId: scope.bowlerId,
      amountMinor: 300,
      currency: "USD",
      itemIndex: 0,
    })));
    const concurrentActivation = await Promise.allSettled(partialPlans.map((plan) => (
      db.update(occurrenceCollectionPlans).set({ state: "ready" })
        .where(eq(occurrenceCollectionPlans.id, plan.id))
    )));
    expect(concurrentActivation.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentActivation.filter((result) => result.status === "rejected")).toHaveLength(1);
    const partialPlanStates = await db.select({ state: occurrenceCollectionPlans.state })
      .from(occurrenceCollectionPlans)
      .where(and(
        eq(occurrenceCollectionPlans.organizationId, scope.organizationId),
        eq(occurrenceCollectionPlans.leagueId, scope.leagueId),
      ));
    expect(partialPlanStates.filter((plan) => plan.state === "ready")).toHaveLength(2);
  });

  it("supports partial many-to-many payment allocations and rejects duplicate or concurrent over-allocation", async () => {
    const scope = fixture;
    if (!scope) throw new Error("D2 fixture is missing");
    const obligations = await db.select().from(bowlerOccurrenceObligations).where(eq(
      bowlerOccurrenceObligations.organizationId,
      scope.organizationId,
    ));
    const first = obligations.find((row) => row.occurrenceId === scope.occurrenceIds[0]);
    const second = obligations.find((row) => row.occurrenceId === scope.occurrenceIds[1]);
    const third = obligations.find((row) => row.occurrenceId === scope.occurrenceIds[2]);
    if (!first || !second || !third) throw new Error("D2 allocation obligations are missing");
    const paymentRows = await db.insert(payments).values([
      { bowlerId: scope.bowlerId, leagueId: scope.leagueId, amount: 700, weekOf: "2037-12-01T00:00:00.000Z", status: "paid" as const, type: "cash" as const },
      { bowlerId: scope.bowlerId, leagueId: scope.leagueId, amount: 200, weekOf: "2037-12-02T00:00:00.000Z", status: "paid" as const, type: "check" as const },
      { bowlerId: scope.bowlerId, leagueId: scope.leagueId, amount: 400, weekOf: "2037-12-03T00:00:00.000Z", status: "paid" as const, type: "cash" as const },
      { bowlerId: scope.bowlerId, leagueId: scope.leagueId, amount: 400, weekOf: "2037-12-04T00:00:00.000Z", status: "paid" as const, type: "cash" as const },
    ]).returning({ id: payments.id });
    expect(await db.select().from(paymentOccurrenceAllocations).where(
      eq(paymentOccurrenceAllocations.organizationId, scope.organizationId),
    )).toEqual([]);
    const [firstAllocation] = await db.insert(paymentOccurrenceAllocations).values([
      { organizationId: scope.organizationId, leagueId: scope.leagueId, paymentId: paymentRows[0].id, obligationId: first.id, occurrenceId: first.occurrenceId, bowlerId: scope.bowlerId, amountMinor: 300, currency: "USD", allocationKey: `p1-o1-${suffix}`, recordedByUserId: scope.actorUserId },
      { organizationId: scope.organizationId, leagueId: scope.leagueId, paymentId: paymentRows[0].id, obligationId: second.id, occurrenceId: second.occurrenceId, bowlerId: scope.bowlerId, amountMinor: 400, currency: "USD", allocationKey: `p1-o2-${suffix}`, recordedByUserId: scope.actorUserId },
      { organizationId: scope.organizationId, leagueId: scope.leagueId, paymentId: paymentRows[1].id, obligationId: first.id, occurrenceId: first.occurrenceId, bowlerId: scope.bowlerId, amountMinor: 200, currency: "USD", allocationKey: `p2-o1-${suffix}`, recordedByUserId: scope.actorUserId },
    ]).returning();
    if (!firstAllocation) throw new Error("D2 payment allocations were not created");
    await db.insert(paymentOccurrenceAllocationRevisions).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      allocationId: firstAllocation.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { amountMinor: firstAllocation.amountMinor, state: "active" },
      recordedByUserId: scope.actorUserId,
    });
    const p1Allocations = await db.select().from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.paymentId, paymentRows[0].id));
    expect(new Set(p1Allocations.map((row) => row.occurrenceId)).size).toBe(2);
    const firstObligationAllocations = await db.select().from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.obligationId, first.id));
    expect(new Set(firstObligationAllocations.map((row) => row.paymentId)).size).toBe(2);
    expect(new Set(p1Allocations.map((row) => row.bowlerId))).toEqual(new Set([scope.bowlerId]));
    await expect(db.insert(paymentOccurrenceAllocations).values({
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      paymentId: paymentRows[0].id,
      obligationId: first.id,
      occurrenceId: first.occurrenceId,
      bowlerId: scope.bowlerId,
      amountMinor: 1,
      currency: "USD",
      allocationKey: `duplicate-${suffix}`,
      recordedByUserId: scope.actorUserId,
    })).rejects.toThrow();

    const concurrent = await Promise.allSettled([
      db.insert(paymentOccurrenceAllocations).values({ organizationId: scope.organizationId, leagueId: scope.leagueId, paymentId: paymentRows[2].id, obligationId: third.id, occurrenceId: third.occurrenceId, bowlerId: scope.bowlerId, amountMinor: 400, currency: "USD", allocationKey: `race-a-${suffix}`, recordedByUserId: scope.actorUserId }),
      db.insert(paymentOccurrenceAllocations).values({ organizationId: scope.organizationId, leagueId: scope.leagueId, paymentId: paymentRows[3].id, obligationId: third.id, occurrenceId: third.occurrenceId, bowlerId: scope.bowlerId, amountMinor: 400, currency: "USD", allocationKey: `race-b-${suffix}`, recordedByUserId: scope.actorUserId }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const allocated = await db.select().from(paymentOccurrenceAllocations)
      .where(and(eq(paymentOccurrenceAllocations.obligationId, third.id), eq(paymentOccurrenceAllocations.state, "active")));
    expect(allocated.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(400);
  });

  it("binds a dormant same-bowler multi-occurrence supplement to its execution snapshot", async () => {
    const scope = fixture;
    if (!scope) throw new Error("D2 fixture is missing");
    const obligations = await db.select().from(bowlerOccurrenceObligations)
      .where(eq(bowlerOccurrenceObligations.organizationId, scope.organizationId));
    const first = obligations.find((row) => row.occurrenceId === scope.occurrenceIds[0]);
    const second = obligations.find((row) => row.occurrenceId === scope.occurrenceIds[1]);
    if (!first || !second) throw new Error("D2 snapshot obligations are missing");
    const createOperation = async (label: string) => {
      const [operation] = await db.insert(paymentOperations).values({
        organizationId: scope.organizationId,
        operationType: "interactive_charge",
        targetKey: `interactive-charge:d2-${label}-${suffix}`,
        amountMinor: 1_000,
        currency: "USD",
        requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
        providerIdempotencyKey: `d2-${label}-${suffix}`.slice(0, 45),
        providerName: "square",
      }).returning();
      if (!operation) throw new Error("D2 snapshot operation was not created");
      return operation;
    };
    const semanticFor = (
      operationId: string,
      leagueId = scope.leagueId,
    ): PaymentOperationOccurrenceSnapshotV1 => ({
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: 1,
      operationId,
      operationType: "interactive_charge",
      organizationId: scope.organizationId,
      leagueId,
      amountMinor: 1_000,
      currency: "USD",
      allocations: [first, second].map((obligation, allocationIndex) => ({
        allocationIndex,
        organizationId: scope.organizationId,
        leagueId,
        occurrenceId: obligation.occurrenceId,
        bowlerId: scope.bowlerId,
        obligationId: obligation.id,
        amountMinor: 500,
        currency: "USD",
      })),
    });
    const operation = await createOperation("valid");
    const semantic = semanticFor(operation.id);
    await db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({
        operationId: operation.id,
        snapshotVersion: 2,
        snapshotFingerprint: `lvpayexecic:v2:${"b".repeat(64)}`,
        leagueId: scope.leagueId,
        locationId: scope.locationId,
        payerBowlerId: scope.bowlerId,
        requestKind: "direct",
        encryptedSourceId: "D2_ENCRYPTED_SOURCE",
        storeCard: false,
        sourceKind: "new_card",
        weekOf: "2037-12-01T00:00:00.000Z",
      });
      await tx.insert(interactivePaymentOperationAllocations).values({
        operationId: operation.id,
        allocationIndex: 0,
        bowlerId: scope.bowlerId,
        amountMinor: 1_000,
        weekOf: "2037-12-01T00:00:00.000Z",
      });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: operation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(semantic),
        amountMinor: 1_000,
        currency: "USD",
        allocationCount: 2,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(
        semantic.allocations.map((allocation) => ({ operationId: operation.id, snapshotVersion: 1, ...allocation })),
      );
    });
    const rows = await db.select().from(paymentOperationOccurrenceSnapshotAllocations)
      .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.bowlerId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(2);
    await expectDatabaseConstraint(
      db.update(interactivePaymentOperationSnapshots).set({ leagueId: scope.otherLeagueId })
        .where(eq(interactivePaymentOperationSnapshots.operationId, operation.id)),
      /league conflicts with its execution snapshot/i,
    );
    await expectDatabaseConstraint(
      db.delete(interactivePaymentOperationSnapshots)
        .where(eq(interactivePaymentOperationSnapshots.operationId, operation.id)),
      /requires its matching execution snapshot/i,
    );

    const missingBaseOperation = await createOperation("missing-base");
    const missingBaseSemantic = semanticFor(missingBaseOperation.id);
    await expectDatabaseConstraint(db.transaction(async (tx) => {
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: missingBaseOperation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(missingBaseSemantic),
        amountMinor: 1_000,
        currency: "USD",
        allocationCount: 2,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(
        missingBaseSemantic.allocations.map((allocation) => ({
          operationId: missingBaseOperation.id,
          snapshotVersion: 1,
          ...allocation,
        })),
      );
    }), /requires its matching execution snapshot/i);

    const mismatchedBaseOperation = await createOperation("mismatched-base");
    const mismatchedBaseSemantic = semanticFor(mismatchedBaseOperation.id);
    await expectDatabaseConstraint(db.transaction(async (tx) => {
      await tx.insert(interactivePaymentOperationSnapshots).values({
        operationId: mismatchedBaseOperation.id,
        snapshotVersion: 2,
        snapshotFingerprint: `lvpayexecic:v2:${"c".repeat(64)}`,
        leagueId: scope.otherLeagueId,
        locationId: scope.locationId,
        payerBowlerId: scope.bowlerId,
        requestKind: "direct",
        encryptedSourceId: "D2_ENCRYPTED_SOURCE",
        storeCard: false,
        sourceKind: "new_card",
        weekOf: "2037-12-01T00:00:00.000Z",
      });
      await tx.insert(interactivePaymentOperationAllocations).values({
        operationId: mismatchedBaseOperation.id,
        allocationIndex: 0,
        bowlerId: scope.bowlerId,
        amountMinor: 1_000,
        weekOf: "2037-12-01T00:00:00.000Z",
      });
      await tx.insert(paymentOperationOccurrenceSnapshots).values({
        operationId: mismatchedBaseOperation.id,
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        snapshotVersion: 1,
        snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(mismatchedBaseSemantic),
        amountMinor: 1_000,
        currency: "USD",
        allocationCount: 2,
      });
      await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(
        mismatchedBaseSemantic.allocations.map((allocation) => ({
          operationId: mismatchedBaseOperation.id,
          snapshotVersion: 1,
          ...allocation,
        })),
      );
    }), /league conflicts with its execution snapshot/i);
  });

  it("removes D2 evidence in atomic organization teardown order", async () => {
    const teardown = await createFixture("Teardown");
    const [eligibility] = await db.insert(bowlerOccurrenceEligibilities).values({
      organizationId: teardown.organizationId,
      leagueId: teardown.leagueId,
      occurrenceId: teardown.occurrenceIds[0],
      bowlerId: teardown.bowlerId,
      state: "eligible",
      reason: "Teardown evidence",
      recordedByUserId: teardown.actorUserId,
    }).returning();
    if (!eligibility) throw new Error("teardown eligibility was not created");
    await db.insert(bowlerOccurrenceEligibilityRevisions).values({
      organizationId: teardown.organizationId,
      leagueId: teardown.leagueId,
      eligibilityId: eligibility.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "eligible" },
      recordedByUserId: teardown.actorUserId,
    });
    await deleteOrganization(teardown.organizationId);
    expect(await db.select().from(bowlerOccurrenceEligibilities)
      .where(eq(bowlerOccurrenceEligibilities.organizationId, teardown.organizationId))).toEqual([]);
    expect(await db.select().from(bowlerOccurrenceEligibilityRevisions)
      .where(eq(bowlerOccurrenceEligibilityRevisions.organizationId, teardown.organizationId))).toEqual([]);
    expect(await db.select().from(organizations)
      .where(eq(organizations.id, teardown.organizationId))).toEqual([]);
  });

  it("rejects direct SQL activation evidence with incomplete responsibility counts and mutation", async () => {
    const scope = await createFixture("F1Guard");
    const fp = `lvfinancialactivation:v1:${"0".repeat(64)}`;
    const sourceFp = `lvfinancialsource:v1:${"0".repeat(64)}`;
    await expectDatabaseConstraint(db.transaction(async (tx) => {
      await tx.insert(financialActivations).values({
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        activationVersion: 1,
        policyVersion: "eligible-bowlers/1",
        orderVersion: "occurrence-team-slot-bowler/1",
        commandKey: "f1-direct-incomplete",
        requestFingerprint: fp,
        sourceFingerprint: sourceFp,
        paymentMode: "upfront",
        state: "active",
        completenessMarker: true,
        payingLineupSize: 3,
        expectedResponsibilityCount: 3,
        expectedGroupCount: 1,
        currentRevision: 1,
        upfrontDueAt: "2038-01-01T00:00:00.000Z",
        recordedByUserId: scope.actorUserId,
      });
    }), /financial activation evidence is incomplete/i);
    const [activation] = await db.select().from(financialActivations).where(and(eq(financialActivations.organizationId, scope.organizationId), eq(financialActivations.commandKey, "f1-direct-incomplete")));
    expect(activation).toBeUndefined();
    await deleteOrganization(scope.organizationId);
  });
});
