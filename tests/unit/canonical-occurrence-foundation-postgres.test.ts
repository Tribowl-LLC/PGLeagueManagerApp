import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationshipRevisions,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

interface Fixture {
  organizationId: number;
  leagueId: number;
  locationId: number;
  actorUserId: number;
}

let fixtureA: Fixture | undefined;
let teardownFixture: Fixture | undefined;
let fixtureB: Fixture | undefined;

async function createFixture(label: string): Promise<Fixture> {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `A1 ${label}`, slug: `a1-${label.toLowerCase()}-${suffix}` })
    .returning({ id: organizations.id });
  if (!organization) throw new Error("A1 organization fixture was not created");

  const [actor] = await db
    .insert(users)
    .values({
      email: `a1-${label.toLowerCase()}-${suffix}@example.test`,
      password: "a1-test-password-hash",
      name: `A1 ${label} system administrator`,
      role: "system_admin",
      organizationId: organization.id,
    })
    .returning({ id: users.id });
  if (!actor) throw new Error("A1 actor fixture was not created");

  const [location] = await db
    .insert(locations)
    .values({ name: `A1 ${label} location`, organizationId: organization.id })
    .returning({ id: locations.id });
  if (!location) throw new Error("A1 location fixture was not created");

  const [league] = await db
    .insert(leagues)
    .values({
      name: `A1 ${label} league`,
      organizationId: organization.id,
      locationId: location.id,
      seasonStart: "2032-01-01",
      seasonEnd: "2032-12-31",
      weekDay: "Sunday",
      timezone: "America/New_York",
    })
    .returning({ id: leagues.id });
  if (!league) throw new Error("A1 league fixture was not created");

  return {
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    actorUserId: actor.id,
  };
}

async function createCommand(
  fixture: Fixture,
  commandType: "generate" | "discard_draft" | "publish" | "cancel" | "create_exception" | "create_makeup_relationship" | "revise_billing_terms",
  key: string,
  reason?: string,
) {
  const [command] = await db
    .insert(leagueScheduleCommands)
    .values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      actorUserId: fixture.actorUserId,
      commandType,
      reason,
      idempotencyKey: `${key}-${suffix}`,
      requestFingerprint: `a1:${key}:${suffix}`,
    })
    .returning();
  if (!command) throw new Error(`A1 command ${key} was not created`);
  return command;
}

async function createRun(fixture: Fixture, commandId: string, inputFingerprint: string, sourceRevision: number) {
  const [run] = await db
    .insert(leagueOccurrenceGenerationRuns)
    .values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      originatingCommandId: commandId,
      generatorVersion: "a1-test-generator",
      inputFingerprint,
      sourceScheduleRevision: sourceRevision,
      normalizedInputSnapshot: { weekDay: "Sunday", sourceRevision },
      rangeStartDate: "2032-01-01",
      rangeEndDate: "2032-12-31",
      candidateOccurrenceCount: 1,
      generatedOccurrenceCount: 1,
    })
    .returning();
  if (!run) throw new Error("A1 generation run was not created");
  return run;
}

function occurrenceValues(fixture: Fixture, key: string, runId: string, commandId: string) {
  return {
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    locationId: fixture.locationId,
    generationKey: `${key}-${suffix}`,
    generationRunId: runId,
    kind: "regular" as const,
    status: "scheduled" as const,
    lifecycle: "draft" as const,
    authoritativeLocalDate: "2032-03-14",
    authoritativeLocalStartTime: "02:30:00",
    timezone: "America/New_York",
    startAt: "2032-03-14T07:30:00.000Z",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous" as const,
    resolverVersion: "a1-structural-test",
    currentRevision: 1,
    lastCommandId: commandId,
  };
}

beforeAll(async () => {
  fixtureA = await createFixture("Foundation");
  teardownFixture = await createFixture("Teardown");
  fixtureB = await createFixture("OtherTenant");
});

afterAll(async () => {
  for (const fixture of [fixtureA, teardownFixture, fixtureB]) {
    if (!fixture) continue;
    await deleteOrganization(fixture.organizationId).catch(() => undefined);
    await db.delete(users).where(eq(users.id, fixture.actorUserId)).catch(() => undefined);
  }
});

