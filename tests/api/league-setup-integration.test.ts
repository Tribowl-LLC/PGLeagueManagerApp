import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  teams,
  users,
} from "@shared/schema";
import type { AnyLeagueSetupIntegrationResult, LeagueRolloverSourceContract } from "@shared/league-setup-integration";
import type { CanonicalDraftMutationResult, CanonicalDraftReview } from "@shared/canonical-draft-review";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiGet,
  apiPatch,
  apiPost,
  login,
  type AuthSession,
} from "../helpers";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = "Setup-api-password-1!";
let organizationId: number;
let otherOrganizationId: number;
let locationId: number;
let admin: AuthSession;
let regular: AuthSession;
let systemAdmin: AuthSession;

function intent(value: number) {
  return {
    contractVersion: "league-setup-integration-request/2",
    idempotencyKey: `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
  };
}

function futureBody(key: number) {
  return {
    name: `API atomic Spring ${key}`,
    description: "setup API coverage",
    active: true,
    allowPublicSignup: true,
    seasonStart: "2032-03-07",
    weekDay: "Sunday",
    totalBowlingWeeks: 6,
    skipDates: ["2032-03-14"],
    cancelledDates: ["2032-03-28"],
    doublePayDates: ["2032-04-11"],
    competitionStartTime: "19:00",
    timezone: "America/New_York",
    weeklyFee: 2_000,
    paymentMode: "weekly",
    locationId,
    setupIntegration: intent(key),
  };
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Setup API ${suffix}`,
    slug: `setup-api-${suffix}`,
  }).returning();
  organizationId = organization.id;
  const [otherOrganization] = await db.insert(organizations).values({
    name: `Setup API other ${suffix}`,
    slug: `setup-api-other-${suffix}`,
  }).returning();
  otherOrganizationId = otherOrganization.id;
  const hashed = await hashPassword(password);
  const adminEmail = `setup-api-${suffix}@example.test`;
  const regularEmail = `setup-api-${suffix}-user@example.test`;
  await db.insert(users).values([
    { email: adminEmail, password: hashed, name: "Setup API admin", role: "org_admin", organizationId },
    { email: regularEmail, password: hashed, name: "Setup API user", role: "user", organizationId },
  ]);
  const [location] = await db.insert(locations).values({ name: "Setup API location", organizationId }).returning();
  locationId = location.id;
  admin = await login(adminEmail, password);
  regular = await login(regularEmail, password);
  systemAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
  if (otherOrganizationId) await deleteOrganization(otherOrganizationId).catch(() => undefined);
});

