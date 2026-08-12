import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bowlers,
  games,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  paymentOperations,
  paymentSchedules,
  scheduledPaymentOperationSnapshots,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { createGame, updateGame } from "../../server/storage/games-scores";
import {
  createPaymentSchedule,
  updatePaymentScheduleFields,
} from "../../server/storage/payments";
import {
  createOrGetInteractivePaymentOperation,
  createOrGetRefundPaymentOperation,
  createOrGetScheduledPaymentOperation,
  PaymentOperationImmutableMismatchError,
} from "../../server/storage/payment-operations";
import { prepareScheduledPaymentCycle } from "../../server/services/scheduled-payment-operation-preparation";
import {
  buildCanonicalScheduleCommandFingerprint,
  rescheduleOccurrence,
} from "../../server/services/canonical-occurrence-transactions";
import { buildPaymentOperationIdentity } from "../../server/services/payment-operation-idempotency";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
let organizationId: number;
let otherOrganizationId: number;
let locationId: number;
let crossTenantLocationId: number;
let actorUserId: number;
let crossTenantActorUserId: number;
let leagueId: number;
let otherLeagueId: number;
let crossTenantLeagueId: number;
let bowlerId: number;
let sequence = 0;
const generationRunIds = new Map<number, string>();

async function publishedOccurrence(input: {
  leagueId?: number;
  organizationId?: number;
  locationId?: number;
  localDate: string;
  startAt: string;
  ordinal: number;
}) {
  const orgId = input.organizationId ?? organizationId;
  const targetLeagueId = input.leagueId ?? leagueId;
  const targetLocationId = input.locationId ?? locationId;
  const commandActorUserId = orgId === organizationId ? actorUserId : crossTenantActorUserId;
  const [command] = await db.insert(leagueScheduleCommands).values({
    organizationId: orgId,
    leagueId: targetLeagueId,
    actorUserId: commandActorUserId,
    commandType: "publish",
    reason: "D1 PostgreSQL fixture",
    idempotencyKey: `d1-publish-${suffix}-${++sequence}`,
    requestFingerprint: `lvcanoncmd:v1:${String(sequence).padStart(64, "0")}`,
  }).returning();
  if (!command) throw new Error("publish command fixture was not created");
  let generationRunId = generationRunIds.get(targetLeagueId);
  if (generationRunId === undefined) {
    const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({
      organizationId: orgId,
      leagueId: targetLeagueId,
      originatingCommandId: command.id,
      generatorVersion: "d1-operational-fixture/1",
      inputFingerprint: `d1-operational-${suffix}-${targetLeagueId}`,
      sourceScheduleRevision: 1,
      normalizedInputSnapshot: { fixture: "d1-operational" },
      rangeStartDate: "2035-01-01",
      rangeEndDate: "2035-12-31",
      candidateOccurrenceCount: 1,
      generatedOccurrenceCount: 1,
      skippedDateCount: 0,
      discrepancyCount: 0,
      state: "applied",
      approvedAt: "2034-12-01T00:00:00.000Z",
      approvedByUserId: commandActorUserId,
      approvalCommandId: command.id,
    }).returning({ id: leagueOccurrenceGenerationRuns.id });
    if (!run) throw new Error("generation run fixture was not created");
    generationRunId = run.id;
    generationRunIds.set(targetLeagueId, run.id);
  } else {
    const [run] = await db.select().from(leagueOccurrenceGenerationRuns)
      .where(eq(leagueOccurrenceGenerationRuns.id, generationRunId)).limit(1);
    if (!run) throw new Error("generation run fixture was not found");
    await db.update(leagueOccurrenceGenerationRuns).set({
      candidateOccurrenceCount: run.candidateOccurrenceCount + 1,
      generatedOccurrenceCount: run.generatedOccurrenceCount + 1,
    }).where(eq(leagueOccurrenceGenerationRuns.id, generationRunId));
  }
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId: orgId,
    leagueId: targetLeagueId,
    locationId: targetLocationId,
    generationKey: `d1-occurrence-${suffix}-${sequence}`,
    generationRunId,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: input.localDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: input.startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "d1-test-resolver",
    plannedOrdinal: input.ordinal,
    competitionNumber: input.ordinal,
    competitive: true,
    countsInStandings: true,
    lastCommandId: command.id,
    publishedAt: "2034-12-01T00:00:00.000Z",
    publishedByUserId: commandActorUserId,
    publicationCommandId: command.id,
  }).returning();
  if (!occurrence) throw new Error("occurrence fixture was not created");
  return occurrence;
}

