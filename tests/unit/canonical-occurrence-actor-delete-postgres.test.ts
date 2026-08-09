import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { deleteUser, UserHasAuditTrailError } from "../../server/storage/users";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  leagueId: number;
  locationId: number;
  commonActorId: number;
}

async function createFixture(): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `A1 actor deletion ${suffix}`,
    slug: `a1-actor-deletion-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("actor deletion organization was not created");
  organizationIds.push(organization.id);

  const [commonActor] = await db.insert(users).values({
    email: `a1-actor-common-${suffix}@example.test`,
    password: "test-password-hash",
    name: "A1 actor common fixture",
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!commonActor) throw new Error("common actor was not created");

  const [location] = await db.insert(locations).values({
    name: "A1 actor deletion location",
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("actor deletion location was not created");

  const [league] = await db.insert(leagues).values({
    name: "A1 actor deletion league",
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2035-01-01",
    seasonEnd: "2035-12-31",
    weekDay: "Sunday",
    timezone: "America/New_York",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("actor deletion league was not created");

  return {
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    commonActorId: commonActor.id,
  };
}

async function actor(f: Fixture, label: string): Promise<number> {
  const [user] = await db.insert(users).values({
    email: `a1-actor-${label}-${suffix}@example.test`,
    password: "test-password-hash",
    name: `A1 actor ${label}`,
    role: "user",
    organizationId: f.organizationId,
  }).returning({ id: users.id });
  if (!user) throw new Error(`actor ${label} was not created`);
  return user.id;
}

async function command(f: Fixture, key: string) {
  const [row] = await db.insert(leagueScheduleCommands).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    actorUserId: f.commonActorId,
    commandType: "generate",
    idempotencyKey: `a1-actor-${key}-${suffix}`,
    requestFingerprint: `a1-actor:${key}:${suffix}`,
  }).returning();
  if (!row) throw new Error(`command ${key} was not created`);
  return row;
}

async function generationRun(f: Fixture, key: string, commandId: string, values: Record<string, unknown>) {
  const [row] = await db.insert(leagueOccurrenceGenerationRuns).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    originatingCommandId: commandId,
    generatorVersion: "a1-actor-delete-test",
    inputFingerprint: `a1-actor-input-${key}-${suffix}`,
    sourceScheduleRevision: ++sequence,
    normalizedInputSnapshot: { key },
    rangeStartDate: "2035-01-01",
    rangeEndDate: "2035-12-31",
    ...values,
  }).returning();
  if (!row) throw new Error(`generation run ${key} was not created`);
  return row;
}

async function occurrence(
  f: Fixture,
  key: string,
  commandId: string,
  values: Record<string, unknown> = {},
) {
  const occurrenceOrdinal = ++sequence;
  const [row] = await db.insert(leagueOccurrences).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    locationId: f.locationId,
    generationKey: `a1-actor-occurrence-${key}-${suffix}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: `2035-02-${String(10 + occurrenceOrdinal).padStart(2, "0")}`,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/New_York",
    startAt: `2035-02-${String(10 + occurrenceOrdinal).padStart(2, "0")}T00:00:00.000Z`,
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous",
    resolverVersion: "a1-actor-structural-test",
    plannedOrdinal: occurrenceOrdinal,
    competitionNumber: null,
    competitive: false,
    countsInStandings: false,
    currentRevision: 1,
    lastCommandId: commandId,
    ...values,
  }).returning();
  if (!row) throw new Error(`occurrence ${key} was not created`);
  return row;
}

