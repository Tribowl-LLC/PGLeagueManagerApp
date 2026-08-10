import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  payments,
  users,
} from "@shared/schema";
import {
  FALL_DRAFT_APPLY_REQUEST_VERSION,
  type FallDraftApplyRequest,
  type FallDraftGeneratorSemantics,
  type FallDraftPreview,
} from "@shared/fall-draft-generation";
import {
  applyFallDraftGeneration,
  loadFallDraftPersistedView,
  previewFallDraftGeneration,
} from "../../server/services/fall-draft-generation";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
const systemAdminsToDelete: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  leagueId: number;
  locationId: number;
  actorUserId: number;
  regularUserId: number;
  systemAdminUserId: number;
}

const semantics: FallDraftGeneratorSemantics = {
  ambiguousFold: "reject",
  currency: "USD",
  regularSessionBillingPolicy: "eligible_bowlers",
  billingOrdinalPolicy: "planned_slot",
};

async function fixture(label: string, overrides: Partial<typeof leagues.$inferInsert> = {}): Promise<Fixture> {
  const unique = `${label}-${++sequence}`.toLowerCase();
  const [organization] = await db.insert(organizations).values({ name: `C1 ${unique}`, slug: `c1-${unique}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("C1 organization fixture was not created");
  organizationsToDelete.push(organization.id);
  const [actor] = await db.insert(users).values({
    email: `c1-${unique}@example.test`, password: "c1-test-password-hash", name: `C1 ${unique} actor`, role: "org_admin", organizationId: organization.id,
  }).returning({ id: users.id });
  const [regular] = await db.insert(users).values({
    email: `c1-${unique}-user@example.test`, password: "c1-test-password-hash", name: `C1 ${unique} user`, role: "user", organizationId: organization.id,
  }).returning({ id: users.id });
  const [systemAdmin] = await db.insert(users).values({
    email: `c1-${unique}-system@example.test`, password: "c1-test-password-hash", name: `C1 ${unique} system`, role: "system_admin", organizationId: null,
  }).returning({ id: users.id });
  if (!actor || !regular || !systemAdmin) throw new Error("C1 user fixtures were not created");
  systemAdminsToDelete.push(systemAdmin.id);
  const [location] = await db.insert(locations).values({ name: `C1 ${unique} location`, organizationId: organization.id }).returning({ id: locations.id });
  if (!location) throw new Error("C1 location fixture was not created");
  const [league] = await db.insert(leagues).values({
    name: `C1 ${unique} league`,
    organizationId: organization.id,
    locationId: location.id,
    active: true,
    seasonStart: "2032-08-01",
    seasonEnd: "2032-08-22",
    weekDay: "Sunday",
    timezone: "America/New_York",
    competitionStartTime: "19:00",
    totalBowlingWeeks: 3,
    weeklyFee: 2_000,
    skipDates: ["2032-08-08"],
    cancelledDates: ["2032-08-15"],
    doublePayDates: ["2032-08-22"],
    ...overrides,
  }).returning({ id: leagues.id });
  if (!league) throw new Error("C1 league fixture was not created");
  return {
    organizationId: organization.id,
    leagueId: league.id,
    locationId: location.id,
    actorUserId: actor.id,
    regularUserId: regular.id,
    systemAdminUserId: systemAdmin.id,
  };
}

function scope(f: Fixture, actorUserId = f.actorUserId) {
  return { organizationId: f.organizationId, leagueId: f.leagueId, actorUserId };
}

function applyRequest(preview: FallDraftPreview, overrides: Partial<FallDraftApplyRequest> = {}): FallDraftApplyRequest {
  return {
    contractVersion: FALL_DRAFT_APPLY_REQUEST_VERSION,
    ...semantics,
    confirmedPreviewFingerprint: preview.previewFingerprint,
    reason: "Create reviewed Fall canonical drafts",
    idempotencyKey: `c1-apply-${preview.operatorScope.leagueId}`,
    ...overrides,
  };
}

async function canonicalCounts(f: Fixture) {
  const tables = [
    "league_schedule_commands",
    "league_occurrence_generation_runs",
    "league_occurrences",
    "league_occurrence_billing_terms",
    "league_schedule_exceptions",
    "league_occurrence_relationships",
    "league_occurrence_revisions",
    "league_occurrence_billing_term_revisions",
    "league_schedule_exception_revisions",
    "league_occurrence_generation_discrepancies",
  ] as const;
  const result: Record<string, number> = {};
  for (const table of tables) {
    const query = await db.execute(sql.raw(`SELECT count(*)::integer AS count FROM ${table} WHERE organization_id = ${f.organizationId} AND league_id = ${f.leagueId}`));
    result[table] = Number(query.rows[0]?.count ?? 0);
  }
  return result;
}

async function stageCommand(f: Fixture, commandType: "generate" | "create_exception") {
  const [command] = await db.insert(leagueScheduleCommands).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    actorUserId: f.actorUserId,
    commandType,
    idempotencyKey: `staged-${commandType}-${f.leagueId}-${++sequence}`,
    requestFingerprint: `lvcanoncmd:v1:${String(sequence).padStart(64, "0")}`,
    reason: "Stage incompatible canonical state for C1 test",
  }).returning();
  if (!command) throw new Error("staged C1 command was not created");
  return command;
}

async function stageScheduledOccurrence(
  f: Fixture,
  candidate: FallDraftPreview["occurrenceCandidates"][number],
  startAt = candidate.startAt,
) {
  const command = await stageCommand(f, "generate");
  await db.insert(leagueOccurrences).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    locationId: f.locationId,
    generationKey: `staged-collision:${f.leagueId}:${++sequence}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: candidate.authoritativeLocalDate,
    authoritativeLocalStartTime: candidate.authoritativeLocalStartTime,
    timezone: candidate.timezone,
    startAt,
    selectedUtcOffsetMinutes: candidate.selectedUtcOffsetMinutes,
    foldResolution: candidate.foldResolution,
    resolverVersion: candidate.resolverVersion,
    plannedOrdinal: 99,
    competitionNumber: 99,
    competitive: true,
    countsInStandings: true,
    lastCommandId: command.id,
  });
}

