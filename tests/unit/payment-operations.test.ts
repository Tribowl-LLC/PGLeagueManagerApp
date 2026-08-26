import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import {
  bowlers,
  bowlerLeagues,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  payments,
  teamPaymentSlots,
  teams,
  users,
  paymentOperationRosterSnapshots,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  PaymentOperationImmutableMismatchError,
  PaymentOperationInvalidTransitionError,
  PaymentOperationNotFoundError,
  PaymentOperationValidationError,
  GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH,
  acquirePaymentOperationLease,
  cancelPaymentOperation,
  createOrGetGeneralInteractivePaymentOperation,
  finalizePaymentOperationSuccess,
  finalizeChargeFromWebhookEvidenceInTransaction,
  getPaymentOperationForOrganization,
  persistRosterOperationSnapshot,
  getRosterOperationSnapshotForOrganization,
  recordPaymentOperationActionRequired,
  recordPaymentOperationFailedTerminal,
  recordPaymentOperationProviderUnknown,
  recordExpiredPaymentOperationAttemptExhausted,
  reconcilePaymentOperationSuccess,
  schedulePaymentOperationRetry,
} from "../../server/storage/payment-operations";
import {
  deriveSquareOperationIdempotencyKey,
} from "../../server/services/payment-operation-idempotency";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { buildPaymentOperationIdentity } from "../../server/services/payment-operation-idempotency";
import type { RosterOperationSemanticSnapshot } from "../../server/services/roster-operation-snapshot";

const db = getTestDb();
const poolSuffix = process.env.VITEST_POOL_ID ?? "0";
const orgSlugs = [
  `payment-operations-a-${poolSuffix}`,
  `payment-operations-b-${poolSuffix}`,
] as const;

let orgAId: number;
let orgBId: number;
let scheduleAId: number;
let scheduleBId: number;
let scheduleAActorId: number;
let scheduleBActorId: number;
let nextCycleOffset = 0;

function timestampToIso(value: string | null): string | null {
  if (value === null) return null;
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  return new Date(includesZone ? value : `${value.replace(" ", "T")}Z`).toISOString();
}

function cycleAt(offset = nextCycleOffset++): Date {
  return new Date(Date.UTC(2032, 0, 1 + offset, 12, 0, 0));
}