describe("league setup integration API", () => {
  it("creates non-Fall drafts atomically, returns durable IDs on retry, and exposes them to generic review", async () => {
    const body = futureBody(1);
    const created = await apiPost<AnyLeagueSetupIntegrationResult>("/api/leagues", body, admin);
    expect(created.status).toBe(201);
    expect(created.data.data).toMatchObject({
      setupIntegration: { mode: "created", writesPerformed: true },
      canonicalDraftGeneration: { mode: "applied", writesPerformed: true },
    });
    const result = created.data.data as AnyLeagueSetupIntegrationResult;
    const retry = await apiPost<AnyLeagueSetupIntegrationResult>("/api/leagues", body, admin);
    expect(retry.status).toBe(200);
    expect(retry.data.data).toMatchObject({ setupIntegration: { mode: "idempotent_retry", writesPerformed: false } });
    expect(retry.data.data?.canonicalDraftGeneration?.durableIds).toEqual(result.canonicalDraftGeneration?.durableIds);
    const changed = await apiPost("/api/leagues", { ...body, paymentMode: "upfront" }, admin);
    expect(changed.status).toBe(409);
    expect(changed.data.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const review = await apiGet<CanonicalDraftReview>(`/api/leagues/${result.id}/canonical-drafts/review`, admin);
    expect(review.status).toBe(200);
    expect(review.data.data).toMatchObject({ generationRun: { state: "generated" }, generation: { paymentMode: "weekly", seasonClassification: "Spring" } });
    const legacyAlias = await apiGet(`/api/leagues/${result.id}/canonical-fall-drafts/review`, admin);
    expect(legacyAlias.status).toBe(404);
    if (!review.data.data) throw new Error("generic review response missing");
    const published = await apiPost<CanonicalDraftMutationResult>(`/api/leagues/${result.id}/canonical-drafts/review/approve`, {
      contractVersion: "canonical-draft-approve-request/1",
      confirmedReviewFingerprint: review.data.data.reviewFingerprint,
      reason: "Approve E4 generic setup evidence",
      idempotencyKey: "e4-api-approve-1",
      discrepancyDispositions: review.data.data.discrepancies
        .filter((row) => row.resolutionState === "open")
        .map((row) => ({ discrepancyId: row.id, disposition: "waived" })),
    }, admin);
    expect(published.status).toBe(201);
    expect(published.data.data).toMatchObject({ review: { generationRun: { state: "applied" } } });
    const [publishedLeague] = await db.select().from(leagues).where(eq(leagues.id, result.id));
    if (!publishedLeague) throw new Error("published league row missing");
    const [publishedRun] = await db.select({ sourceScheduleRevision: leagueOccurrenceGenerationRuns.sourceScheduleRevision })
      .from(leagueOccurrenceGenerationRuns)
      .where(eq(leagueOccurrenceGenerationRuns.leagueId, result.id));
    const builderScheduleRevision = publishedLeague.canonicalScheduleRevision > 0
      ? publishedLeague.canonicalScheduleRevision
      : publishedRun?.sourceScheduleRevision ?? 1;
    const builderPatch = await apiPatch(`/api/leagues/${result.id}`, {
      name: "API builder-shaped metadata edit",
      description: "metadata survives canonical schedule mutation",
      active: publishedLeague.active,
      allowPublicSignup: publishedLeague.allowPublicSignup,
      seasonStart: publishedLeague.seasonStart,
      seasonEnd: publishedLeague.seasonEnd,
      weekDay: publishedLeague.weekDay,
      totalBowlingWeeks: publishedLeague.totalBowlingWeeks,
      skipDates: publishedLeague.skipDates,
      cancelledDates: publishedLeague.cancelledDates,
      doublePayDates: publishedLeague.doublePayDates,
      competitionStartTime: publishedLeague.competitionStartTime,
      timezone: publishedLeague.timezone,
      weeklyFee: publishedLeague.weeklyFee,
      paymentMode: publishedLeague.paymentMode,
      scheduleRevision: builderScheduleRevision,
      idempotencyKey: "e4-api-builder-shaped-edit-1",
    }, admin);
    expect(builderPatch.status).toBe(200);
    expect(builderPatch.data.data).toMatchObject({ id: result.id, name: "API builder-shaped metadata edit", description: "metadata survives canonical schedule mutation" });
    const [durableBuilderEdit] = await db.select().from(leagues).where(eq(leagues.id, result.id));
    expect(durableBuilderEdit).toMatchObject({
      name: "API builder-shaped metadata edit",
      description: "metadata survives canonical schedule mutation",
    });
    const unsupportedSkip = await apiPatch(`/api/leagues/${result.id}`, {
      skipDates: [...(durableBuilderEdit?.skipDates ?? []), "2032-03-21"],
      scheduleRevision: durableBuilderEdit?.canonicalScheduleRevision,
      idempotencyKey: "e4-api-unsupported-skip-1",
    }, admin);
    expect(unsupportedSkip.status).toBe(409);
    expect(unsupportedSkip.data.error?.code).toBe("CANONICAL_SCHEDULE_UNSUPPORTED_EDIT");
    const unsupportedScalar = await apiPatch(`/api/leagues/${result.id}`, {
      timezone: "UTC",
      scheduleRevision: durableBuilderEdit?.canonicalScheduleRevision,
      idempotencyKey: "e4-api-unsupported-scalar-1",
    }, admin);
    expect(unsupportedScalar.status).toBe(409);
    expect(unsupportedScalar.data.error?.code).toBe("CANONICAL_SCHEDULE_UNSUPPORTED_EDIT");
    const schedule = await apiGet(`/api/leagues/${result.id}/occurrence-schedule`, admin);
    expect(schedule.status).toBe(200);
    expect(schedule.data.data).toMatchObject({ authoritativeSource: "canonical", operationalCanonicalStateExists: true });
  });

  it("rejects ordinary users and forbidden canonical claims without creating a league", async () => {
    const before = await db.select().from(leagues).where(eq(leagues.organizationId, organizationId));
    const unauthorized = await apiPost("/api/leagues", futureBody(2), regular);
    expect(unauthorized.status).toBe(403);
    const forbidden = await apiPost("/api/leagues", { ...futureBody(3), currency: "CAD" }, admin);
    expect(forbidden.status).toBe(400);
    expect(forbidden.data.error?.code).toBe("VALIDATION_ERROR");
    const { allowPublicSignup: _omitted, ...missingExplicitTarget } = futureBody(30);
    const missingTarget = await apiPost("/api/leagues", missingExplicitTarget, admin);
    expect(missingTarget.status).toBe(400);
    const retiredSeasonEnd = await apiPost("/api/leagues", {
      ...futureBody(31),
      seasonEnd: "2032-12-01",
    }, admin);
    expect(retiredSeasonEnd.status).toBe(400);
    expect(await db.select().from(leagues).where(eq(leagues.organizationId, organizationId))).toHaveLength(before.length);
  });

  it("strictly rejects direct-v2 lineage, retired, and unknown fields with zero writes", async () => {
    const [sameTenantPrevious, crossTenantPrevious] = await db.insert(leagues).values([
      {
        name: "Same-tenant lineage source",
        organizationId,
        seasonStart: "2031-01-05",
        seasonEnd: "2031-01-19",
        weekDay: "Sunday",
        paymentMode: "weekly",
      },
      {
        name: "Cross-tenant lineage source",
        organizationId: otherOrganizationId,
        seasonStart: "2031-01-05",
        seasonEnd: "2031-01-19",
        weekDay: "Sunday",
        paymentMode: "weekly",
      },
    ]).returning();
    const counts = async () => ({
      leagues: (await db.select().from(leagues).where(eq(leagues.organizationId, organizationId))).length,
      commands: (await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, organizationId))).length,
      runs: (await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.organizationId, organizationId))).length,
      occurrences: (await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.organizationId, organizationId))).length,
    });
    const before = await counts();
    const attempts = [
      { ...futureBody(32), previousSeasonId: sameTenantPrevious.id },
      { ...futureBody(33), previousSeasonId: crossTenantPrevious.id },
      { ...futureBody(34), seasonNumber: 99 },
      { ...futureBody(35), finalTwoWeeksDueWeek: 4 },
      { ...futureBody(36), unsupportedSetupField: "not accepted" },
    ];
    for (const body of attempts) {
      const response = await apiPost("/api/leagues", body, admin);
      expect(response.status).toBe(400);
      expect(response.data.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(await counts()).toEqual(before);
  });

  it("requires and honors explicit system-administrator organization scope", async () => {
    const missingScope = await apiPost("/api/leagues", futureBody(6), systemAdmin);
    expect(missingScope.status).toBe(400);
    expect(missingScope.data.error?.code).toBe("ORG_REQUIRED");
    const created = await apiPost<AnyLeagueSetupIntegrationResult>("/api/leagues", {
      ...futureBody(7),
      organizationId,
    }, systemAdmin);
    expect(created.status).toBe(201);
    expect(created.data.data).toMatchObject({ organizationId, canonicalDraftGeneration: { mode: "applied" } });
  });

  it("atomically copies a new Fall season and serializes competing successor requests", async () => {
    const [source] = await db.insert(leagues).values({
      name: "API rollover source",
      organizationId,
      locationId,
      active: true,
      seasonStart: "2031-01-05",
      seasonEnd: "2031-03-23",
      weekDay: "Sunday",
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      totalBowlingWeeks: 12,
      weeklyFee: 2_000,
      paymentMode: "weekly",
    }).returning();
    const [team] = await db.insert(teams).values({ name: "API source team", number: 1, leagueId: source.id, displayOrder: 4 }).returning();
    const [bowler] = await db.insert(bowlers).values({ name: "API roster bowler", organizationId }).returning();
    await db.insert(bowlerLeagues).values({ bowlerId: bowler.id, leagueId: source.id, teamId: team.id, active: true, order: 6 });
    const values = {
      seasonStart: "2032-08-01",
      totalBowlingWeeks: 4,
      weekDay: "Sunday",
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
      allowPublicSignup: false,
      paymentMode: "upfront",
    };
    const confirmationResponse = await apiGet<LeagueRolloverSourceContract>(
      `/api/leagues/${source.id}/new-season/source-confirmation`,
      admin,
    );
    expect(confirmationResponse.status).toBe(200);
    expect(confirmationResponse.data.data).toMatchObject({
      organizationId,
      sourceLeagueId: source.id,
      carriedConfiguration: { name: source.name, locationId, weeklyFee: source.weeklyFee },
    });
    expect(JSON.stringify(confirmationResponse.data.data)).not.toMatch(/square|provider|payment|bowler/i);
    expect((await apiGet(`/api/leagues/${source.id}/new-season/source-confirmation`, regular)).status).toBe(403);
    expect((await apiGet(`/api/leagues/${source.id}/new-season/source-confirmation`, systemAdmin)).status).toBe(400);
    expect((await apiGet(
      `/api/leagues/${source.id}/new-season/source-confirmation?organizationId=${organizationId}`,
      systemAdmin,
    )).status).toBe(200);
    if (!confirmationResponse.data.data) throw new Error("source confirmation response missing");
    const sourceConfirmation = {
      contractVersion: confirmationResponse.data.data.contractVersion,
      fingerprint: confirmationResponse.data.data.fingerprint,
      confirmed: true,
    };
    const { allowPublicSignup: _omitted, ...missingExplicitTarget } = values;
    const missingTarget = await apiPost(`/api/leagues/${source.id}/new-season`, {
      ...missingExplicitTarget,
      setupIntegration: intent(40),
      sourceConfirmation,
    }, admin);
    expect(missingTarget.status).toBe(400);
    const retiredEnd = await apiPost(`/api/leagues/${source.id}/new-season`, {
      ...values,
      seasonEnd: "2032-12-01",
      setupIntegration: intent(41),
      sourceConfirmation,
    }, admin);
    expect(retiredEnd.status).toBe(400);
    const [first, second] = await Promise.all([
      apiPost<AnyLeagueSetupIntegrationResult>(`/api/leagues/${source.id}/new-season`, { ...values, setupIntegration: intent(4), sourceConfirmation }, admin),
      apiPost<AnyLeagueSetupIntegrationResult>(`/api/leagues/${source.id}/new-season`, { ...values, setupIntegration: intent(5), sourceConfirmation }, admin),
    ]);
    const attempts = [{ response: first, key: 4 }, { response: second, key: 5 }];
    const successfulAttempt = attempts.find(({ response }) => response.status === 201);
    const successful = successfulAttempt?.response;
    const rejected = [first, second].find((response) => response.status === 409);
    expect(successful?.data.data).toMatchObject({
      previousSeasonId: source.id,
      setupIntegration: { mode: "created" },
      canonicalDraftGeneration: { mode: "applied" },
    });
    expect(rejected?.data.error?.code).toMatch(/STALE_SOURCE_LEAGUE|SUCCESSOR_SEASON_EXISTS/);
    const target = successful?.data.data as AnyLeagueSetupIntegrationResult;
    expect((await db.select().from(leagues).where(eq(leagues.id, source.id)))[0]?.active).toBe(false);
    expect(await db.select().from(teams).where(eq(teams.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, target.id))).toHaveLength(4);
    const review = await apiGet<CanonicalDraftReview>(`/api/leagues/${target.id}/canonical-drafts/review`, admin);
    expect(review.status).toBe(200);
    if (!review.data.data || !successfulAttempt) throw new Error("successful rollover review is missing");
    const published = await apiPost<CanonicalDraftMutationResult>(`/api/leagues/${target.id}/canonical-drafts/review/approve`, {
      contractVersion: "canonical-draft-approve-request/1",
      confirmedReviewFingerprint: review.data.data.reviewFingerprint,
      reason: "Publish rollover before retry",
      idempotencyKey: "e4-rollover-publish-before-retry",
      discrepancyDispositions: review.data.data.discrepancies
        .filter((row) => row.resolutionState === "open")
        .map((row) => ({ discrepancyId: row.id, disposition: "waived" })),
    }, admin);
    expect(published.status).toBe(201);
    expect(published.data.data).toMatchObject({ review: { generationRun: { state: "applied" } } });

    await db.update(leagues).set({ description: "Archived source changed after commit" }).where(eq(leagues.id, source.id));
    await db.update(teams).set({ name: "Archived source team changed" }).where(eq(teams.id, team.id));
    const [lateBowler] = await db.insert(bowlers).values({ name: "Late archived-source bowler", organizationId }).returning();
    await db.insert(bowlerLeagues).values({ bowlerId: lateBowler.id, leagueId: source.id, teamId: team.id, active: false, order: 9 });
    const targetCounts = async () => ({
      commands: (await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, target.id))).length,
      runs: (await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, target.id))).length,
      occurrences: (await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, target.id))).length,
      teams: (await db.select().from(teams).where(eq(teams.leagueId, target.id))).length,
      roster: (await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.leagueId, target.id))).length,
    });
    const beforeRetry = await targetCounts();
    const retry = await apiPost<AnyLeagueSetupIntegrationResult>(`/api/leagues/${source.id}/new-season`, {
      ...values,
      setupIntegration: intent(successfulAttempt.key),
      sourceConfirmation,
    }, admin);
    expect(retry.status).toBe(200);
    expect(retry.data.data).toMatchObject({
      id: target.id,
      setupIntegration: { mode: "idempotent_retry", writesPerformed: false },
      canonicalDraftGeneration: { mode: "idempotent_retry", writesPerformed: false },
    });
    expect(retry.data.data?.canonicalDraftGeneration?.durableIds)
      .toEqual(target.canonicalDraftGeneration?.durableIds);
    expect(await targetCounts()).toEqual(beforeRetry);
  });
});