async function deactivateSchedules(): Promise<void> {
  await db.update(paymentSchedules).set({ active: false }).where(eq(paymentSchedules.leagueId, leagueId));
}

beforeAll(async () => {
  for (const slug of [`d1-compat-${suffix}`, `d1-compat-other-${suffix}`]) {
    const [prior] = await db.select({ id: organizations.id }).from(organizations)
      .where(eq(organizations.slug, slug)).limit(1);
    if (prior) await deleteOrganization(prior.id);
  }
  const [organization] = await db.insert(organizations).values({
    name: "D1 compatibility",
    slug: `d1-compat-${suffix}`,
  }).returning();
  const [otherOrganization] = await db.insert(organizations).values({
    name: "D1 compatibility other",
    slug: `d1-compat-other-${suffix}`,
  }).returning();
  if (!organization || !otherOrganization) throw new Error("organization fixtures were not created");
  organizationId = organization.id;
  otherOrganizationId = otherOrganization.id;
  const [actor] = await db.insert(users).values({
    email: `d1-${suffix}@example.test`,
    password: "test-password-hash",
    name: "D1 actor",
    role: "org_admin",
    organizationId,
  }).returning();
  if (!actor) throw new Error("actor fixture was not created");
  actorUserId = actor.id;
  const [crossTenantActor] = await db.insert(users).values({
    email: `d1-other-${suffix}@example.test`,
    password: "test-password-hash",
    name: "D1 other actor",
    role: "org_admin",
    organizationId: otherOrganizationId,
  }).returning();
  if (!crossTenantActor) throw new Error("cross-tenant actor fixture was not created");
  crossTenantActorUserId = crossTenantActor.id;
  const [location] = await db.insert(locations).values({
    name: "D1 location",
    organizationId,
    squareCredentials: {
      appId: "sandbox-app",
      accessToken: "deterministic-test-token",
      locationId: "D1_SQUARE_LOCATION",
    },
  }).returning();
  const [otherLocation] = await db.insert(locations).values({
    name: "D1 other location",
    organizationId: otherOrganizationId,
  }).returning();
  if (!location || !otherLocation) throw new Error("location fixtures were not created");
  locationId = location.id;
  crossTenantLocationId = otherLocation.id;
  const baseLeague = {
    seasonStart: "2035-01-01T00:00:00.000Z",
    seasonEnd: "2035-12-31T23:59:59.000Z",
    weekDay: "Friday" as const,
    competitionStartTime: "19:00",
    timezone: "UTC",
    weeklyFee: 2_000,
    totalBowlingWeeks: 40,
    paymentMode: "weekly" as const,
  };
  const [league] = await db.insert(leagues).values({
    ...baseLeague, name: "D1 league", organizationId, locationId,
  }).returning();
  const [otherLeague] = await db.insert(leagues).values({
    ...baseLeague, name: "D1 other league", organizationId, locationId,
  }).returning();
  const [crossTenantLeague] = await db.insert(leagues).values({
    ...baseLeague,
    name: "D1 cross tenant league",
    organizationId: otherOrganizationId,
    locationId: otherLocation.id,
  }).returning();
  if (!league || !otherLeague || !crossTenantLeague) throw new Error("league fixtures were not created");
  leagueId = league.id;
  otherLeagueId = otherLeague.id;
  crossTenantLeagueId = crossTenantLeague.id;
  const [bowler] = await db.insert(bowlers).values({
    name: "D1 bowler",
    email: `d1-bowler-${suffix}@example.test`,
    organizationId,
    paymentCustomerId: "d1-customer",
  }).returning();
  if (!bowler) throw new Error("bowler fixture was not created");
  bowlerId = bowler.id;
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
  if (otherOrganizationId) await deleteOrganization(otherOrganizationId);
});