async function createFixtureSchedule(organizationId: number, label: string): Promise<number> {
  const [league] = await db.insert(leagues).values({
    name: `Payment Operations ${label}`,
    seasonStart: "2032-01-01T00:00:00.000Z",
    seasonEnd: "2032-12-31T00:00:00.000Z",
    weekDay: "Monday",
    weeklyFee: 2_000,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    timezone: "UTC",
    organizationId,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("fixture league was not created");
  const [location] = await db.insert(locations).values({
    organizationId,
    name: `Payment Operations Location ${label}`,
  }).returning({ id: locations.id });
  if (!location) throw new Error("fixture location was not created");
  await db.update(leagues).set({ locationId: location.id }).where(eq(leagues.id, league.id));

  const [bowler] = await db.insert(bowlers).values({
    name: `Payment Operations Bowler ${label}`,
    organizationId,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("fixture bowler was not created");
  const [actor] = await db.insert(users).values({
    email: `payment-operations-${label.toLowerCase()}-${poolSuffix}@example.test`,
    password: "payment-operations-test-password-hash",
    name: `Payment Operations Actor ${label}`,
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("fixture actor was not created");
  if (label === "A") scheduleAActorId = actor.id;
  if (label === "B") scheduleBActorId = actor.id;

  const [team] = await db.insert(teams).values({
    name: `Payment Operations Team ${label}`,
    number: 1,
    leagueId: league.id,
  }).returning({ id: teams.id });
  if (!team) throw new Error("fixture team was not created");
  await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
  });
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowler.id, recordedByUserId: actor.id },
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actor.id },
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actor.id },
  ]);
  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId: league.id,
    actorUserId: actor.id,
    commandType: "publish",
    idempotencyKey: `payment-operations-publish-${poolSuffix}-${label}`,
    requestFingerprint: `payment-operations-fingerprint-${label}`,
  });
  const startAt = "2032-02-02T12:00:00.000Z";
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId: league.id,
    locationId: location.id,
    generationKey: `payment-operations-occurrence-${poolSuffix}-${label}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: "2032-02-02",
    authoritativeLocalStartTime: "12:00:00",
    timezone: "UTC",
    startAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "payment-operations-test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    publishedAt: startAt,
    publishedByUserId: actor.id,
    publicationCommandId: commandId,
    lastCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  if (!occurrence) throw new Error("fixture occurrence was not created");
  await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, {
    organizationId,
    leagueId: league.id,
    occurrenceId: occurrence.id,
    actorUserId: actor.id,
  }));

  return league.id;
}

async function createOperation(
  organizationId = orgAId,
  leagueId = scheduleAId,
  requestTimestamp = cycleAt(),
  amountMinor = 2_000,
) {
  const operation = await createOrGetGeneralInteractivePaymentOperation({
    organizationId,
    leagueId,
    requestKey: `ledger-${leagueId}-${requestTimestamp.getTime()}-${randomUUID()}`,
    amountMinor,
    currency: "USD",
    providerName: "square",
    authorizingUserId: organizationId === orgAId ? scheduleAActorId : scheduleBActorId,
  });
  return operation;
}

async function getScheduleContext(scheduleId = scheduleAId): Promise<{
  bowlerId: number;
  leagueId: number;
  obligationId: string;
  responsibilityId: string;
  responsibilityVersion: number;
  weekOf: string;
}> {
  const [schedule] = await db
    .select({
      bowlerId: bowlers.id,
      leagueId: leagues.id,
      obligationId: paymentObligations.id,
      responsibilityId: occurrencePaymentResponsibilities.id,
      responsibilityVersion: occurrencePaymentResponsibilities.version,
      weekOf: paymentObligations.dueAt,
    })
    .from(bowlerLeagues)
    .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
    .innerJoin(leagues, eq(leagues.id, bowlerLeagues.leagueId))
    .innerJoin(occurrencePaymentResponsibilities, eq(occurrencePaymentResponsibilities.leagueId, leagues.id))
    .innerJoin(paymentObligations, eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id))
    .where(and(
      eq(bowlerLeagues.leagueId, scheduleId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ))
    .limit(1);
  if (!schedule) throw new Error("fixture schedule was not found");
  return schedule;
}

async function linkedPaymentValues(input: {
  organizationId?: number;
  bowlerId: number;
  leagueId: number;
  amount?: number;
  status?: "paid" | "failed";
  providerPaymentId?: string;
  notes?: string | null;
}) {
  return {
    organizationId: input.organizationId ?? orgAId,
    bowlerId: input.bowlerId,
    leagueId: input.leagueId,
    amount: input.amount ?? 2_000,
    currency: "USD",
    status: input.status ?? "paid",
    type: "square" as const,
    providerPaymentId: input.providerPaymentId,
    notes: input.notes,
  };
}

beforeAll(async () => {
  const leftovers = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.slug, orgSlugs));
  for (const leftover of leftovers) await deleteOrganization(leftover.id);

  const [orgA, orgB] = await db.insert(organizations).values([
    { name: "Payment Operations Tenant A", slug: orgSlugs[0] },
    { name: "Payment Operations Tenant B", slug: orgSlugs[1] },
  ]).returning({ id: organizations.id, slug: organizations.slug });
  if (!orgA || !orgB) throw new Error("fixture organizations were not created");
  const bySlug = new Map([orgA, orgB].map((row) => [row.slug, row.id]));
  const foundA = bySlug.get(orgSlugs[0]);
  const foundB = bySlug.get(orgSlugs[1]);
  if (foundA === undefined || foundB === undefined) throw new Error("fixture organizations are incomplete");
  orgAId = foundA;
  orgBId = foundB;
  scheduleAId = await createFixtureSchedule(orgAId, "A");
  scheduleBId = await createFixtureSchedule(orgBId, "B");
});

function buildInteractiveSnapshot(
  operation: Awaited<ReturnType<typeof createOrGetGeneralInteractivePaymentOperation>>,
  context: { bowlerId: number; leagueId: number; obligationId: string; responsibilityId: string; responsibilityVersion: number; weekOf: string },
  overrides: Partial<RosterOperationSemanticSnapshot> = {},
): RosterOperationSemanticSnapshot {
  return {
    snapshotVersion: 2,
    organizationId: operation.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: context.leagueId,
    locationId: null,
    providerLocationId: null,
    payerBowlerId: context.bowlerId,
    requestKind: "direct",
    squarePaymentIdempotencyKey: deriveSquareOperationIdempotencyKey(
      operation.providerIdempotencyKey,
      "payment",
    ),
    squareOrderIdempotencyKey: null,
    sourceId: "cnon-interactive-test-source",
    customerId: null,
    buyerEmail: "interactive@example.test",
    storeCard: false,
    sourceKind: "new_card",
    quoteFingerprint: `lvrosterquote:v1:${"a".repeat(64)}`,
    allocations: [{
      allocationIndex: 0,
      bowlerId: context.bowlerId,
      amountMinor: operation.amountMinor,
      notes: "Interactive test payment",
      paidByUserId: null,
      obligationId: context.obligationId,
      responsibilityId: context.responsibilityId,
      responsibilityVersion: context.responsibilityVersion,
    }],
    lineItems: [],
    ...overrides,
  };
}

async function persistSnapshotWithReleasedReservation(
  operation: Awaited<ReturnType<typeof createOrGetGeneralInteractivePaymentOperation>>,
  snapshot: RosterOperationSemanticSnapshot,
  state: "released" | "reserved" = "released",
): Promise<RosterOperationSemanticSnapshot> {
  const allocation = snapshot.allocations[0];
  if (!allocation?.obligationId) throw new Error("snapshot fixture obligation is missing");
  const obligationId = allocation.obligationId;
  let persisted!: RosterOperationSemanticSnapshot;
  await db.transaction(async (tx) => {
    persisted = await persistRosterOperationSnapshot(operation, snapshot, tx);
    await tx.insert(paymentOperationRosterSnapshotItems).values([{
      operationId: operation.id,
      organizationId: operation.organizationId,
      leagueId: snapshot.leagueId,
      obligationId,
      allocationIndex: allocation.allocationIndex,
      amountMinor: allocation.amountMinor,
      state,
    }]).onConflictDoNothing();
  });
  return persisted;
}

describe("general interactive payment operation foundation", () => {
  it("uses a reserved target namespace and converges concurrent identical preparation", async () => {
    const requestKey = `same-request-${randomUUID()}`;
    const input = {
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    };
    const [first, second] = await Promise.all([
      createOrGetGeneralInteractivePaymentOperation(input),
      createOrGetGeneralInteractivePaymentOperation(input),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.targetKey).toBe(`interactive-charge:${requestKey}`);

    const rows = await db.select({ id: paymentOperations.id })
      .from(paymentOperations)
      .where(eq(paymentOperations.targetKey, first.targetKey));
    expect(rows).toHaveLength(1);
  });

  it("keeps genuinely new request identities separate", async () => {
    const [first, second] = await Promise.all([
      createOrGetGeneralInteractivePaymentOperation({
        organizationId: orgAId,
        leagueId: scheduleAId,
        authorizingUserId: scheduleAActorId,
        requestKey: `new-request-a-${randomUUID()}`,
        amountMinor: 2_000,
        currency: "USD",
        providerName: "square",
      }),
      createOrGetGeneralInteractivePaymentOperation({
        organizationId: orgAId,
        leagueId: scheduleAId,
        authorizingUserId: scheduleAActorId,
        requestKey: `new-request-b-${randomUUID()}`,
        amountMinor: 2_000,
        currency: "USD",
        providerName: "square",
      }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.providerIdempotencyKey).not.toBe(second.providerIdempotencyKey);
  });

  it("bounds the request key so the namespaced target fits the ledger column", async () => {
    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: "a".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH),
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).resolves.toMatchObject({
      targetKey: `interactive-charge:${"a".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH)}`,
    });

    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: "b".repeat(GENERAL_INTERACTIVE_REQUEST_KEY_MAX_LENGTH + 1),
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationValidationError);
  });

  it("fails closed when the same logical identity has different immutable contents", async () => {
    const requestKey = `mismatch-${randomUUID()}`;
    await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });

    await expect(createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey,
      amountMinor: 2_500,
      currency: "USD",
      providerName: "square",
    })).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("persists one encrypted, tenant-validated snapshot under concurrent duplicate preparation", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: `snapshot-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const context = await getScheduleContext(scheduleAId);
    const snapshot = buildInteractiveSnapshot(operation, context);

    const [first, second] = await Promise.all([
      persistSnapshotWithReleasedReservation(operation, snapshot),
      persistSnapshotWithReleasedReservation(operation, snapshot),
    ]);
    expect(first).toEqual(snapshot);
    expect(second).toEqual(snapshot);
    expect(await getRosterOperationSnapshotForOrganization(orgAId, operation.id))
      .toEqual(snapshot);
    expect(await getRosterOperationSnapshotForOrganization(orgBId, operation.id))
      .toBeUndefined();
  });

  it("rejects a changed snapshot fingerprint instead of converging silently", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: `snapshot-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const snapshot = buildInteractiveSnapshot(operation, await getScheduleContext(scheduleAId));
    await persistSnapshotWithReleasedReservation(operation, snapshot);

    await expect(persistSnapshotWithReleasedReservation(
      operation,
      { ...snapshot, sourceId: "cnon-different-source" },
    )).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("returns a deterministic fingerprint mismatch to the losing concurrent preparer", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: `concurrent-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const context = await getScheduleContext(scheduleAId);
    const firstSnapshot = buildInteractiveSnapshot(operation, context);
    const secondSnapshot = { ...firstSnapshot, buyerEmail: "different@example.test" };

    const results = await Promise.allSettled([
      persistSnapshotWithReleasedReservation(operation, firstSnapshot),
      persistSnapshotWithReleasedReservation(operation, secondSnapshot),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason : undefined)
      .toBeInstanceOf(PaymentOperationImmutableMismatchError);
  });

  it("rejects cross-tenant league, payer, and allocation references", async () => {
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: orgAId,
      leagueId: scheduleAId,
      authorizingUserId: scheduleAActorId,
      requestKey: `tenant-mismatch-${randomUUID()}`,
      amountMinor: 2_000,
      currency: "USD",
      providerName: "square",
    });
    const tenantBContext = await getScheduleContext(scheduleBId);
    const snapshot = buildInteractiveSnapshot(operation, tenantBContext);

    await expect(persistSnapshotWithReleasedReservation(
      operation,
      snapshot,
    )).rejects.toBeInstanceOf(PaymentOperationImmutableMismatchError);
    expect(await getRosterOperationSnapshotForOrganization(orgAId, operation.id))
      .toBeUndefined();
  });

});

