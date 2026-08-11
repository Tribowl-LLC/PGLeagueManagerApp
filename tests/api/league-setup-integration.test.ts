import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagues,
  locations,
  organizations,
  teams,
  users,
} from "@shared/schema";
import type { LeagueSetupIntegrationResult } from "@shared/league-setup-integration";
import type { FallDraftReview } from "@shared/fall-draft-review";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiGet,
  apiPost,
  login,
  type AuthSession,
} from "../helpers";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = "Setup-api-password-1!";
let organizationId: number;
let locationId: number;
let admin: AuthSession;
let regular: AuthSession;
let systemAdmin: AuthSession;

function intent(value: number) {
  return {
    contractVersion: "league-setup-integration-request/1",
    idempotencyKey: `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
  };
}

function fallBody(key: number) {
  return {
    name: `API atomic Fall ${key}`,
    description: "setup API coverage",
    active: true,
    allowPublicSignup: true,
    seasonStart: "2032-10-03",
    weekDay: "Sunday",
    totalBowlingWeeks: 6,
    skipDates: ["2032-10-10"],
    cancelledDates: ["2032-10-24"],
    doublePayDates: ["2032-11-07"],
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
});

describe("league setup integration API", () => {
  it("creates Fall drafts atomically, returns durable IDs on retry, and exposes them to C2", async () => {
    const body = fallBody(1);
    const created = await apiPost<LeagueSetupIntegrationResult>("/api/leagues", body, admin);
    expect(created.status).toBe(201);
    expect(created.data.data).toMatchObject({
      setupIntegration: { mode: "created", writesPerformed: true },
      canonicalDraftGeneration: { mode: "applied", writesPerformed: true },
    });
    const result = created.data.data as LeagueSetupIntegrationResult;
    const retry = await apiPost<LeagueSetupIntegrationResult>("/api/leagues", body, admin);
    expect(retry.status).toBe(200);
    expect(retry.data.data).toMatchObject({ setupIntegration: { mode: "idempotent_retry", writesPerformed: false } });
    expect(retry.data.data?.canonicalDraftGeneration?.durableIds).toEqual(result.canonicalDraftGeneration?.durableIds);
    const changed = await apiPost("/api/leagues", { ...body, paymentMode: "upfront" }, admin);
    expect(changed.status).toBe(409);
    expect(changed.data.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const review = await apiGet<FallDraftReview>(`/api/leagues/${result.id}/canonical-fall-drafts/review`, admin);
    expect(review.status).toBe(200);
    expect(review.data.data).toMatchObject({ generationRun: { state: "generated" }, c1: { paymentMode: "weekly" } });
  });

  it("rejects ordinary users and forbidden canonical claims without creating a league", async () => {
    const before = await db.select().from(leagues).where(eq(leagues.organizationId, organizationId));
    const unauthorized = await apiPost("/api/leagues", fallBody(2), regular);
    expect(unauthorized.status).toBe(403);
    const forbidden = await apiPost("/api/leagues", { ...fallBody(3), currency: "CAD" }, admin);
    expect(forbidden.status).toBe(400);
    expect(forbidden.data.error?.code).toBe("VALIDATION_ERROR");
    expect(await db.select().from(leagues).where(eq(leagues.organizationId, organizationId))).toHaveLength(before.length);
  });

  it("requires and honors explicit system-administrator organization scope", async () => {
    const missingScope = await apiPost("/api/leagues", fallBody(6), systemAdmin);
    expect(missingScope.status).toBe(400);
    expect(missingScope.data.error?.code).toBe("ORG_REQUIRED");
    const created = await apiPost<LeagueSetupIntegrationResult>("/api/leagues", {
      ...fallBody(7),
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
    const [first, second] = await Promise.all([
      apiPost<LeagueSetupIntegrationResult>(`/api/leagues/${source.id}/new-season`, { ...values, setupIntegration: intent(4) }, admin),
      apiPost<LeagueSetupIntegrationResult>(`/api/leagues/${source.id}/new-season`, { ...values, setupIntegration: intent(5) }, admin),
    ]);
    const successful = [first, second].find((response) => response.status === 201);
    const rejected = [first, second].find((response) => response.status === 409);
    expect(successful?.data.data).toMatchObject({
      previousSeasonId: source.id,
      setupIntegration: { mode: "created" },
      canonicalDraftGeneration: { mode: "applied" },
    });
    expect(rejected?.data.error?.code).toMatch(/STALE_SOURCE_LEAGUE|SUCCESSOR_SEASON_EXISTS/);
    const target = successful?.data.data as LeagueSetupIntegrationResult;
    expect((await db.select().from(leagues).where(eq(leagues.id, source.id)))[0]?.active).toBe(false);
    expect(await db.select().from(teams).where(eq(teams.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, target.id))).toHaveLength(1);
    expect(await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, target.id))).toHaveLength(4);
  });
});
