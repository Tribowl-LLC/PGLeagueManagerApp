import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleExceptions,
  leagueScheduleCommands,
  locations,
  organizations,
  users,
  leagues,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  buildCanonicalScheduleCommandFingerprint,
  cancelOccurrence,
  createGenerationRevision,
  discardDraftOccurrence,
  rescheduleOccurrence,
  validateExceptionPlacement,
  validateMakeupRelationship,
  validateOccurrencePlacement,
  withLockedExceptionPlacementMutation,
  withLockedMakeupRelationshipMutation,
  withLockedOccurrencePlacementMutation,
  type CanonicalScheduleCommandFingerprintRequest,
} from "../../server/services/canonical-occurrence-transactions";
import { repairCanonicalCollectionGroups } from "../../server/services/canonical-collection-group-repair";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
const systemAdminsToDelete: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  actorUserId: number;
  regularUserId: number;
  systemAdminUserId: number;
  locationId: number;
  leagueId: number;
}

function withFingerprint<T extends CanonicalScheduleCommandFingerprintRequest>(request: T): Omit<T, "requestFingerprint"> & { requestFingerprint: string } {
  return {
    ...request,
    requestFingerprint: buildCanonicalScheduleCommandFingerprint(request),
  };
}

function fingerprint(seed: string): string {
  return Array.from(seed)
    .map((character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

async function fixture(label: string): Promise<Fixture> {
  const unique = `${label}-${++sequence}`.toLowerCase();
  const [organization] = await db.insert(organizations).values({ name: `A2 ${unique}`, slug: `a2-${unique}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("A2 organization was not created");
  organizationsToDelete.push(organization.id);
  const [actor] = await db.insert(users).values({
    email: `a2-${unique}@example.test`,
    password: "a2-test-password-hash",
    name: `A2 ${unique} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("A2 actor was not created");
  const [regularUser] = await db.insert(users).values({
    email: `a2-${unique}-user@example.test`,
    password: "a2-test-password-hash",
    name: `A2 ${unique} regular user`,
    role: "user",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!regularUser) throw new Error("A2 regular user was not created");
  const [systemAdmin] = await db.insert(users).values({
    email: `a2-${unique}-system@example.test`,
    password: "a2-test-password-hash",
    name: `A2 ${unique} system admin`,
    role: "system_admin",
    organizationId: null,
  }).returning({ id: users.id });
  if (!systemAdmin) throw new Error("A2 system admin was not created");
  systemAdminsToDelete.push(systemAdmin.id);
  const [location] = await db.insert(locations).values({ name: `A2 ${unique} location`, organizationId: organization.id }).returning({ id: locations.id });
  if (!location) throw new Error("A2 location was not created");
  const [league] = await db.insert(leagues).values({
    name: `A2 ${unique} league`,
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2035-01-01",
    seasonEnd: "2035-04-01",
    weekDay: "Sunday",
    timezone: "America/New_York",
    competitionStartTime: "19:00",
    totalBowlingWeeks: 12,
    doublePayDates: ["2035-01-05"],
  }).returning({ id: leagues.id });
  if (!league) throw new Error("A2 league was not created");
  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    regularUserId: regularUser.id,
    systemAdminUserId: systemAdmin.id,
    locationId: location.id,
    leagueId: league.id,
  };
}

async function command(
  f: Fixture,
  commandType: "generate" | "publish" | "cancel" | "create_exception" | "create_makeup_relationship",
  label: string,
  reason?: string,
) {
  const [row] = await db.insert(leagueScheduleCommands).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    actorUserId: f.actorUserId,
    commandType,
    reason,
    idempotencyKey: `direct-${label}-${++sequence}`,
    requestFingerprint: fingerprint(`direct-${label}-${sequence}`),
  }).returning();
  if (!row) throw new Error("A2 command was not created");
  return row;
}

async function occurrence(f: Fixture, label: string, options: {
  lifecycle?: "draft" | "published" | "locked";
  status?: "scheduled" | "cancelled";
  kind?: "regular" | "makeup";
  localDate?: string;
  startAt?: string;
  commandId?: string;
  plannedOrdinal?: number | null;
  competitionNumber?: number | null;
} = {}) {
  const lifecycle = options.lifecycle ?? "draft";
  const status = options.status ?? "scheduled";
  const createCommand = options.commandId ? null : await command(f, lifecycle === "published" ? "publish" : "generate", `${label}-occurrence`);
  const commandId = options.commandId ?? createCommand?.id;
  if (!commandId) throw new Error("occurrence command is missing");
  const published = lifecycle !== "draft";
  const [row] = await db.insert(leagueOccurrences).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    locationId: f.locationId,
    generationKey: `a2-${label}-${++sequence}`,
    kind: options.kind ?? "regular",
    status,
    lifecycle,
    authoritativeLocalDate: options.localDate ?? "2035-01-05",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/New_York",
    startAt: options.startAt ?? "2035-01-06T00:00:00.000Z",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous",
    resolverVersion: "a2-test-resolver",
    plannedOrdinal: published ? (options.plannedOrdinal ?? 1) : null,
    competitionNumber: published && status !== "cancelled" ? (options.competitionNumber ?? options.plannedOrdinal ?? 1) : null,
    competitive: status !== "cancelled",
    countsInStandings: status !== "cancelled",
    lastCommandId: commandId,
    publishedAt: published ? "2034-12-01T00:00:00.000Z" : null,
    publishedByUserId: published ? f.actorUserId : null,
    publicationCommandId: published ? commandId : null,
    lockedAt: lifecycle === "locked" ? "2034-12-02T00:00:00.000Z" : null,
    lockedByUserId: lifecycle === "locked" ? f.actorUserId : null,
    lockReason: lifecycle === "locked" ? "A2 locked test occurrence" : null,
    lockCommandId: lifecycle === "locked" ? commandId : null,
    cancelledAt: status === "cancelled" ? "2034-12-02T00:00:00.000Z" : null,
    cancelledByUserId: status === "cancelled" ? f.actorUserId : null,
    cancellationCommandId: status === "cancelled" ? commandId : null,
  }).returning();
  if (!row) throw new Error("A2 occurrence was not created");
  return row;
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
  for (const userId of systemAdminsToDelete.splice(0)) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
});