async function caughtCode(callback: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await callback();
    return undefined;
  } catch (caught) {
    return caught && typeof caught === "object" && "code" in caught ? String(caught.code) : undefined;
  }
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
  for (const userId of systemAdminsToDelete.splice(0)) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
});

describe("C1 Fall draft preview", () => {
  it("is deterministic, zero-write, host-timezone independent, and treats double-pay as excluded evidence", async () => {
    const f = await fixture("preview");
    const beforeCanonical = await canonicalCounts(f);
    const beforeLeague = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    const first = await previewFallDraftGeneration({ ...scope(f), semantics });
    process.env.TZ = "Asia/Tokyo";
    const second = await previewFallDraftGeneration({ ...scope(f), semantics });
    process.env.TZ = originalTz;
    expect(second).toEqual(first);
    expect(first.previewFingerprint).toBe(second.previewFingerprint);
    expect(first.proposedSourceScheduleRevision).toEqual({ value: 1, reserved: false });
    expect(first.occurrenceCandidates.map((row) => [row.authoritativeLocalDate, row.status, row.lifecycleIntent])).toEqual([
      ["2032-08-01", "scheduled", "draft"],
      ["2032-08-15", "cancelled", "draft"],
      ["2032-08-22", "scheduled", "draft"],
    ]);
    expect(first.exceptionCandidates.map((row) => row.authoritativeLocalDate)).toEqual(["2032-08-08"]);
    expect(first.billingTermCandidates).toHaveLength(3);
    expect(first.legacyCollectionEvidence).toMatchObject({ doublePayDates: ["2032-08-22"], excludedFromCanonicalGeneration: true });
    expect(await canonicalCounts(f)).toEqual(beforeCanonical);
    expect(await db.select().from(leagues).where(eq(leagues.id, f.leagueId))).toEqual(beforeLeague);

    await db.update(leagues).set({ doublePayDates: ["2032-08-01"] }).where(eq(leagues.id, f.leagueId));
    const changedEvidence = await previewFallDraftGeneration({ ...scope(f), semantics });
    expect(changedEvidence.previewFingerprint).not.toBe(first.previewFingerprint);
    expect(changedEvidence.inputFingerprint).toBe(first.inputFingerprint);
    expect(changedEvidence.physicalScheduleFingerprint).toBe(first.physicalScheduleFingerprint);
    expect(changedEvidence.occurrenceCandidates).toEqual(first.occurrenceCandidates);
    expect(changedEvidence.billingTermCandidates).toEqual(first.billingTermCandidates);
  });

  it("changes semantic fingerprints without changing physical identity for financial policy changes", async () => {
    const f = await fixture("semantic-change");
    const usd = await previewFallDraftGeneration({ ...scope(f), semantics });
    const cad = await previewFallDraftGeneration({ ...scope(f), semantics: { ...semantics, currency: "CAD" } });
    expect(cad.previewFingerprint).not.toBe(usd.previewFingerprint);
    expect(cad.inputFingerprint).not.toBe(usd.inputFingerprint);
    expect(cad.physicalScheduleFingerprint).toBe(usd.physicalScheduleFingerprint);
    expect(cad.occurrenceCandidates.map((row) => row.generationKey)).toEqual(usd.occurrenceCandidates.map((row) => row.generationKey));
    expect(cad.billingTermCandidates.every((row) => row.currency === "CAD")).toBe(true);
  });

  it.each([
    ["July", "2032-07-04", "2032-07-25"],
    ["November", "2032-11-07", "2032-11-28"],
  ])("rejects a %s start", async (_label, seasonStart, seasonEnd) => {
    const f = await fixture(`reject-${seasonStart}`, { seasonStart, seasonEnd, skipDates: [], cancelledDates: [], doublePayDates: [] });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(f), semantics }))).toBe("ineligible_league");
  });

  it("rejects inactive, missing-location, cross-tenant-location, already-started, and partially elapsed leagues", async () => {
    const inactive = await fixture("inactive", { active: false });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(inactive), semantics }))).toBe("ineligible_league");

    const missing = await fixture("missing-location", { locationId: null });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(missing), semantics }))).toBe("invalid_location");

    const cross = await fixture("cross-location");
    const other = await fixture("cross-location-other");
    await db.update(leagues).set({ locationId: other.locationId }).where(eq(leagues.id, cross.leagueId));
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(cross), semantics }))).toBe("invalid_location");

    const elapsed = await fixture("elapsed", {
      seasonStart: "2025-08-03", seasonEnd: "2025-08-17", totalBowlingWeeks: 3, skipDates: [], cancelledDates: [], doublePayDates: [],
    });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(elapsed), semantics }))).toBe("not_wholly_future");

    const partial = await fixture("partial", {
      seasonStart: "2026-08-02", seasonEnd: "2026-08-30", totalBowlingWeeks: 5, skipDates: [], cancelledDates: [], doublePayDates: [],
    });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(partial), semantics }))).toBe("not_wholly_future");
  });

  it("rejects a past opening skip even when every occurrence candidate is still future-facing", async () => {
    const f = await fixture("past-opening-skip", {
      seasonStart: "2026-08-09",
      seasonEnd: "2026-08-30",
      weekDay: "Sunday",
      totalBowlingWeeks: 3,
      skipDates: ["2026-08-09"],
      cancelledDates: [],
      doublePayDates: [],
    });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(f), semantics }))).toBe("not_wholly_future");
    expect(Object.values(await canonicalCounts(f)).every((count) => count === 0)).toBe(true);
  });

  it("fails closed for DST gaps and requires explicit fold selection", async () => {
    const gap = await fixture("dst-gap", {
      seasonStart: "2032-10-03", seasonEnd: "2033-03-13", weekDay: "Sunday", competitionStartTime: "02:30",
      totalBowlingWeeks: 24, skipDates: [], cancelledDates: [], doublePayDates: [],
    });
    const gapPreview = await previewFallDraftGeneration({ ...scope(gap), semantics });
    expect(gapPreview.fatalErrors.some((row) => row.code === "invalid_dst_input")).toBe(true);
    expect(gapPreview.eligibility.eligibleForApply).toBe(false);

    const fold = await fixture("dst-fold", {
      seasonStart: "2032-10-03", seasonEnd: "2032-11-07", weekDay: "Sunday", competitionStartTime: "01:30",
      totalBowlingWeeks: 6, skipDates: [], cancelledDates: [], doublePayDates: [],
    });
    const rejected = await previewFallDraftGeneration({ ...scope(fold), semantics });
    expect(rejected.fatalErrors.some((row) => row.code === "invalid_dst_input")).toBe(true);
    const earlier = await previewFallDraftGeneration({ ...scope(fold), semantics: { ...semantics, ambiguousFold: "earlier" } });
    const later = await previewFallDraftGeneration({ ...scope(fold), semantics: { ...semantics, ambiguousFold: "later" } });
    const earlierFold = earlier.occurrenceCandidates.find((row) => row.foldResolution === "earlier");
    const laterFold = later.occurrenceCandidates.find((row) => row.foldResolution === "later");
    expect(earlierFold?.authoritativeLocalDate).toBe(laterFold?.authoritativeLocalDate);
    expect(earlierFold?.startAt).not.toBe(laterFold?.startAt);
  });
});