describe("D1 occurrence compatibility PostgreSQL behavior", () => {
  it("keeps legacy rows nullable and links exact games without adding score identity", async () => {
    const occurrence = await publishedOccurrence({
      localDate: "2035-01-05", startAt: "2035-01-05T19:00:00.000Z", ordinal: 1,
    });
    const linked = await createGame({ leagueId, weekNumber: 1, gameNumber: 1, date: "2035-01-05" });
    expect(linked.occurrenceId).toBe(occurrence.id);
    await expect(updateGame(linked.id, { weekNumber: 2 })).rejects.toMatchObject({
      name: "CanonicalGamesScoresError",
    });
    expect((await db.select().from(games).where(eq(games.id, linked.id)))[0]).toMatchObject({
      occurrenceId: occurrence.id,
      weekNumber: 1,
    });
    await expect(createGame({ leagueId, weekNumber: 1, gameNumber: 1, date: "2035-01-05" }))
      .rejects.toMatchObject({ name: "CanonicalGamesScoresError" });
    await expect(createGame({ leagueId, weekNumber: 2, gameNumber: 2, date: "2035-01-05" }))
      .rejects.toMatchObject({ name: "CanonicalGamesScoresError" });

    const [legacy] = await db.insert(games).values({
      leagueId, weekNumber: 99, gameNumber: 3, date: "2035-06-01T00:00:00.000Z",
    }).returning();
    expect(legacy?.occurrenceId).toBeNull();
    expect("occurrenceId" in (await import("@shared/schema")).scores).toBe(false);
    if (legacy) await db.delete(games).where(eq(games.id, legacy.id));

    await expect(db.delete(leagueOccurrences).where(eq(leagueOccurrences.id, occurrence.id)))
      .rejects.toBeDefined();
  });

  it("enforces same-league game/schedule links and tenant-safe operation links", async () => {
    await deactivateSchedules();
    const own = await publishedOccurrence({
      localDate: "2035-02-02", startAt: "2035-02-02T19:00:00.000Z", ordinal: 2,
    });
    const otherLeague = await publishedOccurrence({
      leagueId: otherLeagueId,
      localDate: "2035-02-09",
      startAt: "2035-02-09T19:00:00.000Z",
      ordinal: 1,
    });
    const crossTenant = await publishedOccurrence({
      leagueId: crossTenantLeagueId,
      organizationId: otherOrganizationId,
      locationId: crossTenantLocationId,
      localDate: "2035-02-16",
      startAt: "2035-02-16T19:00:00.000Z",
      ordinal: 1,
    });
    await expect(db.insert(games).values({
      leagueId, weekNumber: 2, gameNumber: 3, date: own.startAt, occurrenceId: otherLeague.id,
    })).rejects.toBeDefined();
    await expect(db.insert(games).values({
      leagueId, weekNumber: 2, gameNumber: 2, date: own.startAt, occurrenceId: crossTenant.id,
    })).rejects.toBeDefined();
    await expect(db.insert(paymentSchedules).values({
      bowlerId, leagueId, frequency: "weekly", amount: 2_000,
      nextPaymentDate: own.startAt, nextOccurrenceId: otherLeague.id,
      paymentCardId: "ccof:d1-cross-league",
    })).rejects.toBeDefined();

    const [schedule] = await db.insert(paymentSchedules).values({
      bowlerId, leagueId, frequency: "weekly", amount: 2_000,
      nextPaymentDate: own.startAt, paymentCardId: "ccof:d1-trigger-scope",
    }).returning();
    if (!schedule) throw new Error("schedule fixture was not created");
    await expect(createOrGetScheduledPaymentOperation({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: own.startAt,
      triggerOccurrenceId: otherLeague.id,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
    await db.update(paymentSchedules)
      .set({ nextOccurrenceId: own.id })
      .where(eq(paymentSchedules.id, schedule.id));
    await expect(createOrGetScheduledPaymentOperation({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: crossTenant.startAt,
      triggerOccurrenceId: crossTenant.id,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
    await expect(createOrGetScheduledPaymentOperation({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: "2035-02-02T19:00:01.000Z",
      triggerOccurrenceId: own.id,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("dual-writes schedule cursors and scheduled trigger identity without changing provider identity", async () => {
    await deactivateSchedules();
    const first = await publishedOccurrence({
      localDate: "2035-03-02", startAt: "2035-03-02T19:00:00.000Z", ordinal: 3,
    });
    const second = await publishedOccurrence({
      localDate: "2035-03-09", startAt: "2035-03-09T19:00:00.000Z", ordinal: 4,
    });
    const schedule = await createPaymentSchedule({
      bowlerId, leagueId, frequency: "weekly", amount: 2_000,
      nextPaymentDate: first.startAt, active: true,
      paymentCardId: "ccof:d1-preparation",
      additionalBowlerIds: null,
    });
    expect(schedule.nextOccurrenceId).toBe(first.id);
    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: first.startAt,
      now: new Date("2035-03-02T20:00:00.000Z"),
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("cycle was not prepared");
    expect(prepared.operation.triggerOccurrenceId).toBe(first.id);
    expect(prepared.schedule.nextOccurrenceId).toBe(second.id);
    const identity = buildPaymentOperationIdentity({
      organizationId,
      operationType: "scheduled_charge",
      targetKey: `payment-schedule:${schedule.id}`,
      paymentScheduleId: schedule.id,
      billingCycleAt: first.startAt,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    expect(prepared.operation.requestFingerprint).toBe(identity.requestFingerprint);
    expect(prepared.operation.providerIdempotencyKey).toBe(identity.providerIdempotencyKey);
    expect((await db.select().from(scheduledPaymentOperationSnapshots)
      .where(eq(scheduledPaymentOperationSnapshots.operationId, prepared.operation.id)))[0]?.snapshotVersion).toBe(1);
    const storageRetry = await createOrGetScheduledPaymentOperation({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: first.startAt,
      triggerOccurrenceId: first.id,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    expect(storageRetry).toMatchObject({
      id: prepared.operation.id,
      triggerOccurrenceId: first.id,
      requestFingerprint: identity.requestFingerprint,
      providerIdempotencyKey: identity.providerIdempotencyKey,
    });

    const retry = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: first.startAt,
      now: new Date("2035-03-02T20:00:00.000Z"),
    });
    expect(retry.kind).toBe("existing");
    if (retry.kind === "existing") expect(retry.operation.triggerOccurrenceId).toBe(first.id);
  });

  it("links a new exact operation when the schedule predates D1", async () => {
    await deactivateSchedules();
    const trigger = await publishedOccurrence({
      localDate: "2035-04-13", startAt: "2035-04-13T19:00:00.000Z", ordinal: 11,
    });
    const next = await publishedOccurrence({
      localDate: "2035-04-20", startAt: "2035-04-20T19:00:00.000Z", ordinal: 12,
    });
    const [preD1Schedule] = await db.insert(paymentSchedules).values({
      bowlerId,
      leagueId,
      frequency: "weekly",
      amount: 2_000,
      nextPaymentDate: trigger.startAt,
      paymentCardId: "ccof:d1-pre-d1-new-operation",
    }).returning();
    if (!preD1Schedule) throw new Error("pre-D1 schedule fixture was not created");
    expect(preD1Schedule.nextOccurrenceId).toBeNull();

    const prepared = await prepareScheduledPaymentCycle({
      paymentScheduleId: preD1Schedule.id,
      billingCycleAt: trigger.startAt,
      now: new Date("2035-04-13T20:00:00.000Z"),
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("pre-D1 cycle was not prepared");
    expect(prepared.operation.triggerOccurrenceId).toBe(trigger.id);
    expect(prepared.schedule).toMatchObject({
      nextPaymentDate: expect.stringContaining("2035-04-20 19:00:00"),
      nextOccurrenceId: next.id,
    });
  });

  it("leaves pre-D1 operation retries null and interactive/refund operations unlinked", async () => {
    await deactivateSchedules();
    const [schedule] = await db.insert(paymentSchedules).values({
      bowlerId, leagueId, frequency: "weekly", amount: 2_000,
      nextPaymentDate: "2035-04-06T19:00:00.000Z",
      paymentCardId: "ccof:d1-pre-d1",
    }).returning();
    if (!schedule) throw new Error("schedule fixture was not created");
    const legacyOccurrence = await publishedOccurrence({
      localDate: "2035-04-06", startAt: "2035-04-06T19:00:00.000Z", ordinal: 5,
    });
    const legacyOperation = await createOrGetScheduledPaymentOperation({
      organizationId, paymentScheduleId: schedule.id,
      billingCycleAt: schedule.nextPaymentDate, amountMinor: 2_000,
      currency: "USD", providerName: "square",
    });
    expect(legacyOperation.triggerOccurrenceId).toBeNull();
    const preD1RetryWithNewEvidence = await createOrGetScheduledPaymentOperation({
      organizationId, paymentScheduleId: schedule.id,
      billingCycleAt: schedule.nextPaymentDate, triggerOccurrenceId: legacyOccurrence.id,
      amountMinor: 2_000, currency: "USD", providerName: "square",
    });
    expect(preD1RetryWithNewEvidence.id).toBe(legacyOperation.id);
    expect(preD1RetryWithNewEvidence.triggerOccurrenceId).toBeNull();
    const retry = await prepareScheduledPaymentCycle({
      paymentScheduleId: schedule.id,
      billingCycleAt: schedule.nextPaymentDate,
      now: new Date("2035-04-06T20:00:00.000Z"),
    });
    expect(retry.kind).toBe("existing");
    if (retry.kind === "existing") expect(retry.operation.triggerOccurrenceId).toBeNull();

    const interactive = await createOrGetInteractivePaymentOperation({
      organizationId, targetKey: `d1-interactive-${++sequence}`,
      amountMinor: 100, currency: "USD", providerName: "square",
    });
    expect(interactive.triggerOccurrenceId).toBeNull();
    await expect(db.update(paymentOperations)
      .set({ triggerOccurrenceId: legacyOccurrence.id })
      .where(eq(paymentOperations.id, interactive.id))).rejects.toBeDefined();
    const [paid] = await db.insert((await import("@shared/schema")).payments).values({
      bowlerId, leagueId, amount: 100, weekOf: "2035-04-06T19:00:00.000Z",
      status: "paid", type: "square", providerPaymentId: `d1-provider-${sequence}`,
    }).returning();
    if (!paid) throw new Error("payment fixture was not created");
    const refund = await createOrGetRefundPaymentOperation({
      organizationId, paymentId: paid.id, amountMinor: 100,
      currency: "USD", providerName: "square",
    });
    expect(refund.triggerOccurrenceId).toBeNull();
  });

  it("keeps cursor/reference pairs consistent under mismatches and concurrent updates", async () => {
    await deactivateSchedules();
    const first = await publishedOccurrence({
      localDate: "2035-05-04", startAt: "2035-05-04T19:00:00.000Z", ordinal: 6,
    });
    const second = await publishedOccurrence({
      localDate: "2035-05-11", startAt: "2035-05-11T19:00:00.000Z", ordinal: 7,
    });
    const third = await publishedOccurrence({
      localDate: "2035-05-18", startAt: "2035-05-18T19:00:00.000Z", ordinal: 8,
    });
    const schedule = await createPaymentSchedule({
      bowlerId, leagueId, frequency: "weekly", amount: 2_000,
      nextPaymentDate: first.startAt, active: true,
      paymentCardId: "ccof:d1-concurrency", additionalBowlerIds: null,
    });
    const mismatched = await updatePaymentScheduleFields(schedule.id, {
      nextPaymentDate: "2035-05-11T19:00:01.000Z",
    });
    expect(mismatched.nextPaymentDate).toContain("2035-05-11 19:00:01");
    expect(mismatched.nextOccurrenceId).toBeNull();
    await Promise.all([
      updatePaymentScheduleFields(schedule.id, { nextPaymentDate: second.startAt }),
      updatePaymentScheduleFields(schedule.id, { nextPaymentDate: third.startAt }),
    ]);
    const [final] = await db.select().from(paymentSchedules).where(eq(paymentSchedules.id, schedule.id));
    const expected = final?.nextPaymentDate.includes("2035-05-11") ? second.id : third.id;
    expect(final?.nextOccurrenceId).toBe(expected);
  });

  it("treats linked game and operation activity as effective locks", async () => {
    const occurrence = await publishedOccurrence({
      localDate: "2035-06-01", startAt: "2035-06-01T19:00:00.000Z", ordinal: 9,
    });
    await createGame({ leagueId, weekNumber: 9, gameNumber: 1, date: "2035-06-01" });
    const base = {
      organizationId,
      leagueId,
      actorUserId,
      commandType: "reschedule" as const,
      idempotencyKey: `d1-reschedule-${++sequence}`,
      requestFingerprint: "",
      reason: "D1 linked activity test",
      occurrenceId: occurrence.id,
      now: "2035-05-01T00:00:00.000Z",
      authoritativeLocalDate: "2035-06-08",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      ambiguousFold: "reject" as const,
    };
    const request = { ...base, requestFingerprint: buildCanonicalScheduleCommandFingerprint(base) };
    await expect(rescheduleOccurrence(request)).rejects.toMatchObject({
      code: "occurrence_effectively_locked",
    });

    const operationOccurrence = await publishedOccurrence({
      localDate: "2035-06-08", startAt: "2035-06-08T19:00:00.000Z", ordinal: 10,
    });
    const [schedule] = await db.insert(paymentSchedules).values({
      bowlerId,
      leagueId,
      frequency: "weekly",
      amount: 2_000,
      nextPaymentDate: operationOccurrence.startAt,
      nextOccurrenceId: operationOccurrence.id,
      active: false,
      paymentCardId: "ccof:d1-operation-lock",
    }).returning();
    if (!schedule) throw new Error("operation-lock schedule was not created");
    await createOrGetScheduledPaymentOperation({
      organizationId,
      paymentScheduleId: schedule.id,
      billingCycleAt: operationOccurrence.startAt,
      triggerOccurrenceId: operationOccurrence.id,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const operationBase = {
      ...base,
      idempotencyKey: `d1-operation-reschedule-${++sequence}`,
      occurrenceId: operationOccurrence.id,
      authoritativeLocalDate: "2035-06-15",
    };
    await expect(rescheduleOccurrence({
      ...operationBase,
      requestFingerprint: buildCanonicalScheduleCommandFingerprint(operationBase),
    })).rejects.toMatchObject({
      code: "occurrence_effectively_locked",
    });
  });
});