describe("canonical occurrence A1 PostgreSQL contract", () => {
  it("supports revision-context replay and atomically rolls back a modeled draft discard", async () => {
    const fixture = fixtureA;
    if (!fixture) throw new Error("foundation fixture is missing");
    const generateCommand = await createCommand(fixture, "generate", "generate-a");
    const runA = await createRun(fixture, generateCommand.id, "input-a", 1);
    const [occurrence] = await db
      .insert(leagueOccurrences)
      .values(occurrenceValues(fixture, "draft", runA.id, generateCommand.id))
      .returning();
    if (!occurrence) throw new Error("draft occurrence was not created");

    const [term] = await db
      .insert(leagueOccurrenceBillingTerms)
      .values({
        organizationId: fixture.organizationId,
        leagueId: fixture.leagueId,
        occurrenceId: occurrence.id,
        purpose: "league_weekly_fee",
        obligationPolicy: "eligible_bowlers",
        defaultAmountMinor: 100,
        currency: "USD",
        billingOrdinal: 1,
        version: 1,
      })
      .returning();
    if (!term) throw new Error("draft billing term was not created");

    await db.insert(leagueOccurrenceRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: occurrence.id,
      commandId: generateCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { status: "scheduled", plannedOrdinal: null, competitionNumber: null },
    });
    await db.insert(leagueOccurrenceBillingTermRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      billingTermId: term.id,
      commandId: generateCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "draft", defaultAmountMinor: 100 },
    });

    const runB = await createRun(fixture, generateCommand.id, "input-b", 2);
    const runAAgain = await createRun(fixture, generateCommand.id, "input-a", 3);
    expect(runB.sourceScheduleRevision).toBe(2);
    expect(runAAgain.sourceScheduleRevision).toBe(3);

    const discardCommand = await createCommand(
      fixture,
      "discard_draft",
      "discard-draft",
      "The provisional generated session is intentionally discarded.",
    );
    await expect(db.transaction(async (tx) => {
      await tx
        .update(leagueOccurrences)
        .set({
          status: "discarded",
          plannedOrdinal: null,
          competitionNumber: null,
          currentRevision: 2,
          discardedAt: "2032-01-02T12:00:00.000Z",
          discardedByUserId: fixture.actorUserId,
          discardCommandId: discardCommand.id,
        })
        .where(eq(leagueOccurrences.id, occurrence.id));
      await tx
        .update(leagueOccurrenceBillingTerms)
        .set({
          state: "superseded",
          supersededAt: "2032-01-02T12:00:00.000Z",
          supersededByCommandId: discardCommand.id,
        })
        .where(and(
          eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId),
          eq(leagueOccurrenceBillingTerms.leagueId, fixture.leagueId),
          eq(leagueOccurrenceBillingTerms.occurrenceId, occurrence.id),
          eq(leagueOccurrenceBillingTerms.state, "draft"),
        ));
      await tx.insert(leagueOccurrenceRevisions).values({
        organizationId: fixture.organizationId,
        leagueId: fixture.leagueId,
        occurrenceId: occurrence.id,
        commandId: discardCommand.id,
        revisionNumber: 2,
        snapshotSchemaVersion: 1,
        beforeSnapshot: { status: "scheduled" },
        afterSnapshot: { status: "discarded", plannedOrdinal: null, competitionNumber: null },
      });
      await tx.insert(leagueOccurrenceBillingTermRevisions).values({
        organizationId: fixture.organizationId,
        leagueId: fixture.leagueId,
        billingTermId: term.id,
        commandId: discardCommand.id,
        revisionNumber: 2,
        snapshotSchemaVersion: 1,
        beforeSnapshot: { state: "draft" },
        afterSnapshot: { state: "superseded" },
      });
      throw new Error("intentional A1 transaction failure");
    })).rejects.toThrow("intentional A1 transaction failure");

    const [occurrenceAfter] = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, occurrence.id));
    const [termAfter] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    const occurrenceRevisions = await db
      .select()
      .from(leagueOccurrenceRevisions)
      .where(eq(leagueOccurrenceRevisions.occurrenceId, occurrence.id));
    const termRevisions = await db
      .select()
      .from(leagueOccurrenceBillingTermRevisions)
      .where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id));
    if (!occurrenceAfter || !termAfter) throw new Error("discard rows disappeared unexpectedly");
    expect(occurrenceAfter.status).toBe("scheduled");
    expect(occurrenceAfter.currentRevision).toBe(1);
    expect(termAfter.state).toBe("draft");
    expect(occurrenceRevisions).toHaveLength(1);
    expect(termRevisions).toHaveLength(1);

    await expect(db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 200,
      currency: "USD",
      billingOrdinal: 2,
      version: 2,
    })).rejects.toThrow();
  });

  it("accepts structural DST fields without asserting timezone coherence", async () => {
    const fixture = fixtureA;
    if (!fixture) throw new Error("foundation fixture is missing");
    const command = await createCommand(fixture, "generate", "dst-structure");
    const run = await createRun(fixture, command.id, "dst-input", 4);
    const [row] = await db
      .insert(leagueOccurrences)
      .values(occurrenceValues(fixture, "dst-gap-shaped", run.id, command.id))
      .returning();
    if (!row) throw new Error("structural DST occurrence was not created");
    expect(row.authoritativeLocalDate).toBe("2032-03-14");
    expect(row.authoritativeLocalStartTime).toBe("02:30:00");
    expect(row.timezone).toBe("America/New_York");
    expect(row.selectedUtcOffsetMinutes).toBe(-300);
    expect(row.foldResolution).toBe("unambiguous");
    expect(row.startAt).toContain("2032-03-14");
  });

  it("rejects noncompetitive standings rows and cross-tenant composite references", async () => {
    const fixture = fixtureA;
    const other = fixtureB;
    if (!fixture || !other) throw new Error("tenant fixtures are missing");
    const command = await createCommand(fixture, "generate", "tenant-check");
    const run = await createRun(fixture, command.id, "tenant-input", 5);
    await expect(db.insert(leagueOccurrences).values({
      ...occurrenceValues(fixture, "invalid-standings", run.id, command.id),
      competitive: false,
      countsInStandings: true,
    })).rejects.toThrow();

    await expect(db.insert(leagueScheduleCommands).values({
      organizationId: other.organizationId,
      leagueId: fixture.leagueId,
      actorUserId: other.actorUserId,
      commandType: "generate",
      idempotencyKey: `cross-tenant-${suffix}`,
      requestFingerprint: `cross-tenant:${suffix}`,
    })).rejects.toThrow();
  });
});