describe("C1 atomic draft creation", () => {
  it("creates truthful drafts and revisions atomically and returns exact durable IDs on retry", async () => {
    const f = await fixture("apply-retry");
    const preview = await previewFallDraftGeneration({ ...scope(f), semantics });
    const request = applyRequest(preview);
    const beforeLegacy = await db.select().from(leagues).where(eq(leagues.id, f.leagueId));
    const beforePayments = await db.select().from(payments).where(eq(payments.leagueId, f.leagueId));
    const first = await applyFallDraftGeneration({ ...scope(f), apply: request });
    expect(first.mode).toBe("applied");
    expect(first.writesPerformed).toBe(true);
    expect(first.legacyWritesPerformed).toBe(false);
    expect(first.relationshipsCreated).toBe(false);
    expect(first.paymentObligationOrCollectionRowsCreated).toBe(false);
    const retry = await applyFallDraftGeneration({ ...scope(f), apply: request });
    expect(retry.mode).toBe("idempotent_retry");
    expect(retry.writesPerformed).toBe(false);
    expect(retry.durableIds).toEqual(first.durableIds);
    expect(await db.select().from(leagues).where(eq(leagues.id, f.leagueId))).toEqual(beforeLegacy);
    expect(await db.select().from(payments).where(eq(payments.leagueId, f.leagueId))).toEqual(beforePayments);

    const commands = await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, f.leagueId));
    expect(commands.map((row) => row.commandType).sort()).toEqual(["cancel", "create_exception", "generate"]);
    expect(commands.some((row) => row.commandType === "approve_generation" || row.commandType === "publish")).toBe(false);
    const [run] = await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, f.leagueId));
    expect(run).toMatchObject({ state: "generated", approvedAt: null, rejectedAt: null, sourceScheduleRevision: 1 });
    const occurrences = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, f.leagueId)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    expect(occurrences.map((row) => ({
      status: row.status, lifecycle: row.lifecycle, planned: row.plannedOrdinal, competition: row.competitionNumber,
      competitive: row.competitive, standings: row.countsInStandings,
    }))).toEqual([
      { status: "scheduled", lifecycle: "draft", planned: 1, competition: 1, competitive: true, standings: true },
      { status: "cancelled", lifecycle: "draft", planned: 2, competition: null, competitive: false, standings: false },
      { status: "scheduled", lifecycle: "draft", planned: 3, competition: 3, competitive: true, standings: true },
    ]);
    const cancelled = occurrences[1];
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancelledByUserId).toBe(f.actorUserId);
    expect(cancelled.cancellationCommandId).toBe(commands.find((row) => row.commandType === "cancel")?.id);
    expect(cancelled.publishedAt).toBeNull();
    const terms = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId));
    expect(terms).toHaveLength(3);
    expect(terms.every((row) => row.state === "draft" && row.publicationCommandId === null)).toBe(true);
    expect(terms.find((row) => row.occurrenceId === cancelled.id)).toMatchObject({ obligationPolicy: "none", defaultAmountMinor: 0, billingOrdinal: null });
    const exceptions = await db.select().from(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.leagueId, f.leagueId));
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ lifecycle: "draft", generationRunId: run.id, publicationCommandId: null });
    expect(await db.select().from(leagueOccurrenceRelationships).where(eq(leagueOccurrenceRelationships.leagueId, f.leagueId))).toHaveLength(0);
    expect(await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.leagueId, f.leagueId))).toHaveLength(3);
    expect(await db.select().from(leagueOccurrenceBillingTermRevisions).where(eq(leagueOccurrenceBillingTermRevisions.leagueId, f.leagueId))).toHaveLength(3);
    expect(await db.select().from(leagueScheduleExceptionRevisions).where(eq(leagueScheduleExceptionRevisions.leagueId, f.leagueId))).toHaveLength(1);
  });

  it("detects schedule staleness, same-key changes, different-key adoption, and persisted-view staleness", async () => {
    const stale = await fixture("stale-apply");
    const stalePreview = await previewFallDraftGeneration({ ...scope(stale), semantics });
    await db.update(leagues).set({ weeklyFee: 2_100 }).where(eq(leagues.id, stale.leagueId));
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(stale), apply: applyRequest(stalePreview) }))).toBe("stale_preview");
    expect(Object.values(await canonicalCounts(stale)).every((count) => count === 0)).toBe(true);

    const conflict = await fixture("same-key-conflict");
    const preview = await previewFallDraftGeneration({ ...scope(conflict), semantics });
    const request = applyRequest(preview);
    await applyFallDraftGeneration({ ...scope(conflict), apply: request });
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(conflict), apply: { ...request, reason: "Changed semantic reason" } }))).toBe("idempotency_conflict");
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(conflict), apply: { ...request, idempotencyKey: "different-c1-key" } }))).toBe("stale_preview");
    expect((await loadFallDraftPersistedView(scope(conflict))).currentLegacyScheduleMatchesGenerationInput).toBe(true);
    expect(await loadFallDraftPersistedView(scope(conflict, conflict.systemAdminUserId))).toMatchObject({
      found: true,
      currentLegacyScheduleMatchesGenerationInput: true,
      result: { durableIds: { generationRunId: expect.any(String) } },
    });
    await db.update(leagues).set({ skipDates: [] }).where(eq(leagues.id, conflict.leagueId));
    expect((await loadFallDraftPersistedView(scope(conflict))).currentLegacyScheduleMatchesGenerationInput).toBe(false);
    await db.update(leagues).set({ locationId: null }).where(eq(leagues.id, conflict.leagueId));
    expect(await loadFallDraftPersistedView(scope(conflict, conflict.systemAdminUserId))).toMatchObject({
      found: true,
      currentLegacyScheduleMatchesGenerationInput: false,
    });

    const unassigned = await fixture("unassigned-status", { locationId: null });
    await expect(loadFallDraftPersistedView(scope(unassigned))).resolves.toEqual({
      found: false,
      result: null,
      currentLegacyScheduleMatchesGenerationInput: null,
    });
  });

  it("fails closed for exact-start, same-day, and exception collisions without a C1 write", async () => {
    const exact = await fixture("exact-start-collision");
    const exactCandidate = (await previewFallDraftGeneration({ ...scope(exact), semantics })).occurrenceCandidates[0];
    await stageScheduledOccurrence(exact, exactCandidate);
    const exactPreview = await previewFallDraftGeneration({ ...scope(exact), semantics });
    const exactBefore = await canonicalCounts(exact);
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(exact), apply: applyRequest(exactPreview) }))).toBe("canonical_collision");
    expect(await canonicalCounts(exact)).toEqual(exactBefore);

    const sameDay = await fixture("same-day-collision");
    const sameDayCandidate = (await previewFallDraftGeneration({ ...scope(sameDay), semantics })).occurrenceCandidates[0];
    const shiftedStart = new Date(Date.parse(sameDayCandidate.startAt) + 60 * 60 * 1_000).toISOString();
    await stageScheduledOccurrence(sameDay, sameDayCandidate, shiftedStart);
    const sameDayPreview = await previewFallDraftGeneration({ ...scope(sameDay), semantics });
    const sameDayBefore = await canonicalCounts(sameDay);
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(sameDay), apply: applyRequest(sameDayPreview) }))).toBe("canonical_collision");
    expect(await canonicalCounts(sameDay)).toEqual(sameDayBefore);

    const exception = await fixture("exception-collision");
    const command = await stageCommand(exception, "create_exception");
    await db.insert(leagueScheduleExceptions).values({
      organizationId: exception.organizationId,
      leagueId: exception.leagueId,
      kind: "skip",
      localDate: "2032-08-08",
      timezone: "America/New_York",
      source: "manual",
      lifecycle: "draft",
      reason: "Existing exception",
      lastCommandId: command.id,
    });
    const exceptionPreview = await previewFallDraftGeneration({ ...scope(exception), semantics });
    const exceptionBefore = await canonicalCounts(exception);
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(exception), apply: applyRequest(exceptionPreview) }))).toBe("exception_collision");
    expect(await canonicalCounts(exception)).toEqual(exceptionBefore);
  });

  it("rejects a partial persisted generation instead of adopting or repairing it", async () => {
    const f = await fixture("partial-state");
    const preview = await previewFallDraftGeneration({ ...scope(f), semantics });
    const request = applyRequest(preview);
    await applyFallDraftGeneration({ ...scope(f), apply: request });
    const [revision] = await db.select().from(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.leagueId, f.leagueId)).limit(1);
    if (!revision) throw new Error("C1 revision fixture was not created");
    await db.delete(leagueOccurrenceRevisions).where(eq(leagueOccurrenceRevisions.id, revision.id));
    const before = await canonicalCounts(f);
    expect(await caughtCode(() => applyFallDraftGeneration({ ...scope(f), apply: request }))).toBe("incompatible_canonical_state");
    expect(await canonicalCounts(f)).toEqual(before);
  });

  it("serializes identical and competing concurrent requests", async () => {
    const identical = await fixture("concurrent-identical");
    const preview = await previewFallDraftGeneration({ ...scope(identical), semantics });
    const request = applyRequest(preview);
    const results = await Promise.all([
      applyFallDraftGeneration({ ...scope(identical), apply: request }),
      applyFallDraftGeneration({ ...scope(identical), apply: request }),
    ]);
    expect(new Set(results.map((row) => row.mode))).toEqual(new Set(["applied", "idempotent_retry"]));
    expect(results[0].durableIds).toEqual(results[1].durableIds);

    const competing = await fixture("concurrent-competing");
    const competingPreview = await previewFallDraftGeneration({ ...scope(competing), semantics });
    const competingIdempotencyKey = ["competing", "c1", "key"].join("-");
    const outcomes = await Promise.allSettled([
      applyFallDraftGeneration({ ...scope(competing), apply: applyRequest(competingPreview) }),
      applyFallDraftGeneration({ ...scope(competing), apply: applyRequest(competingPreview, { idempotencyKey: competingIdempotencyKey }) }),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, competing.leagueId)))).toHaveLength(1);
  });

  it("allows same-tenant org_admin and explicit system_admin actors while denying normal and cross-tenant actors", async () => {
    const f = await fixture("authorization");
    const other = await fixture("authorization-other");
    await expect(previewFallDraftGeneration({ ...scope(f), semantics })).resolves.toMatchObject({ operatorScope: { organizationId: f.organizationId } });
    await expect(previewFallDraftGeneration({ ...scope(f, f.systemAdminUserId), semantics })).resolves.toMatchObject({ operatorScope: { organizationId: f.organizationId } });
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(f, f.regularUserId), semantics }))).toBe("unauthorized_actor");
    expect(await caughtCode(() => previewFallDraftGeneration({ ...scope(f, other.actorUserId), semantics }))).toBe("unauthorized_actor");
    expect(await caughtCode(() => previewFallDraftGeneration({ organizationId: other.organizationId, leagueId: f.leagueId, actorUserId: other.actorUserId, semantics }))).toBe("league_not_found");
  });

  it.each([
    "after_commands",
    "after_generation_run",
    "after_occurrences",
    "after_billing_terms",
    "after_exceptions",
    "after_revisions",
    "after_discrepancies",
  ] as const)("rolls back the complete C1 transaction after %s", async (failureInjection) => {
    const f = await fixture(`rollback-${failureInjection}`);
    const preview = await previewFallDraftGeneration({ ...scope(f), semantics });
    await expect(applyFallDraftGeneration({ ...scope(f), apply: applyRequest(preview), failureInjection })).rejects.toMatchObject({ code: "transaction_failure" });
    expect(Object.values(await canonicalCounts(f)).every((count) => count === 0)).toBe(true);
  });

  it("enforces only coherent cancelled-draft tuples while retaining prior lifecycle constraints", async () => {
    const f = await fixture("cancelled-constraint");
    const preview = await previewFallDraftGeneration({ ...scope(f), semantics });
    await applyFallDraftGeneration({ ...scope(f), apply: applyRequest(preview) });
    const [cancelled] = await db.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.leagueId, f.leagueId), eq(leagueOccurrences.status, "cancelled")));
    const [scheduled] = await db.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.leagueId, f.leagueId), eq(leagueOccurrences.status, "scheduled")));
    expect(cancelled).toBeDefined();
    await expect(db.update(leagueOccurrences).set({ plannedOrdinal: null }).where(eq(leagueOccurrences.id, cancelled.id))).rejects.toThrow();
    await expect(db.update(leagueOccurrences).set({ competitive: true }).where(eq(leagueOccurrences.id, cancelled.id))).rejects.toThrow();
    await expect(db.update(leagueOccurrences).set({ cancellationCommandId: null }).where(eq(leagueOccurrences.id, cancelled.id))).rejects.toThrow();
    await expect(db.update(leagueOccurrences).set({ lifecycle: "published" }).where(eq(leagueOccurrences.id, scheduled.id))).rejects.toThrow();
    const [stillCancelled] = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.id, cancelled.id));
    expect(stillCancelled).toMatchObject({ status: "cancelled", lifecycle: "draft", plannedOrdinal: 2, competitionNumber: null, competitive: false, countsInStandings: false });
  });
});
