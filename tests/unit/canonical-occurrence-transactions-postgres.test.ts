import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  locations,
  organizations,
  users,
  leagues,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  cancelOccurrence,
  createGenerationRevision,
  discardDraftOccurrence,
  validateMakeupRelationship,
  validateOccurrencePlacement,
} from "../../server/services/canonical-occurrence-transactions";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  actorUserId: number;
  locationId: number;
  leagueId: number;
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
  return { organizationId: organization.id, actorUserId: actor.id, locationId: location.id, leagueId: league.id };
}

async function command(f: Fixture, commandType: "generate" | "publish" | "cancel", label: string, reason?: string) {
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
  lifecycle?: "draft" | "published";
  status?: "scheduled" | "cancelled";
  kind?: "regular" | "makeup";
  localDate?: string;
  startAt?: string;
  commandId?: string;
  competitionNumber?: number | null;
} = {}) {
  const lifecycle = options.lifecycle ?? "draft";
  const status = options.status ?? "scheduled";
  const createCommand = options.commandId ? null : await command(f, lifecycle === "published" ? "publish" : "generate", `${label}-occurrence`);
  const commandId = options.commandId ?? createCommand?.id;
  if (!commandId) throw new Error("occurrence command is missing");
  const published = lifecycle === "published";
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
    plannedOrdinal: published ? 1 : null,
    competitionNumber: published ? (options.competitionNumber ?? 1) : null,
    competitive: status !== "cancelled",
    countsInStandings: status !== "cancelled",
    lastCommandId: commandId,
    publishedAt: published ? "2034-12-01T00:00:00.000Z" : null,
    publishedByUserId: published ? f.actorUserId : null,
    publicationCommandId: published ? commandId : null,
    cancelledAt: status === "cancelled" ? "2034-12-02T00:00:00.000Z" : null,
    cancelledByUserId: status === "cancelled" ? f.actorUserId : null,
    cancellationCommandId: status === "cancelled" ? commandId : null,
  }).returning();
  if (!row) throw new Error("A2 occurrence was not created");
  return row;
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("A2 transactional occurrence invariants", () => {
  it("serializes source revisions, converges idempotent retries, and rejects fingerprint reuse", async () => {
    const f = await fixture("revision");
    const base = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      idempotencyKey: "generation-revision-retry",
      requestFingerprint: fingerprint("generation-revision-input"),
      generatorVersion: "a2-test-generator",
      inputFingerprint: fingerprint("generation-input"),
      normalizedInputSnapshot: { fixture: "revision" },
      rangeStartDate: "2035-01-01",
      rangeEndDate: "2035-04-01",
      candidateOccurrenceCount: 1,
      generatedOccurrenceCount: 1,
      skippedDateCount: 0,
      discrepancyCount: 0,
    };
    const [first, second] = await Promise.all([
      createGenerationRevision({ ...base, idempotencyKey: "generation-one", requestFingerprint: fingerprint("one") }),
      createGenerationRevision({ ...base, idempotencyKey: "generation-two", requestFingerprint: fingerprint("two") }),
    ]);
    expect(new Set([first.generationRun.sourceScheduleRevision, second.generationRun.sourceScheduleRevision])).toEqual(new Set([1, 2]));
    const retry = await createGenerationRevision(base);
    expect(retry.generationRun.id).toBe((await createGenerationRevision(base)).generationRun.id);
    await expect(createGenerationRevision({ ...base, requestFingerprint: fingerprint("conflict") })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects same-day collisions by default, allows distinct-time audited overrides, and always rejects exact starts", async () => {
    const f = await fixture("same-day");
    await occurrence(f, "same-day-existing", { localDate: "2035-02-02", startAt: "2035-02-03T00:00:00.000Z" });
    const request = {
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "generate" as const,
      requestFingerprint: fingerprint("same-day-default"),
      idempotencyKey: "same-day-default",
      authoritativeLocalDate: "2035-02-02",
      startAt: "2035-02-03T01:00:00.000Z",
    };
    await expect(validateOccurrencePlacement(request)).rejects.toMatchObject({ code: "same_day_collision" });
    await expect(validateOccurrencePlacement({ ...request, sameDayOverride: true, reason: "Audited distinct-time exception" })).resolves.toBeDefined();
    await expect(validateOccurrencePlacement({
      ...request,
      idempotencyKey: "same-day-exact",
      requestFingerprint: fingerprint("same-day-exact"),
      sameDayOverride: true,
      reason: "Audited override cannot alter an exact start collision",
      startAt: "2035-02-03T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "exact_start_collision" });
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
      authoritativeLocalDate: "2035-02-09",
      startAt: "2035-02-10T01:00:00.000Z",
    };
    const outcomes = await Promise.allSettled([
      validateOccurrencePlacement({ ...request, idempotencyKey: "concurrent-one", requestFingerprint: fingerprint("concurrent-one") }),
      validateOccurrencePlacement({ ...request, idempotencyKey: "concurrent-two", requestFingerprint: fingerprint("concurrent-two") }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    await expect(validateOccurrencePlacement({
      ...request,
      organizationId: second.organizationId,
      leagueId: first.leagueId,
      actorUserId: second.actorUserId,
      idempotencyKey: "cross-tenant",
      requestFingerprint: fingerprint("cross-tenant"),
    })).rejects.toMatchObject({ code: "league_not_found" });
  });

  it("enforces makeup source/target and explicit cancelled-target semantics", async () => {
    const f = await fixture("makeup");
    const source = await occurrence(f, "makeup-source", { kind: "makeup" });
    const regular = await occurrence(f, "makeup-regular", { lifecycle: "published", status: "scheduled" });
    await expect(validateMakeupRelationship({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "create_makeup_relationship",
      idempotencyKey: "makeup-not-cancelled",
      requestFingerprint: fingerprint("makeup-not-cancelled"),
      sourceOccurrenceId: source.id,
      targetOccurrenceId: regular.id,
    })).rejects.toMatchObject({ code: "cancelled_target_required" });
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
    const discarded = await discardDraftOccurrence({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "discard_draft",
      idempotencyKey: "discard-draft-command",
      requestFingerprint: fingerprint("discard-draft-command"),
      reason: "The generated draft is intentionally discarded",
      occurrenceId: draft.id,
      now: "2034-12-01T00:00:00.000Z",
    });
    expect(discarded.occurrence.id).toBe(draft.id);
    expect(discarded.occurrence.generationKey).toBe(draft.generationKey);
    expect(discarded.occurrence.status).toBe("discarded");
    expect(discarded.occurrence.plannedOrdinal).toBeNull();
    expect(discarded.supersededBillingTermIds).toEqual([term.id]);
    const [termAfter] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    expect(termAfter?.state).toBe("superseded");
    expect(await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.occurrenceId, draft.id))).toHaveLength(2);
    expect(await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.billingTermId, term.id))).toHaveLength(2);
    await expect(discardDraftOccurrence({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "discard_draft",
      idempotencyKey: "discard-draft-command",
      requestFingerprint: fingerprint("discard-draft-command"),
      reason: "The generated draft is intentionally discarded",
      occurrenceId: draft.id,
      now: "2034-12-01T00:00:00.000Z",
    })).resolves.toMatchObject({ occurrence: { id: draft.id, status: "discarded" } });
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
      await expect(discardDraftOccurrence({
        organizationId: f.organizationId,
        leagueId: f.leagueId,
        actorUserId: f.actorUserId,
        commandType: "discard_draft",
        idempotencyKey: "rollback-discard",
        requestFingerprint: fingerprint("rollback-discard"),
        reason: "Induced failure must roll back all discard work",
        occurrenceId: draft.id,
        now: "2034-12-01T00:00:00.000Z",
      })).rejects.toThrow(/league_occurrence_billing_terms/);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON league_occurrence_billing_terms`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
    const [afterRollback] = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, draft.id));
    expect(afterRollback?.status).toBe("scheduled");
    const locked = await occurrence(f, "locked-draft", { startAt: "2034-01-01T00:00:00.000Z" });
    await expect(discardDraftOccurrence({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "discard_draft",
      idempotencyKey: "locked-discard",
      requestFingerprint: fingerprint("locked-discard"),
      reason: "Do not discard an effectively locked occurrence",
      occurrenceId: locked.id,
      now: "2034-01-02T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "occurrence_effectively_locked" });
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
    await expect(cancelOccurrence({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "cancel",
      idempotencyKey: "cancel-with-evidence",
      requestFingerprint: fingerprint("cancel-with-evidence"),
      reason: "Evidence refusal",
      occurrenceId: target.id,
      now: "2035-01-01T00:00:00.000Z",
      activityEvidence: ["explicit-game:2035-03-02"],
    })).rejects.toMatchObject({ code: "activity_evidence" });
    const cancelled = await cancelOccurrence({
      organizationId: f.organizationId,
      leagueId: f.leagueId,
      actorUserId: f.actorUserId,
      commandType: "cancel",
      idempotencyKey: "cancel-clean",
      requestFingerprint: fingerprint("cancel-clean"),
      reason: "The physical session is cancelled",
      occurrenceId: target.id,
      now: "2035-01-01T00:00:00.000Z",
    });
    expect(cancelled.plannedOrdinal).toBe(1);
    expect(cancelled.competitionNumber).toBeNull();
    expect(cancelled.competitive).toBe(false);
    expect(cancelled.countsInStandings).toBe(false);
    const [termAfter] = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.id, term.id));
    expect(termAfter).toMatchObject({ obligationPolicy: "none", defaultAmountMinor: 0, billingOrdinal: null });
    const revisions = await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.occurrenceId, target.id));
    expect(revisions.at(-1)?.beforeSnapshot).toMatchObject({ competitionNumber: 7 });
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
  });
});