async function assertRefusesDelete(userId: number): Promise<void> {
  await expect(deleteUser(userId)).rejects.toBeInstanceOf(UserHasAuditTrailError);
  expect((await db.select({ id: users.id }).from(users).where(eq(users.id, userId)))[0]?.id)
    .toBe(userId);
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("A1 actor references refuse ordinary user deletion", () => {
  it("covers every restrictive current-row actor column with the typed refusal", async () => {
    const f = await createFixture();

    const commandActorId = await actor(f, "command");
    await db.insert(leagueScheduleCommands).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: commandActorId,
      commandType: "generate",
      idempotencyKey: `a1-actor-command-${suffix}`,
      requestFingerprint: `a1-actor-command:${suffix}`,
    });
    await assertRefusesDelete(commandActorId);

    const approvedByUserId = await actor(f, "generation-approved");
    const approvedCommand = await command(f, "generation-approved");
    await generationRun(f, "approved", approvedCommand.id, {
      state: "approved",
      approvedAt: "2035-01-02T00:00:00.000Z",
      approvedByUserId,
      approvalCommandId: approvedCommand.id,
    });
    await assertRefusesDelete(approvedByUserId);

    const rejectedByUserId = await actor(f, "generation-rejected");
    const rejectedCommand = await command(f, "generation-rejected");
    await generationRun(f, "rejected", rejectedCommand.id, {
      state: "rejected",
      rejectedAt: "2035-01-03T00:00:00.000Z",
      rejectedByUserId,
      rejectionReason: "A1 actor test rejection",
      rejectionCommandId: rejectedCommand.id,
    });
    await assertRefusesDelete(rejectedByUserId);

    const publishedByUserId = await actor(f, "occurrence-published");
    const publishedCommand = await command(f, "occurrence-published");
    await occurrence(f, "published", publishedCommand.id, {
      lifecycle: "published",
      publishedAt: "2035-01-04T00:00:00.000Z",
      publishedByUserId,
      publicationCommandId: publishedCommand.id,
    });
    await assertRefusesDelete(publishedByUserId);

    const lockedByUserId = await actor(f, "occurrence-locked");
    const lockedCommand = await command(f, "occurrence-locked");
    await occurrence(f, "locked", lockedCommand.id, {
      lifecycle: "locked",
      publishedAt: "2035-01-05T00:00:00.000Z",
      publishedByUserId: f.commonActorId,
      publicationCommandId: lockedCommand.id,
      lockedAt: "2035-01-05T01:00:00.000Z",
      lockedByUserId,
      lockReason: "A1 actor test lock",
      lockCommandId: lockedCommand.id,
    });
    await assertRefusesDelete(lockedByUserId);

    const cancelledByUserId = await actor(f, "occurrence-cancelled");
    const cancelledCommand = await command(f, "occurrence-cancelled");
    await occurrence(f, "cancelled", cancelledCommand.id, {
      lifecycle: "published",
      status: "cancelled",
      publishedAt: "2035-01-06T00:00:00.000Z",
      publishedByUserId: f.commonActorId,
      publicationCommandId: cancelledCommand.id,
      cancelledAt: "2035-01-06T01:00:00.000Z",
      cancelledByUserId,
      cancellationCommandId: cancelledCommand.id,
    });
    await assertRefusesDelete(cancelledByUserId);

    const completedByUserId = await actor(f, "occurrence-completed");
    const completedCommand = await command(f, "occurrence-completed");
    await occurrence(f, "completed", completedCommand.id, {
      lifecycle: "locked",
      status: "completed",
      publishedAt: "2035-01-07T00:00:00.000Z",
      publishedByUserId: f.commonActorId,
      publicationCommandId: completedCommand.id,
      lockedAt: "2035-01-07T01:00:00.000Z",
      lockedByUserId: f.commonActorId,
      lockReason: "A1 actor test lock",
      lockCommandId: completedCommand.id,
      completedAt: "2035-01-07T02:00:00.000Z",
      completedByUserId,
      completionCommandId: completedCommand.id,
    });
    await assertRefusesDelete(completedByUserId);

    const discardedByUserId = await actor(f, "occurrence-discarded");
    const discardedCommand = await command(f, "occurrence-discarded");
    await occurrence(f, "discarded", discardedCommand.id, {
      lifecycle: "draft",
      status: "discarded",
      discardedAt: "2035-01-08T00:00:00.000Z",
      discardedByUserId,
      discardCommandId: discardedCommand.id,
      plannedOrdinal: null,
      competitionNumber: null,
    });
    await assertRefusesDelete(discardedByUserId);

    const exceptionPublishedByUserId = await actor(f, "exception-published");
    const exceptionPublishedCommand = await command(f, "exception-published");
    await db.insert(leagueScheduleExceptions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "skip",
      localDate: "2035-03-01",
      timezone: "America/New_York",
      source: "manual",
      lifecycle: "published",
      reason: "A1 actor test exception",
      currentRevision: 1,
      lastCommandId: exceptionPublishedCommand.id,
      publishedAt: "2035-01-09T00:00:00.000Z",
      publishedByUserId: exceptionPublishedByUserId,
      publicationCommandId: exceptionPublishedCommand.id,
    });
    await assertRefusesDelete(exceptionPublishedByUserId);

    const exceptionRevokedByUserId = await actor(f, "exception-revoked");
    const exceptionRevokedCommand = await command(f, "exception-revoked");
    await db.insert(leagueScheduleExceptions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "skip",
      localDate: "2035-03-02",
      timezone: "America/New_York",
      source: "manual",
      lifecycle: "revoked",
      reason: "A1 actor test revoked exception",
      currentRevision: 1,
      lastCommandId: exceptionRevokedCommand.id,
      publishedAt: "2035-01-10T00:00:00.000Z",
      publishedByUserId: f.commonActorId,
      publicationCommandId: exceptionRevokedCommand.id,
      revokedAt: "2035-01-11T00:00:00.000Z",
      revokedByUserId: exceptionRevokedByUserId,
      revocationCommandId: exceptionRevokedCommand.id,
    });
    await assertRefusesDelete(exceptionRevokedByUserId);

    const relationshipPublishedByUserId = await actor(f, "relationship-published");
    const relationshipPublishedCommand = await command(f, "relationship-published");
    const relationshipSource = await occurrence(f, "relationship-source", relationshipPublishedCommand.id);
    const relationshipTarget = await occurrence(f, "relationship-target", relationshipPublishedCommand.id);
    await db.insert(leagueOccurrenceRelationships).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "makeup_for",
      sourceOccurrenceId: relationshipSource.id,
      targetOccurrenceId: relationshipTarget.id,
      state: "published",
      currentRevision: 1,
      lastCommandId: relationshipPublishedCommand.id,
      publishedAt: "2035-01-12T00:00:00.000Z",
      publishedByUserId: relationshipPublishedByUserId,
      publicationCommandId: relationshipPublishedCommand.id,
    });
    await assertRefusesDelete(relationshipPublishedByUserId);

    const relationshipRevokedByUserId = await actor(f, "relationship-revoked");
    const relationshipRevokedCommand = await command(f, "relationship-revoked");
    const revokedSource = await occurrence(f, "revoked-source", relationshipRevokedCommand.id);
    const revokedTarget = await occurrence(f, "revoked-target", relationshipRevokedCommand.id);
    await db.insert(leagueOccurrenceRelationships).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "makeup_for",
      sourceOccurrenceId: revokedSource.id,
      targetOccurrenceId: revokedTarget.id,
      state: "revoked",
      currentRevision: 1,
      lastCommandId: relationshipRevokedCommand.id,
      publishedAt: "2035-01-13T00:00:00.000Z",
      publishedByUserId: f.commonActorId,
      publicationCommandId: relationshipRevokedCommand.id,
      revokedAt: "2035-01-14T00:00:00.000Z",
      revokedByUserId: relationshipRevokedByUserId,
      revocationCommandId: relationshipRevokedCommand.id,
    });
    await assertRefusesDelete(relationshipRevokedByUserId);

    const billingPublishedByUserId = await actor(f, "billing-published");
    const billingCommand = await command(f, "billing-published");
    const billingOccurrence = await occurrence(f, "billing", billingCommand.id);
    await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      occurrenceId: billingOccurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "none",
      defaultAmountMinor: 0,
      currency: "USD",
      billingOrdinal: null,
      version: 1,
      state: "published",
      currentRevision: 1,
      lastCommandId: billingCommand.id,
      publishedAt: "2035-01-15T00:00:00.000Z",
      publishedByUserId: billingPublishedByUserId,
      publicationCommandId: billingCommand.id,
    });
    await assertRefusesDelete(billingPublishedByUserId);
  });
});