describe("A2 transactional occurrence invariants", () => {
  it("repairs only the explicit current run/configuration and converges complete retries", async () => {
    const f = await fixture("repair-contract");
    const generation = await createGenerationRevision(withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      idempotencyKey: "repair-current-run-generation",
      requestFingerprint: "",
      generatorVersion: "repair-test-generator",
      inputFingerprint: fingerprint("repair-input"),
      normalizedInputSnapshot: { repair: true },
      rangeStartDate: "2035-01-01",
      rangeEndDate: "2035-01-31",
      candidateOccurrenceCount: 2,
      generatedOccurrenceCount: 2,
      skippedDateCount: 0,
      discrepancyCount: 0,
    }));
    const approval = await command(f, "publish", "repair-approval");
    await db.update(leagueOccurrenceGenerationRuns).set({
      state: "approved",
      approvedAt: "2034-12-01T00:00:00.000Z",
      approvedByUserId: f.actorUserId,
      approvalCommandId: approval.id,
    }).where(eq(leagueOccurrenceGenerationRuns.id, generation.generationRun.id));
    const trigger = await occurrence(f, "repair-trigger", {
      lifecycle: "published",
      localDate: "2035-01-05",
      startAt: "2035-01-06T00:00:00.000Z",
    });
    const paired = await occurrence(f, "repair-paired", {
      lifecycle: "published",
      localDate: "2035-01-12",
      startAt: "2035-01-13T00:00:00.000Z",
      plannedOrdinal: 2,
      competitionNumber: 2,
    });
    await db.update(leagueOccurrences).set({ generationRunId: generation.generationRun.id })
      .where(eq(leagueOccurrences.id, trigger.id));
    await db.update(leagueOccurrences).set({ generationRunId: generation.generationRun.id })
      .where(eq(leagueOccurrences.id, paired.id));
    for (const row of [trigger, paired]) {
      const [term] = await db.insert(leagueOccurrenceBillingTerms).values({
        organizationId: f.organizationId,
        leagueId: f.leagueId,
        occurrenceId: row.id,
        purpose: "league_weekly_fee",
        obligationPolicy: "eligible_bowlers",
        defaultAmountMinor: 2_000,
        currency: "USD",
        billingOrdinal: row.authoritativeLocalDate === "2035-01-05" ? 1 : 2,
        version: 1,
        state: "published",
        publishedAt: "2034-12-01T00:00:00.000Z",
        publishedByUserId: f.actorUserId,
        publicationCommandId: row.lastCommandId,
      }).returning();
      if (!term) throw new Error("repair term was not created");
    }
    const [triggerTerm, pairedTerm] = await db.select().from(leagueOccurrenceBillingTerms)
      .where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId))
      .orderBy(leagueOccurrenceBillingTerms.billingOrdinal);
    if (!triggerTerm || !pairedTerm) throw new Error("repair terms are missing");
    const input = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      generationRunId: generation.generationRun.id,
      sourceScheduleRevision: generation.generationRun.sourceScheduleRevision,
      idempotencyKey: "repair-explicit-contract",
      reason: "Repair proven historical canonical pair",
      pairs: [{
        triggerOccurrenceId: trigger.id,
        pairedOccurrenceId: paired.id,
        triggerLocalDate: "2035-01-05",
        pairedLocalDate: "2035-01-12",
      }],
    } as const;
    await expect(repairCanonicalCollectionGroups({ ...input, pairs: [{ ...input.pairs[0], pairedLocalDate: "2035-01-19" }] }))
      .rejects.toThrow(/explicit date|preconditions|configured/);
    const applied = await repairCanonicalCollectionGroups(input);
    expect(applied).toMatchObject({ mode: "applied", writesPerformed: true, groupIds: [expect.any(String)] });
    const retry = await repairCanonicalCollectionGroups(input);
    expect(retry).toMatchObject({ mode: "idempotent_retry", writesPerformed: false, groupIds: applied.groupIds, commandIds: applied.commandIds });
    expect(triggerTerm.id).toBeDefined();
    expect(pairedTerm.id).toBeDefined();
  });

  it("serializes source revisions, converges idempotent retries, and rejects fingerprint reuse", async () => {
    const f = await fixture("revision");
    const base = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      idempotencyKey: "generation-revision-retry",
      requestFingerprint: "",
      generatorVersion: "a2-test-generator",
      inputFingerprint: fingerprint("generation-input"),
      normalizedInputSnapshot: { fixture: "revision" },
      rangeStartDate: "2035-01-01",
      rangeEndDate: "2035-04-01",
      candidateOccurrenceCount: 1,
      generatedOccurrenceCount: 1,
      skippedDateCount: 0,
      discrepancyCount: 0,
    });
    const [first, second] = await Promise.all([
      createGenerationRevision(withFingerprint({ ...base, idempotencyKey: "generation-one" })),
      createGenerationRevision(withFingerprint({ ...base, idempotencyKey: "generation-two" })),
    ]);
    expect(new Set([first.generationRun.sourceScheduleRevision, second.generationRun.sourceScheduleRevision])).toEqual(new Set([1, 2]));
    const retry = await createGenerationRevision(base);
    expect(retry.generationRun.id).toBe((await createGenerationRevision(base)).generationRun.id);
    await expect(createGenerationRevision(withFingerprint({
      ...base,
      normalizedInputSnapshot: { fixture: "different" },
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("binds placement fingerprints to startAt and rejects reschedule as a placement command", async () => {
    const f = await fixture("placement-contract");
    const placement = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      idempotencyKey: "placement-contract",
      requestFingerprint: "",
      authoritativeLocalDate: "2035-02-02",
      startAt: "2035-02-03T00:00:00.000Z",
    };
    expect(buildCanonicalScheduleCommandFingerprint(placement)).not.toBe(
      buildCanonicalScheduleCommandFingerprint({ ...placement, startAt: "2035-02-03T01:00:00.000Z" }),
    );

    const invalidPlacement = {
      ...withFingerprint(placement),
      commandType: "reschedule" as const,
    };
    await expect(
      // @ts-expect-error Reschedules require OccurrenceRescheduleRequest and rescheduleOccurrence.
      validateOccurrencePlacement(invalidPlacement),
    ).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("rejects same-day collisions by default, allows distinct-time audited overrides, and always rejects exact starts", async () => {
    const f = await fixture("same-day");
    await occurrence(f, "same-day-existing", { localDate: "2035-02-02", startAt: "2035-02-03T00:00:00.000Z" });
    const request = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      requestFingerprint: "",
      idempotencyKey: "same-day-default",
      authoritativeLocalDate: "2035-02-02",
      startAt: "2035-02-03T01:00:00.000Z",
    });
    await expect(validateOccurrencePlacement(request)).rejects.toMatchObject({ code: "same_day_collision" });
    const overrideRequest = withFingerprint({ ...request, sameDayOverride: true, reason: "Audited distinct-time exception" });
    await expect(validateOccurrencePlacement(overrideRequest)).resolves.toBeDefined();
    await expect(validateOccurrencePlacement(overrideRequest)).resolves.toBeDefined();
    await expect(validateOccurrencePlacement(withFingerprint({
      ...overrideRequest,
      startAt: "2035-02-03T02:00:00.000Z",
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      idempotencyKey: "same-day-exact",
      sameDayOverride: true,
      reason: "Audited override cannot alter an exact start collision",
      startAt: "2035-02-03T00:00:00.000Z",
    }))).rejects.toMatchObject({ code: "exact_start_collision" });

    await occurrence(f, "published-exact", {
      lifecycle: "published",
      localDate: "2035-02-16",
      startAt: "2035-02-17T00:00:00.000Z",
      plannedOrdinal: 2,
      competitionNumber: 2,
    });
    await occurrence(f, "locked-exact", {
      lifecycle: "locked",
      localDate: "2035-02-23",
      startAt: "2035-02-24T00:00:00.000Z",
      plannedOrdinal: 3,
      competitionNumber: 3,
    });
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      idempotencyKey: "published-exact",
      authoritativeLocalDate: "2035-02-17",
      startAt: "2035-02-17T00:00:00.000Z",
      sameDayOverride: true,
      reason: "Exact UTC start remains prohibited across local dates",
    }))).rejects.toMatchObject({ code: "exact_start_collision" });
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      idempotencyKey: "locked-exact",
      authoritativeLocalDate: "2035-02-24",
      startAt: "2035-02-24T00:00:00.000Z",
      sameDayOverride: true,
      reason: "Locked exact UTC start remains prohibited",
    }))).rejects.toMatchObject({ code: "exact_start_collision" });
  });

  it("revalidates an existing placement preflight before a later locked mutation", async () => {
    const f = await fixture("placement-preflight-revalidation");
    const request = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      requestFingerprint: "",
      idempotencyKey: "placement-preflight-revalidation",
      authoritativeLocalDate: "2035-02-09",
      startAt: "2035-02-10T00:00:00.000Z",
    });
    await expect(validateOccurrencePlacement(request)).resolves.toBeDefined();
    await occurrence(f, "placement-preflight-competitor", {
      localDate: request.authoritativeLocalDate,
      startAt: "2035-02-10T01:00:00.000Z",
    });

    let mutationCalled = false;
    await expect(withLockedOccurrencePlacementMutation(request, async () => {
      mutationCalled = true;
      return undefined;
    })).rejects.toMatchObject({ code: "same_day_collision" });
    expect(mutationCalled).toBe(false);
    await expect(validateOccurrencePlacement(request)).rejects.toMatchObject({ code: "same_day_collision" });
  });

  it("fails closed for cross-tenant scope and serializes concurrent same-day attempts", async () => {
    const first = await fixture("tenant-a");
    const second = await fixture("tenant-b");
    await occurrence(first, "concurrent-existing", { localDate: "2035-02-09", startAt: "2035-02-10T00:00:00.000Z" });
    const request = {
      organizationId: first.organizationId,
      leagueId: first.leagueId,
      actorUserId: first.actorUserId,
      commandType: "generate" as const,
      requestFingerprint: "",
      authoritativeLocalDate: "2035-02-09",
      startAt: "2035-02-10T01:00:00.000Z",
    };
    const outcomes = await Promise.allSettled([
      validateOccurrencePlacement(withFingerprint({ ...request, idempotencyKey: "concurrent-one" })),
      validateOccurrencePlacement(withFingerprint({ ...request, idempotencyKey: "concurrent-two" })),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      organizationId: second.organizationId,
      leagueId: first.leagueId,
      actorUserId: second.actorUserId,
      idempotencyKey: "cross-tenant",
    }))).rejects.toMatchObject({ code: "league_not_found" });
  });

  it("keeps validation and a test mutation under one league lock", async () => {
    const f = await fixture("empty-race");
    const base = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      requestFingerprint: "",
      authoritativeLocalDate: "2035-02-09",
      sameDayOverride: false,
    };
    const attempt = (label: string, startAt: string) => withLockedOccurrencePlacementMutation(
      withFingerprint({ ...base, idempotencyKey: `empty-race-${label}`, startAt }),
      async ({ tx, command, existing }) => {
        if (existing) {
          const [prior] = await tx.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(and(
            eq(leagueOccurrences.organizationId, f.organizationId),
            eq(leagueOccurrences.leagueId, f.leagueId),
            eq(leagueOccurrences.lastCommandId, command.id),
          )).for("update");
          if (prior) return prior.id;
        }
        const [inserted] = await tx.insert(leagueOccurrences).values({
          organizationId: f.organizationId,
          leagueId: f.leagueId,
          locationId: f.locationId,
          generationKey: `a2-empty-race-${label}-${++sequence}`,
          kind: "regular",
          status: "scheduled",
          lifecycle: "draft",
          authoritativeLocalDate: "2035-02-09",
          authoritativeLocalStartTime: "19:00:00",
          timezone: "America/New_York",
          startAt,
          selectedUtcOffsetMinutes: -300,
          foldResolution: "unambiguous",
          resolverVersion: "a2-test-resolver",
          competitive: true,
          countsInStandings: true,
          lastCommandId: command.id,
        }).returning({ id: leagueOccurrences.id });
        return inserted?.id;
      },
    );
    const candidates = [
      { label: "one", startAt: "2035-02-10T00:00:00.000Z" },
      { label: "two", startAt: "2035-02-10T01:00:00.000Z" },
    ];
    const outcomes = await Promise.allSettled(candidates.map(({ label, startAt }) => attempt(label, startAt)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "same_day_collision" } });
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const winner = outcomes[winnerIndex];
    const winningCandidate = candidates[winnerIndex];
    if (!winner || winner.status !== "fulfilled" || !winningCandidate) throw new Error("concurrent mutation winner is missing");
    await expect(attempt(winningCandidate.label, winningCandidate.startAt)).resolves.toBe(winner.value);
    expect(await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.organizationId),
      eq(leagueOccurrences.leagueId, f.leagueId),
      eq(leagueOccurrences.authoritativeLocalDate, "2035-02-09"),
    ))).toHaveLength(1);
  });

  it("allows only schedule administrators and preserves the platform-admin exception", async () => {
    const f = await fixture("authorization");
    const request = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      commandType: "generate" as const,
      requestFingerprint: "",
      authoritativeLocalDate: "2035-02-09",
      startAt: "2035-02-10T00:00:00.000Z",
    };
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      actorUserId: f.regularUserId,
      idempotencyKey: "authorization-user",
    }))).rejects.toMatchObject({ code: "unauthorized_actor" });
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      actorUserId: f.actorUserId,
      idempotencyKey: "authorization-org-admin",
    }))).resolves.toBeDefined();
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      actorUserId: f.systemAdminUserId,
      idempotencyKey: "authorization-system-admin",
    }))).resolves.toBeDefined();

    const other = await fixture("authorization-other");
    await expect(validateOccurrencePlacement(withFingerprint({
      ...request,
      actorUserId: other.actorUserId,
      idempotencyKey: "authorization-cross-tenant",
    }))).rejects.toMatchObject({ code: "unauthorized_actor" });
  });

  it("enforces makeup source/target and explicit cancelled-target semantics", async () => {
    const f = await fixture("makeup");
    const source = await occurrence(f, "makeup-source", { kind: "makeup" });
    const regular = await occurrence(f, "makeup-regular", { lifecycle: "published", status: "scheduled" });
    await expect(validateMakeupRelationship(withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_makeup_relationship",
      idempotencyKey: "makeup-not-cancelled",
      requestFingerprint: "",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: regular.id,
    }))).rejects.toMatchObject({ code: "cancelled_target_required" });
  });

  it("covers exception and makeup idempotency payloads and collision boundaries", async () => {
    const f = await fixture("exception-makeup");
    const exceptionRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_exception" as const,
      idempotencyKey: "exception-placement",
      requestFingerprint: "",
      authoritativeLocalDate: "2035-02-16",
      startAt: "2035-02-17T00:00:00.000Z",
    });
    const exceptionCommand = await validateExceptionPlacement(exceptionRequest);
    await expect(validateExceptionPlacement(exceptionRequest)).resolves.toMatchObject({ id: exceptionCommand.id });
    await db.insert(leagueScheduleExceptions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "skip",
      localDate: exceptionRequest.authoritativeLocalDate,
      timezone: "America/New_York",
      source: "manual",
      lifecycle: "draft",
      reason: "A2 exception placement test",
      lastCommandId: exceptionCommand.id,
    });
    await expect(validateExceptionPlacement(exceptionRequest)).resolves.toMatchObject({ id: exceptionCommand.id });
    await expect(validateExceptionPlacement(withFingerprint({
      ...exceptionRequest,
      idempotencyKey: "exception-placement-different-key",
    }))).rejects.toMatchObject({ code: "exception_collision" });

    const source = await occurrence(f, "exception-makeup-source", { kind: "makeup" });
    const target = await occurrence(f, "exception-makeup-target", { lifecycle: "published", status: "cancelled" });
    const makeupRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_makeup_relationship" as const,
      idempotencyKey: "makeup-placement",
      requestFingerprint: "",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: target.id,
    });
    const makeupCommand = await validateMakeupRelationship(makeupRequest);
    await expect(validateMakeupRelationship(makeupRequest)).resolves.toMatchObject({ id: makeupCommand.id });
    await db.insert(leagueOccurrenceRelationships).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "makeup_for",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: target.id,
      state: "draft",
      lastCommandId: makeupCommand.id,
    });
    await expect(validateMakeupRelationship(makeupRequest)).resolves.toMatchObject({ id: makeupCommand.id });
    await expect(validateMakeupRelationship(withFingerprint({
      ...makeupRequest,
      targetOccurrenceId: source.id,
      idempotencyKey: makeupRequest.idempotencyKey,
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("revalidates existing exception and makeup preflights against later competing state", async () => {
    const f = await fixture("exception-makeup-preflight-revalidation");
    const exceptionRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_exception" as const,
      idempotencyKey: "exception-preflight-revalidation",
      requestFingerprint: "",
      authoritativeLocalDate: "2035-03-09",
      startAt: "2035-03-10T00:00:00.000Z",
    });
    await expect(validateExceptionPlacement(exceptionRequest)).resolves.toBeDefined();
    const competingExceptionCommand = await command(f, "create_exception", "exception-preflight-competitor");
    await db.insert(leagueScheduleExceptions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "skip",
      localDate: exceptionRequest.authoritativeLocalDate,
      timezone: "America/New_York",
      source: "manual",
      lifecycle: "draft",
      reason: "A competing exception appeared after preflight",
      lastCommandId: competingExceptionCommand.id,
    });
    let exceptionMutationCalled = false;
    await expect(withLockedExceptionPlacementMutation(exceptionRequest, async () => {
      exceptionMutationCalled = true;
      return undefined;
    })).rejects.toMatchObject({ code: "exception_collision" });
    expect(exceptionMutationCalled).toBe(false);
    await expect(validateExceptionPlacement(exceptionRequest)).rejects.toMatchObject({ code: "exception_collision" });

    const source = await occurrence(f, "makeup-preflight-source", { kind: "makeup" });
    const target = await occurrence(f, "makeup-preflight-target", { lifecycle: "published", status: "cancelled" });
    const makeupRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_makeup_relationship" as const,
      idempotencyKey: "makeup-preflight-revalidation",
      requestFingerprint: "",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: target.id,
    });
    await expect(validateMakeupRelationship(makeupRequest)).resolves.toBeDefined();
    const competingRelationshipCommand = await command(f, "create_makeup_relationship", "makeup-preflight-competitor");
    await db.insert(leagueOccurrenceRelationships).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      kind: "makeup_for",
      sourceOccurrenceId: source.id,
      targetOccurrenceId: target.id,
      state: "draft",
      lastCommandId: competingRelationshipCommand.id,
    });
    let makeupMutationCalled = false;
    await expect(withLockedMakeupRelationshipMutation(makeupRequest, async () => {
      makeupMutationCalled = true;
      return undefined;
    })).rejects.toMatchObject({ code: "invalid_command" });
    expect(makeupMutationCalled).toBe(false);
    await expect(validateMakeupRelationship(makeupRequest)).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("discards a draft atomically, retains identity, supersedes terms, and records revisions", async () => {
    const f = await fixture("discard");
    const draft = await occurrence(f, "discard-draft");
    const generate = draft.lastCommandId;
    if (!generate) throw new Error("draft command is missing");
    const [term] = await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      occurrenceId: draft.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2000,
      currency: "USD",
      billingOrdinal: 1,
      version: 1,
    }).returning();
    if (!term) throw new Error("draft term is missing");
    await db.insert(leagueOccurrenceRevisions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      occurrenceId: draft.id,
      commandId: generate,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { status: "scheduled" },
    });
    await db.insert(leagueOccurrenceBillingTermRevisions).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      billingTermId: term.id,
      commandId: generate,
      revisionNumber: 1,
      snapshotSchemaVersion: 1,
      afterSnapshot: { state: "draft" },
    });
    const discardRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "discard_draft",
      idempotencyKey: "discard-draft-command",
      requestFingerprint: "",
      reason: "The generated draft is intentionally discarded",
      occurrenceId: draft.id,
      now: "2034-12-01T00:00:00.000Z",
    });
    const discarded = await discardDraftOccurrence(discardRequest);
    expect(discarded.occurrence.id).toBe(draft.id);
    expect(discarded.occurrence.generationKey).toBe(draft.generationKey);
    expect(discarded.occurrence.status).toBe("discarded");
    expect(discarded.occurrence.plannedOrdinal).toBeNull();
    expect(discarded.supersededBillingTermIds).toEqual([term.id]);
    const [termAfter] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    expect(termAfter?.state).toBe("superseded");
    expect(await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.occurrenceId, draft.id))).toHaveLength(2);
    expect(await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id))).toHaveLength(2);
    await expect(discardDraftOccurrence(discardRequest)).resolves.toMatchObject({ occurrence: { id: draft.id, status: "discarded" } });
    await expect(discardDraftOccurrence(withFingerprint({
      ...discardRequest,
      reason: "A materially different discard request",
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rolls back discard work and refuses effectively locked or active rows", async () => {
    const f = await fixture("rollback");
    const draft = await occurrence(f, "rollback-draft");
    await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      occurrenceId: draft.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2000,
      currency: "USD",
      billingOrdinal: 1,
      version: 1,
    });
    const triggerName = `a2_discard_failure_${sequence}`;
    const functionName = `${triggerName}_fn`;
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'A2 induced discard failure'; END; $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF state ON league_occurrence_billing_terms FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));
    try {
      await expect(discardDraftOccurrence(withFingerprint({
        organizationId: f.organizationId,
        leagueId: f.leagueId,
        actorUserId: f.actorUserId,
        commandType: "discard_draft",
        idempotencyKey: "rollback-discard",
        requestFingerprint: "",
        reason: "Induced failure must roll back all discard work",
        occurrenceId: draft.id,
        now: "2034-12-01T00:00:00.000Z",
      }))).rejects.toThrow(/league_occurrence_billing_terms/);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON league_occurrence_billing_terms`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
    const [afterRollback] = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, draft.id));
    expect(afterRollback?.status).toBe("scheduled");
    const locked = await occurrence(f, "locked-draft", { startAt: "2034-01-01T00:00:00.000Z" });
    await expect(discardDraftOccurrence(withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "discard_draft",
      idempotencyKey: "locked-discard",
      requestFingerprint: "",
      reason: "Do not discard an effectively locked occurrence",
      occurrenceId: locked.id,
      now: "2034-01-02T00:00:00.000Z",
    }))).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
  });

  it("cancels without renumbering history, clears current competition and billing, and refuses activity evidence", async () => {
    const f = await fixture("cancel");
    const target = await occurrence(f, "cancel-target", { lifecycle: "published", competitionNumber: 7, startAt: "2035-03-02T00:00:00.000Z" });
    const publish = target.publicationCommandId;
    if (!publish) throw new Error("publication command is missing");
    const [term] = await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      occurrenceId: target.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 2000,
      currency: "USD",
      billingOrdinal: 7,
      version: 1,
      state: "published",
      publishedAt: "2034-12-01T00:00:00.000Z",
      publishedByUserId: f.actorUserId,
      publicationCommandId: publish,
    }).returning();
    if (!term) throw new Error("published billing term is missing");
    await expect(cancelOccurrence(withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "cancel",
      idempotencyKey: "cancel-with-evidence",
      requestFingerprint: "",
      reason: "Evidence refusal",
      occurrenceId: target.id,
      now: "2035-01-01T00:00:00.000Z",
      activityEvidence: ["explicit-game:2035-03-02"],
    }))).rejects.toMatchObject({ code: "activity_evidence" });
    const cancelled = await cancelOccurrence(withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "cancel",
      idempotencyKey: "cancel-clean",
      requestFingerprint: "",
      reason: "The physical session is cancelled",
      occurrenceId: target.id,
      now: "2035-01-01T00:00:00.000Z",
    }));
    expect(cancelled.plannedOrdinal).toBe(1);
    expect(cancelled.competitionNumber).toBeNull();
    expect(cancelled.competitive).toBe(false);
    expect(cancelled.countsInStandings).toBe(false);
    const [termAfter] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    expect(termAfter).toMatchObject({ obligationPolicy: "none", defaultAmountMinor: 0, billingOrdinal: null });
    const revisions = await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.occurrenceId, target.id));
    expect(revisions.at(-1)?.beforeSnapshot).toMatchObject({ competitionNumber: 7 });
    await expect(cancelOccurrence(withFingerprint({
      ...withFingerprint({
        organizationId: f.organizationId,
        leagueId: f.leagueId,
        actorUserId: f.actorUserId,
        commandType: "cancel" as const,
        idempotencyKey: "cancel-clean",
        requestFingerprint: "",
        reason: "The physical session is cancelled",
        occurrenceId: target.id,
        now: "2035-01-01T00:00:00.000Z",
      }),
      activityEvidence: ["different-evidence"],
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("derives coherent reschedule tuples through the canonical DST resolver", async () => {
    const f = await fixture("reschedule");
    const target = await occurrence(f, "reschedule-valid");
    const validRequest = withFingerprint({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "reschedule" as const,
      idempotencyKey: "reschedule-valid",
      requestFingerprint: "",
      reason: "Move the draft to the next league date",
      occurrenceId: target.id,
      now: "2034-12-01T00:00:00.000Z",
      authoritativeLocalDate: "2035-01-12",
      authoritativeLocalStartTime: "19:00",
      timezone: "US/Eastern",
      ambiguousFold: "reject" as const,
    });
    const rescheduled = await rescheduleOccurrence(validRequest);
    expect(rescheduled).toMatchObject({
      id: target.id,
      generationKey: target.generationKey,
      authoritativeLocalDate: "2035-01-12",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "America/New_York",
      selectedUtcOffsetMinutes: -300,
      foldResolution: "unambiguous",
    });
    expect(new Date(rescheduled.startAt).toISOString()).toBe("2035-01-13T00:00:00.000Z");
    await expect(rescheduleOccurrence(validRequest)).resolves.toMatchObject({ id: target.id, currentRevision: rescheduled.currentRevision });
    await expect(rescheduleOccurrence(withFingerprint({
      ...validRequest,
      authoritativeLocalDate: "2035-01-19",
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });

    const gapRequest = withFingerprint({
      ...validRequest,
      idempotencyKey: "reschedule-gap",
      authoritativeLocalDate: "2035-03-11",
      authoritativeLocalStartTime: "02:30",
    });
    await expect(rescheduleOccurrence(gapRequest)).rejects.toMatchObject({ code: "invalid_dst_input" });

    const foldReject = withFingerprint({
      ...validRequest,
      idempotencyKey: "reschedule-fold-reject",
      authoritativeLocalDate: "2035-11-04",
      authoritativeLocalStartTime: "01:30",
    });
    await expect(rescheduleOccurrence(foldReject)).rejects.toMatchObject({ code: "invalid_dst_input" });
    const foldEarlier = await rescheduleOccurrence(withFingerprint({
      ...validRequest,
      idempotencyKey: "reschedule-fold-earlier",
      authoritativeLocalDate: "2035-11-04",
      authoritativeLocalStartTime: "01:30",
      ambiguousFold: "earlier" as const,
    }));
    expect(foldEarlier.selectedUtcOffsetMinutes).toBe(-240);
    expect(foldEarlier.foldResolution).toBe("earlier");
    expect(new Date(foldEarlier.startAt).toISOString()).toBe("2035-11-04T05:30:00.000Z");
    const foldLater = await rescheduleOccurrence(withFingerprint({
      ...validRequest,
      idempotencyKey: "reschedule-fold-later",
      authoritativeLocalDate: "2035-11-04",
      authoritativeLocalStartTime: "01:30",
      ambiguousFold: "later" as const,
    }));
    expect(foldLater.selectedUtcOffsetMinutes).toBe(-300);
    expect(foldLater.foldResolution).toBe("later");
    expect(new Date(foldLater.startAt).toISOString()).toBe("2035-11-04T06:30:00.000Z");

    const mismatched = occurrence(f, "reschedule-mismatch");
    const mismatchTarget = await mismatched;
    const ordinary = {
      ...validRequest,
      occurrenceId: mismatchTarget.id,
      idempotencyKey: "reschedule-wrong-derived-fields",
      authoritativeLocalDate: "2035-02-09",
      authoritativeLocalStartTime: "19:00",
      timezone: "America/New_York",
      ambiguousFold: "reject" as const,
    };
    await expect(rescheduleOccurrence(withFingerprint({ ...ordinary, startAt: "2035-02-10T01:00:00.000Z" }))).rejects.toMatchObject({ code: "invalid_dst_input" });
    await expect(rescheduleOccurrence(withFingerprint({ ...ordinary, idempotencyKey: "reschedule-wrong-offset", selectedUtcOffsetMinutes: -240 }))).rejects.toMatchObject({ code: "invalid_dst_input" });
    await expect(rescheduleOccurrence(withFingerprint({ ...ordinary, idempotencyKey: "reschedule-wrong-fold", foldResolution: "later" as const }))).rejects.toMatchObject({ code: "invalid_dst_input" });
    await expect(rescheduleOccurrence(withFingerprint({ ...ordinary, idempotencyKey: "reschedule-wrong-version", resolverVersion: "caller-version" }))).rejects.toMatchObject({ code: "invalid_dst_input" });
    await expect(rescheduleOccurrence(withFingerprint({
      ...ordinary,
      idempotencyKey: "reschedule-local-mismatch",
      startAt: "2035-02-16T00:00:00.000Z",
    }))).rejects.toMatchObject({ code: "invalid_dst_input" });
  });

  it("proves the standalone operator is read-only and keeps legacy collection evidence separate", async () => {
    const f = await fixture("operator");
    const beforeLeague = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const beforeOccurrences = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.organizationId),
      eq(leagueOccurrences.leagueId, f.leagueId),
    ));
    const beforeCommands = await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, f.organizationId));
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("test database URL is missing");
    const run = spawnSync(process.execPath, [tsx, "scripts/generate-canonical-occurrences.ts",
      `--organizationId=${f.organizationId}`,
      `--leagueId=${f.leagueId}`,
      "--sourceScheduleRevision=1",
      "--ambiguousFold=reject",
      "--currency=USD",
      "--regularSessionBillingPolicy=eligible_bowlers",
      "--billingOrdinalPolicy=planned_slot",
    ], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    expect(run.status).toBe(0);
    const output: unknown = JSON.parse(run.stdout);
    expect(output).toMatchObject({
      target: { organizationId: f.organizationId, leagueId: f.leagueId, locationId: f.locationId },
      legacyCollectionEvidence: {
        source: "leagues.double_pay_dates",
        doublePayDates: ["2035-01-05"],
        excludedFromGeneratorInput: true,
      },
      generationResult: { fatalErrorCount: 0 },
    });
    expect(output).toMatchObject({ generationResult: { normalizedInput: { timezone: "America/New_York" } } });
    expect(JSON.stringify(output)).not.toContain("doublePayDates\":[]");
    const afterLeague = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const afterOccurrences = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.organizationId),
      eq(leagueOccurrences.leagueId, f.leagueId),
    ));
    const afterCommands = await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, f.organizationId));
    expect(afterLeague).toEqual(beforeLeague);
    expect(afterOccurrences).toEqual(beforeOccurrences);
    expect(afterCommands).toEqual(beforeCommands);

    await db.update(leagues).set({ weeklyFee: 0 }).where(eq(leagues.id, f.leagueId));
    const beforeNonbillableLeague = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const beforeNonbillableOccurrences = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.organizationId),
      eq(leagueOccurrences.leagueId, f.leagueId),
    ));
    const beforeNonbillableCommands = await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, f.organizationId));
    const nonbillableRun = spawnSync(process.execPath, [tsx, "scripts/generate-canonical-occurrences.ts",
      `--organizationId=${f.organizationId}`,
      `--leagueId=${f.leagueId}`,
      "--sourceScheduleRevision=2",
      "--ambiguousFold=reject",
      "--currency=USD",
      "--regularSessionBillingPolicy=none",
      "--billingOrdinalPolicy=planned_slot",
    ], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    expect(nonbillableRun.status).toBe(0);
    const nonbillableOutput: unknown = JSON.parse(nonbillableRun.stdout);
    expect(nonbillableOutput).toMatchObject({
      generationResult: {
        fatalErrorCount: 0,
        normalizedInput: { defaultWeeklyAmountMinor: 0, regularSessionBillingPolicy: "none" },
      },
    });
    const nonbillableTerms = (nonbillableOutput as {
      generationResult: { billingTermCandidates: Array<{ obligationPolicy: string; defaultAmountMinor: number; billingOrdinal: number | null }> };
    }).generationResult.billingTermCandidates;
    expect(nonbillableTerms.every((term) => term.obligationPolicy === "none" && term.defaultAmountMinor === 0 && term.billingOrdinal === null)).toBe(true);
    const afterNonbillableLeague = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const afterNonbillableOccurrences = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, f.organizationId),
      eq(leagueOccurrences.leagueId, f.leagueId),
    ));
    const afterNonbillableCommands = await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, f.organizationId));
    expect(afterNonbillableLeague).toEqual(beforeNonbillableLeague);
    expect(afterNonbillableOccurrences).toEqual(beforeNonbillableOccurrences);
    expect(afterNonbillableCommands).toEqual(beforeNonbillableCommands);
  });
});