describe("A1 organization teardown and parent deletion", () => {
  it("restricts normal parent deletion, rolls back a failed teardown, then removes all A1 rows", async () => {
    const fixture = teardownFixture;
    const other = fixtureB;
    if (!fixture || !other) throw new Error("teardown fixtures are missing");
    const generateCommand = await createCommand(fixture, "generate", "teardown-generate");
    const publishCommand = await createCommand(fixture, "publish", "teardown-publish");
    const cancelCommand = await createCommand(fixture, "cancel", "teardown-cancel", "The physical session was cancelled.");
    const exceptionCommand = await createCommand(fixture, "create_exception", "teardown-exception");
    const relationshipCommand = await createCommand(fixture, "create_makeup_relationship", "teardown-relationship");
    const billingCommand = await createCommand(fixture, "revise_billing_terms", "teardown-billing");
    const run = await createRun(fixture, generateCommand.id, "teardown-input", 1);

    const [exception] = await db.insert(leagueScheduleExceptions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      kind: "skip",
      localDate: "2032-04-04",
      timezone: "America/New_York",
      source: "generator",
      lifecycle: "published",
      reason: "A1 teardown representative skip",
      generationRunId: run.id,
      currentRevision: 1,
      lastCommandId: exceptionCommand.id,
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: exceptionCommand.id,
    }).returning();
    if (!exception) throw new Error("teardown exception was not created");

    const [source] = await db.insert(leagueOccurrences).values({
      ...occurrenceValues(fixture, "teardown-makeup", run.id, publishCommand.id),
      kind: "makeup",
      lifecycle: "published",
      plannedOrdinal: 1,
      competitionNumber: 1,
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: publishCommand.id,
      startAt: "2032-04-11T16:00:00.000Z",
    }).returning();
    const [target] = await db.insert(leagueOccurrences).values({
      ...occurrenceValues(fixture, "teardown-cancelled", run.id, cancelCommand.id),
      lifecycle: "published",
      status: "cancelled",
      plannedOrdinal: 2,
      competitionNumber: 2,
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: publishCommand.id,
      cancelledAt: "2032-01-03T12:00:00.000Z",
      cancelledByUserId: fixture.actorUserId,
      cancellationCommandId: cancelCommand.id,
      startAt: "2032-04-18T16:00:00.000Z",
    }).returning();
    if (!source || !target) throw new Error("teardown occurrences were not created");

    const [sourceTerm] = await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: source.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "none",
      defaultAmountMinor: 0,
      currency: "USD",
      version: 1,
      state: "published",
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: billingCommand.id,
    }).returning();
    const [targetTerm] = await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: target.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 100,
      currency: "USD",
      billingOrdinal: 1,
      version: 1,
      state: "published",
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: billingCommand.id,
    }).returning();
    if (!sourceTerm || !targetTerm) throw new Error("teardown billing terms were not created");

    const [relationship] = await db.insert(leagueOccurrenceRelationships).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      kind: "makeup_for",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: target.id,
      state: "published",
      publishedAt: "2032-01-02T12:00:00.000Z",
      publishedByUserId: fixture.actorUserId,
      publicationCommandId: relationshipCommand.id,
    }).returning();
    if (!relationship) throw new Error("teardown relationship was not created");

    await db.insert(leagueOccurrenceRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      occurrenceId: source.id,
      commandId: publishCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { lifecycle: "published", plannedOrdinal: 1 },
    });
    await db.insert(leagueScheduleExceptionRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      exceptionId: exception.id,
      commandId: exceptionCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { lifecycle: "published", localDate: "2032-04-04" },
    });
    await db.insert(leagueOccurrenceRelationshipRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      relationshipId: relationship.id,
      commandId: relationshipCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { kind: "makeup_for", sourceOccurrenceId: source.id, targetOccurrenceId: target.id },
    });
    await db.insert(leagueOccurrenceBillingTermRevisions).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      billingTermId: sourceTerm.id,
      commandId: billingCommand.id,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "published", obligationPolicy: "none" },
    });
    await db.insert(leagueOccurrenceGenerationDiscrepancies).values({
      organizationId: fixture.organizationId,
      leagueId: fixture.leagueId,
      generationRunId: run.id,
      severity: "warning",
      code: "weekday_mismatch",
      generationKey: source.generationKey,
      details: { note: "sanitized test detail" },
    });

    await expect(db.delete(leagues).where(eq(leagues.id, fixture.leagueId))).rejects.toThrow();
    await expect(db.delete(locations).where(eq(locations.id, fixture.locationId))).rejects.toThrow();

    await db.execute(sql`CREATE OR REPLACE FUNCTION a1_test_teardown_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional A1 teardown failure'; END; $$`);
    await db.execute(sql`CREATE TRIGGER a1_test_teardown_failure_trigger
      BEFORE DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION a1_test_teardown_failure()`);
    try {
      await expect(deleteOrganization(fixture.organizationId)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS a1_test_teardown_failure_trigger ON organizations`);
      await db.execute(sql`DROP FUNCTION IF EXISTS a1_test_teardown_failure()`);
    }

    const [organizationAfterFailure] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    const [actorAfterFailure] = await db.select().from(users).where(eq(users.id, fixture.actorUserId));
    const [occurrenceAfterFailure] = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, source.id));
    const [termAfterFailure] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, sourceTerm.id));
    expect(organizationAfterFailure?.id).toBe(fixture.organizationId);
    expect(actorAfterFailure?.organizationId).toBe(fixture.organizationId);
    expect(occurrenceAfterFailure?.id).toBe(source.id);
    expect(termAfterFailure?.id).toBe(sourceTerm.id);

    await expect(db.insert(leagueScheduleCommands).values({
      organizationId: other.organizationId,
      leagueId: fixture.leagueId,
      actorUserId: other.actorUserId,
      commandType: "generate",
      idempotencyKey: `teardown-cross-tenant-${suffix}`,
      requestFingerprint: `teardown-cross-tenant:${suffix}`,
    })).rejects.toThrow();

    await deleteOrganization(fixture.organizationId);
    const [deletedOrganization] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    const [preservedActor] = await db.select().from(users).where(eq(users.id, fixture.actorUserId));
    expect(deletedOrganization).toBeUndefined();
    expect(preservedActor?.organizationId).toBeNull();
    expect(await db.select({ id: leagueScheduleCommands.id }).from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceGenerationRuns.id }).from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueScheduleExceptions.id }).from(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(eq(leagueOccurrences.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceBillingTerms.id }).from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceRelationships.id }).from(leagueOccurrenceRelationships).where(eq(leagueOccurrenceRelationships.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceRevisions.id }).from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueScheduleExceptionRevisions.id }).from(leagueScheduleExceptionRevisions).where(eq(leagueScheduleExceptionRevisions.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceRelationshipRevisions.id }).from(leagueOccurrenceRelationshipRevisions).where(eq(leagueOccurrenceRelationshipRevisions.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceBillingTermRevisions.id }).from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select({ id: leagueOccurrenceGenerationDiscrepancies.id }).from(leagueOccurrenceGenerationDiscrepancies).where(eq(leagueOccurrenceGenerationDiscrepancies.organizationId, fixture.organizationId))).toHaveLength(0);
  });
});
