import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  leagueOccurrences,
  leagues,
  leagueScheduleCommands,
  locations,
  occurrenceCollectionPlanRevisions,
  occurrenceCollectionPlans,
  organizations,
  paymentOperations,
  users,
} from "@shared/schema";
import { recordCanonicalAutopayPreDispatchFailure } from "../../server/storage/payment-operations";

const db = getTestDb();
let organizationId: number;
let operationId: string;
let planId: string;
let leaseToken: string;

async function makeFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [organization] = await db.insert(organizations).values({ name: `F4 race ${suffix}`, slug: `f4-race-${suffix}` }).returning({ id: organizations.id });
  const [actor] = await db.insert(users).values({ email: `f4-race-${suffix}@example.test`, password: "test", name: "F4 race actor", role: "org_admin", organizationId: organization.id }).returning({ id: users.id });
  const [location] = await db.insert(locations).values({ name: "F4 race location", organizationId: organization.id }).returning({ id: locations.id });
  const [league] = await db.insert(leagues).values({ name: `F4 race league ${suffix}`, organizationId: organization.id, locationId: location.id, seasonStart: "2038-01-01", seasonEnd: "2038-12-31", weekDay: "Sunday", competitionStartTime: "19:00", timezone: "UTC", totalBowlingWeeks: 2, weeklyFee: 500, paymentMode: "weekly" }).returning({ id: leagues.id });
  const [command] = await db.insert(leagueScheduleCommands).values({ organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, commandType: "publish", reason: "F4 race fixture", idempotencyKey: `f4-race-publish-${suffix}`, requestFingerprint: `lvf4race:${suffix}` }).returning({ id: leagueScheduleCommands.id });
  const [occurrence] = await db.insert(leagueOccurrences).values({ organizationId: organization.id, leagueId: league.id, locationId: location.id, generationKey: `f4-race-occurrence-${suffix}`, kind: "regular", status: "scheduled", lifecycle: "published", authoritativeLocalDate: "2038-02-01", authoritativeLocalStartTime: "19:00:00", timezone: "UTC", startAt: "2038-02-01T19:00:00.000Z", selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous", resolverVersion: "f4-race/1", plannedOrdinal: 1, competitionNumber: 1, currentRevision: 1, lastCommandId: command.id, publishedAt: "2037-12-01T00:00:00.000Z", publishedByUserId: actor.id, publicationCommandId: command.id }).returning({ id: leagueOccurrences.id });
  const [plan] = await db.insert(occurrenceCollectionPlans).values({ organizationId: organization.id, leagueId: league.id, planKey: `f4-race-plan-${suffix}`, triggerOccurrenceId: occurrence.id, currency: "USD", state: "ready", version: 1, currentRevision: 1, recordedByUserId: actor.id }).returning({ id: occurrenceCollectionPlans.id });
  const token = randomUUID();
  const [operation] = await db.insert(paymentOperations).values({ organizationId: organization.id, authorizingUserId: actor.id, operationType: "canonical_autopay_charge", targetKey: `canonical-autopay-plan:${plan.id}`, leagueId: league.id, canonicalPlanId: plan.id, triggerOccurrenceId: occurrence.id, amountMinor: 500, currency: "USD", requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`, providerIdempotencyKey: `lv-f4-pay-${suffix}`.slice(0, 45), providerName: "square", status: "leased", attemptCount: 1, nextAttemptAt: null, leaseOwner: "f4-test", leaseToken: token, leaseExpiresAt: "2038-02-01T20:00:00.000Z", startedAt: "2038-02-01T19:00:00.000Z" }).returning({ id: paymentOperations.id });
  return { organizationId: organization.id, leagueId: league.id, operationId: operation.id, planId: plan.id, leaseToken: token };
}

describe("F4 canonical pre-dispatch PostgreSQL serialization", () => {
  beforeAll(async () => {
    const fixture = await makeFixture();
    organizationId = fixture.organizationId;
    operationId = fixture.operationId;
    planId = fixture.planId;
    leaseToken = fixture.leaseToken;
  });

  afterAll(async () => {
    if (operationId) await db.delete(paymentOperations).where(and(eq(paymentOperations.id, operationId), eq(paymentOperations.organizationId, organizationId)));
    if (organizationId) await deleteOrganization(organizationId);
  });

  it("cancels the exact ready plan and writes a revision on deterministic drift", async () => {
    const result = await recordCanonicalAutopayPreDispatchFailure({ organizationId, operationId, leaseToken, errorCode: "F4_PROVIDER_LOCATION_DRIFT", now: new Date("2038-02-01T19:00:01.000Z") });
    expect(result?.status).toBe("failed_terminal");
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, planId), eq(occurrenceCollectionPlans.organizationId, organizationId)));
    expect(plan?.state).toBe("cancelled");
    expect(await db.select().from(occurrenceCollectionPlanRevisions).where(and(eq(occurrenceCollectionPlanRevisions.planId, planId), eq(occurrenceCollectionPlanRevisions.organizationId, organizationId)))).toHaveLength(1);
  });

  it("serializes competing failure attempts without duplicate cancellation revisions", async () => {
    const second = await makeFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${second.organizationId}::integer, ${second.leagueId}::integer)`);
      await held;
    });
    const calls = Promise.all([
      recordCanonicalAutopayPreDispatchFailure({ organizationId: second.organizationId, operationId: second.operationId, leaseToken: second.leaseToken, errorCode: "F4_EVIDENCE_DRIFT", now: new Date("2038-02-01T19:00:01.000Z") }),
      recordCanonicalAutopayPreDispatchFailure({ organizationId: second.organizationId, operationId: second.operationId, leaseToken: second.leaseToken, errorCode: "F4_EVIDENCE_DRIFT", now: new Date("2038-02-01T19:00:02.000Z") }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results = await calls;
    await blocker;
    expect(results.filter(Boolean)).toHaveLength(1);
    const revisions = await db.select().from(occurrenceCollectionPlanRevisions).where(and(eq(occurrenceCollectionPlanRevisions.planId, second.planId), eq(occurrenceCollectionPlanRevisions.organizationId, second.organizationId)));
    expect(revisions).toHaveLength(1);
    await db.delete(paymentOperations).where(and(eq(paymentOperations.organizationId, second.organizationId), eq(paymentOperations.id, second.operationId)));
    await deleteOrganization(second.organizationId);
  });
});