afterAll(async () => {
  if (orgAId) await deleteOrganization(orgAId);
  if (orgBId) await deleteOrganization(orgBId);
});

describe("payment operation ledger PostgreSQL invariants", () => {
  it("allows exactly one active lease and will not steal it before expiry", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const [workerA, workerB] = await Promise.all([
      acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: "worker-a",
        leaseDurationMs: 60_000,
        now,
      }),
      acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: "worker-b",
        leaseDurationMs: 60_000,
        now,
      }),
    ]);
    expect([workerA, workerB].filter(Boolean)).toHaveLength(1);
    const winner = workerA ?? workerB;
    if (!winner) throw new Error("expected a lease winner");
    expect(winner.status).toBe("leased");
    expect(winner.attemptCount).toBe(1);

    const stolen = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-c",
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 59_999),
    });
    expect(stolen).toBeUndefined();
  });

  it("recovers an expired lease and fences the stale worker token", async () => {
    const operation = await createOperation();
    const firstNow = new Date(Date.now() + 2_000);
    const first = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-old",
      leaseDurationMs: 10_000,
      now: firstNow,
    });
    if (!first?.leaseToken) throw new Error("first lease was not acquired");

    const second = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "worker-new",
      leaseDurationMs: 10_000,
      now: new Date(firstNow.getTime() + 10_001),
    });
    if (!second?.leaseToken) throw new Error("expired lease was not recovered");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attemptCount).toBe(2);
    expect(second.leaseRecoveryCount).toBe(1);
    expect(second.lastLeaseRecoveredAt).not.toBeNull();

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: first.leaseToken,
      providerObjectId: "square-payment-stale",
      now: new Date(firstNow.getTime() + 10_002),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    const completed = await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: second.leaseToken,
      providerObjectId: "square-payment-current",
      now: new Date(firstNow.getTime() + 10_003),
    });
    expect(completed.status).toBe("succeeded");
  });

  it("persists the exact retry due time and rejects a repeated transition", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "retry-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("retry lease was not acquired");
    const nextAttemptAt = new Date(now.getTime() + 123_456);
    const retry = await schedulePaymentOperationRetry({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      nextAttemptAt,
      errorClassification: "transient",
      errorCode: "TEMPORARY_FAILURE",
      now,
    });
    expect(retry.status).toBe("retry_scheduled");
    expect(timestampToIso(retry.nextAttemptAt)).toBe(nextAttemptAt.toISOString());

    await expect(schedulePaymentOperationRetry({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      nextAttemptAt: new Date(nextAttemptAt.getTime() + 1_000),
      errorClassification: "transient",
      now,
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
  });

  it("records provider-unknown recovery and action-required terminal state", async () => {
    const operation = await createOperation();
    const firstNow = new Date(Date.now() + 2_000);
    const first = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "unknown-worker",
      leaseDurationMs: 60_000,
      now: firstNow,
    });
    if (!first?.leaseToken) throw new Error("unknown-outcome lease was not acquired");
    const recoveryAt = new Date(firstNow.getTime() + 90_000);
    const unknown = await recordPaymentOperationProviderUnknown({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: first.leaseToken,
      recoveryAt,
      errorCode: "REQUEST_TIMEOUT",
      now: firstNow,
    });
    expect(unknown.status).toBe("provider_unknown");
    expect(timestampToIso(unknown.nextAttemptAt)).toBe(recoveryAt.toISOString());

    const recovered = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "reconcile-worker",
      leaseDurationMs: 60_000,
      now: recoveryAt,
    });
    if (!recovered?.leaseToken) throw new Error("provider-unknown operation was not reclaimed");
    const actionRequired = await recordPaymentOperationActionRequired({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: recovered.leaseToken,
      errorCode: "CARD_DECLINED",
      now: new Date(recoveryAt.getTime() + 1),
    });
    expect(actionRequired.status).toBe("action_required");
    expect(actionRequired.errorClassification).toBe("hard_decline");
    expect(actionRequired.completedAt).not.toBeNull();
  });

  it("finalizes success idempotently only for the completing lease token", async () => {
    const operation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "success-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("success lease was not acquired");
    const input = {
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-idempotent",
      now: new Date(now.getTime() + 1),
    };
    const first = await finalizePaymentOperationSuccess(input);
    const replay = await finalizePaymentOperationSuccess(input);
    expect(replay.id).toBe(first.id);
    expect(replay.providerObjectId).toBe("square-payment-idempotent");
  });

  it("atomically finalizes one provider success with legitimate combined split rows", async () => {
    const operation = await createOperation();
    const context = await getScheduleContext();
    const { bowlerId, leagueId } = context;
    await persistSnapshotWithReleasedReservation(
      operation,
      buildInteractiveSnapshot(operation, context),
      "reserved",
    );
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "combined-success-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("combined success lease was not acquired");
    const providerPaymentId = "square-payment-combined";
    const paymentRows = [{
      allocationIndex: 0,
      values: await linkedPaymentValues({
        bowlerId,
        leagueId,
        amount: 2_000,
        providerPaymentId,
      }),
    }];

    await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: providerPaymentId,
      providerOrderId: "square-order-combined",
      paymentRows,
      now: new Date(now.getTime() + 1),
    });
    await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: providerPaymentId,
      providerOrderId: "square-order-combined",
      paymentRows,
      now: new Date(now.getTime() + 2),
    });

    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(2_000);
    expect(new Set(rows.map((row) => row.providerPaymentId))).toEqual(new Set([providerPaymentId]));
  });

  it("rolls back operation success when local payment persistence fails", async () => {
    const freshLeagueId = await createFixtureSchedule(orgAId, "A-local-failure");
    const operation = await createOperation(orgAId, freshLeagueId);
    const context = await getScheduleContext(freshLeagueId);
    const { bowlerId, leagueId } = context;
    await persistSnapshotWithReleasedReservation(
      operation,
      buildInteractiveSnapshot(operation, context),
      "reserved",
    );
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "local-failure-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("local failure lease was not acquired");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-local-failure",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId: 2_147_483_647,
          leagueId,
          providerPaymentId: "square-payment-local-failure",
        }),
      }],
      now: new Date(now.getTime() + 1),
    })).rejects.toBeDefined();

    const afterFailure = await getPaymentOperationForOrganization(orgAId, operation.id);
    expect(afterFailure?.status).toBe("leased");
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id)))
      .toHaveLength(0);

    const recovered = await finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      providerObjectId: "square-payment-local-failure",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId,
          leagueId,
          providerPaymentId: "square-payment-local-failure",
        }),
      }],
      now: new Date(now.getTime() + 2),
    });
    expect(recovered.status).toBe("succeeded");
  });

  it("records terminal provider decline without a payment-history row", async () => {
    const operation = await createOperation(undefined, undefined, undefined, 4_000);
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "combined-decline-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("combined decline lease was not acquired");
    const transition = {
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: leased.leaseToken,
      errorCode: "CARD_DECLINED",
      now: new Date(now.getTime() + 1),
    };
    await recordPaymentOperationActionRequired(transition);
    await recordPaymentOperationActionRequired(transition);

    const rows = await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id));
    expect(rows).toHaveLength(0);
    expect((await getPaymentOperationForOrganization(orgAId, operation.id))?.status)
      .toBe("action_required");
  });

  it("retains cancellation-review provider evidence without creating an orphan parent", async () => {
    const freshLeagueId = await createFixtureSchedule(orgAId, "A-cancellation-review");
    const operation = await createOperation(orgAId, freshLeagueId);
    const context = await getScheduleContext(freshLeagueId);
    const [location] = await db.select({ id: locations.id }).from(locations)
      .where(eq(locations.organizationId, orgAId)).limit(1);
    if (!location) throw new Error("cancellation review fixture location is missing");
    await persistSnapshotWithReleasedReservation(
      operation,
      buildInteractiveSnapshot(operation, context, { locationId: location.id }),
      "reserved",
    );
    await db.update(paymentOperations).set({
      status: "reconciliation_required",
      nextAttemptAt: null,
      errorClassification: "provider_unknown",
      errorCode: "CANCELLATION_REVIEW",
      completedAt: new Date().toISOString(),
    }).where(and(
      eq(paymentOperations.organizationId, orgAId),
      eq(paymentOperations.id, operation.id),
    ));

    const providerPaymentId = "square-payment-cancellation-review";
    const reviewed = await db.transaction((tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, {
      organizationId: orgAId,
      operationId: operation.id,
      locationId: location.id,
      providerObjectId: providerPaymentId,
      providerPaymentId,
      providerOrderId: null,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      now: new Date(Date.now() + 2_000),
    }));
    expect(reviewed.status).toBe("reconciliation_required");
    expect(reviewed.providerObjectId).toBe(providerPaymentId);
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id)))
      .toHaveLength(0);
    expect(await db.select().from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    ))).toHaveLength(1);
  });

  it("atomically terminates the eighth failed attempt and cannot be leased again", async () => {
    const operation = await createOperation();
    let cursor = new Date(Date.now() + 2_000);
    let finalStatus: Awaited<ReturnType<typeof recordPaymentOperationProviderUnknown>> | undefined;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const leased = await acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: `exhaustion-worker-${attempt}`,
        leaseDurationMs: 60_000,
        now: cursor,
      });
      if (!leased?.leaseToken) throw new Error(`attempt ${attempt} was not leased`);
      const recoveryAt = new Date(cursor.getTime() + 1_000);
      finalStatus = await recordPaymentOperationProviderUnknown({
        organizationId: orgAId,
        operationId: operation.id,
        leaseToken: leased.leaseToken,
        recoveryAt,
        errorCode: "REQUEST_TIMEOUT",
        now: cursor,
      });
      cursor = recoveryAt;
    }

    expect(finalStatus?.status).toBe("reconciliation_required");
    expect(finalStatus?.attemptCount).toBe(8);
    expect(finalStatus?.errorCode).toBe("PROVIDER_OUTCOME_UNCERTAIN");
    expect(finalStatus?.nextAttemptAt).toBeNull();
    expect(finalStatus?.completedAt).not.toBeNull();
    expect(await db.select().from(payments)
      .where(eq(payments.paymentOperationId, operation.id))).toHaveLength(0);
    expect(await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operation.id,
      leaseOwner: "ninth-worker",
      leaseDurationMs: 60_000,
      now: cursor,
    })).toBeUndefined();
  });

  it("atomically terminates an expired eighth lease and fences its stale worker", async () => {
    const operation = await createOperation();
    let cursor = new Date(Date.now() + 2_000);
    let eighthLease: Awaited<ReturnType<typeof acquirePaymentOperationLease>>;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const leased = await acquirePaymentOperationLease({
        organizationId: orgAId,
        operationId: operation.id,
        leaseOwner: `expired-exhaustion-worker-${attempt}`,
        leaseDurationMs: 1_000,
        now: cursor,
      });
      if (!leased?.leaseToken) throw new Error(`expired attempt ${attempt} was not leased`);
      if (attempt === 8) {
        eighthLease = leased;
        break;
      }
      const recoveryAt = new Date(cursor.getTime() + 1_000);
      await recordPaymentOperationProviderUnknown({
        organizationId: orgAId,
        operationId: operation.id,
        leaseToken: leased.leaseToken,
        recoveryAt,
        errorCode: "REQUEST_TIMEOUT",
        now: cursor,
      });
      cursor = recoveryAt;
    }
    if (!eighthLease?.leaseToken || !eighthLease.leaseExpiresAt) {
      throw new Error("eighth lease fixture was not created");
    }
    const expiryIso = timestampToIso(eighthLease.leaseExpiresAt);
    if (!expiryIso) throw new Error("eighth lease expiration was invalid");
    const afterExpiry = new Date(expiryIso);
    const terminal = await recordExpiredPaymentOperationAttemptExhausted({
      organizationId: orgAId,
      operationId: operation.id,
      now: afterExpiry,
    });
    expect(terminal?.status).toBe("reconciliation_required");
    expect(terminal?.errorCode).toBe("PROVIDER_OUTCOME_UNCERTAIN");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: eighthLease.leaseToken,
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    await expect(reconcilePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: randomUUID(),
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);

    const reconciled = await reconcilePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: eighthLease.leaseToken,
      providerObjectId: "square-payment-after-expired-exhaustion",
      now: new Date(afterExpiry.getTime() + 2),
    });
    expect(reconciled.status).toBe("succeeded");
  });

  it("records terminal failure and deliberate cancellation without raw error detail", async () => {
    const failedOperation = await createOperation();
    const now = new Date(Date.now() + 2_000);
    const leased = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: failedOperation.id,
      leaseOwner: "terminal-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leased?.leaseToken) throw new Error("terminal lease was not acquired");
    const failed = await recordPaymentOperationFailedTerminal({
      organizationId: orgAId,
      operationId: failedOperation.id,
      leaseToken: leased.leaseToken,
      errorClassification: "configuration",
      errorCode: "LOCATION_NOT_CONFIGURED",
      now: new Date(now.getTime() + 1),
    });
    expect(failed.status).toBe("failed_terminal");
    expect(failed.errorCode).toBe("LOCATION_NOT_CONFIGURED");

    const pendingOperation = await createOperation();
    const canceled = await cancelPaymentOperation({
      organizationId: orgAId,
      operationId: pendingOperation.id,
      now: new Date(Date.now() + 2_000),
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.errorClassification).toBeNull();
    expect(canceled.errorCode).toBeNull();
  });

  it("does not allow one tenant to read or mutate another tenant's operation", async () => {
    const operationB = await createOperation(orgBId, scheduleBId);
    expect(await getPaymentOperationForOrganization(orgAId, operationB.id)).toBeUndefined();
    expect(await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operationB.id,
      leaseOwner: "tenant-a-worker",
      leaseDurationMs: 60_000,
      now: new Date(Date.now() + 2_000),
    })).toBeUndefined();

    const leasedB = await acquirePaymentOperationLease({
      organizationId: orgBId,
      operationId: operationB.id,
      leaseOwner: "tenant-b-worker",
      leaseDurationMs: 60_000,
      now: new Date(Date.now() + 2_000),
    });
    if (!leasedB?.leaseToken) throw new Error("tenant B lease was not acquired");
    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operationB.id,
      leaseToken: leasedB.leaseToken,
      providerObjectId: "square-payment-cross-tenant",
    })).rejects.toBeInstanceOf(PaymentOperationNotFoundError);
  });

  it("rolls back finalization when linked payment rows belong to another tenant", async () => {
    const operationA = await createOperation();
    const tenantBPayment = await getScheduleContext(scheduleBId);
    const now = new Date(Date.now() + 2_000);
    const leasedA = await acquirePaymentOperationLease({
      organizationId: orgAId,
      operationId: operationA.id,
      leaseOwner: "tenant-row-guard-worker",
      leaseDurationMs: 60_000,
      now,
    });
    if (!leasedA?.leaseToken) throw new Error("tenant row guard lease was not acquired");

    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operationA.id,
      leaseToken: leasedA.leaseToken,
      providerObjectId: "square-payment-cross-tenant-row",
      paymentRows: [{
        allocationIndex: 0,
        values: await linkedPaymentValues({
          bowlerId: tenantBPayment.bowlerId,
          leagueId: tenantBPayment.leagueId,
          providerPaymentId: "square-payment-cross-tenant-row",
        }),
      }],
      now: new Date(now.getTime() + 1),
    })).rejects.toBeInstanceOf(PaymentOperationValidationError);

    expect((await getPaymentOperationForOrganization(orgAId, operationA.id))?.status)
      .toBe("leased");
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operationA.id)))
      .toHaveLength(0);
  });

  it("rejects terminal finalization from pending without a lease", async () => {
    const operation = await createOperation();
    await expect(finalizePaymentOperationSuccess({
      organizationId: orgAId,
      operationId: operation.id,
      leaseToken: randomUUID(),
      providerObjectId: "square-payment-no-lease",
    })).rejects.toBeInstanceOf(PaymentOperationInvalidTransitionError);
  });
});
